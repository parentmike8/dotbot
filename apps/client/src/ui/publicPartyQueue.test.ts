import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPublicPartyAllocation,
  getPublicPartyAllocationStatus,
  PublicPartyQueueError,
  requestPublicPartyAllocation,
  shouldRetryPublicPartyClaim,
} from "./publicPartyQueue";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public party queue API", () => {
  it("retries only uncertain failures or errors explicitly marked retryable", () => {
    expect(shouldRetryPublicPartyClaim(new Error("network response lost"))).toBe(true);
    expect(shouldRetryPublicPartyClaim(new PublicPartyQueueError("leader required", 409, true))).toBe(true);
    expect(shouldRetryPublicPartyClaim(new PublicPartyQueueError("unauthorized", 401, false))).toBe(false);
    expect(shouldRetryPublicPartyClaim(new PublicPartyQueueError("stale claim", 409, false))).toBe(false);
  });

  it("uses one idempotency key and receives only this member's connection", async () => {
    const queueRequestId = "00000000-0000-4000-8000-000000000501";
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://matchmaker.example/prod/quick-play");
      expect(JSON.parse(String(init?.body))).toEqual({
        token: "device-token",
        queueRequestId,
        buildId: "web-42",
        latencies: { "ca-central-1": 41 },
      });
      return new Response(JSON.stringify({
        mode: "public-hot-arena",
        arenaId: "A2BC",
        playerSessionId: "player-session-self",
        websocketUrl: "wss://compute.example:7001/ws",
        expiresAt: "2099-01-01T00:00:00.000Z",
        queueTicket: queueRequestId,
        partySize: 3,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);
    await expect(requestPublicPartyAllocation({
      matchmakerUrl: "https://matchmaker.example/prod/",
      token: "device-token",
      queueRequestId,
      buildId: "web-42",
      latencies: { "ca-central-1": 41 },
    })).resolves.toMatchObject({
      queueRequestId,
      allocation: { playerSessionId: "player-session-self", queueTicket: queueRequestId, partySize: 3 },
    });
  });

  it("fails closed on partial allocation and preserves retryability", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "public-hot-arena", arenaId: "A2BC", playerSessionId: "only-one-field",
    }), { status: 200 })));
    const error = await requestPublicPartyAllocation({
      matchmakerUrl: "https://matchmaker.example/prod",
      token: "device-token",
      queueRequestId: "00000000-0000-4000-8000-000000000502",
      buildId: "web-42",
      latencies: { "ca-central-1": 41 },
    }).catch((reason) => reason as PublicPartyQueueError);
    expect(error).toMatchObject({ status: 502, retryable: true });
  });

  it("rejects a malformed or insecure per-member connection", async () => {
    for (const websocketUrl of [
      "ws://compute.example/ws",
      "wss://operator:secret@compute.example/ws?token=secret#fragment",
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        mode: "public-hot-arena",
        arenaId: "A2BC",
        playerSessionId: "player-session-self",
        websocketUrl,
        expiresAt: "2099-01-01T00:00:00.000Z",
        queueTicket: "00000000-0000-4000-8000-000000000503",
        partySize: 2,
      }), { status: 200 })));
      await expect(requestPublicPartyAllocation({
        matchmakerUrl: "https://matchmaker.example/prod",
        token: "device-token",
        queueRequestId: "00000000-0000-4000-8000-000000000503",
        buildId: "web-42",
        latencies: { "ca-central-1": 41 },
      })).rejects.toMatchObject({ status: 502, retryable: true });
    }
  });

  it("rejects an expired never-admitted allocation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "public-hot-arena",
      arenaId: "A2BC",
      playerSessionId: "player-session-expired",
      websocketUrl: "wss://compute.example/ws",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      queueTicket: "00000000-0000-4000-8000-000000000506",
      partySize: 1,
    }), { status: 200 })));

    await expect(requestPublicPartyAllocation({
      matchmakerUrl: "https://matchmaker.example/prod",
      token: "device-token",
      queueRequestId: "00000000-0000-4000-8000-000000000506",
      buildId: "web-42",
      latencies: { "ca-central-1": 41 },
    })).rejects.toMatchObject({ status: 502, retryable: true });
  });

  it("rejects an otherwise complete allocation without a bounded admission deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "public-hot-arena",
      arenaId: "A2BC",
      playerSessionId: "player-session-unbounded",
      websocketUrl: "wss://compute.example/ws",
      queueTicket: "00000000-0000-4000-8000-000000000508",
      partySize: 1,
    }), { status: 200 })));

    await expect(requestPublicPartyAllocation({
      matchmakerUrl: "https://matchmaker.example/prod",
      token: "device-token",
      queueRequestId: "00000000-0000-4000-8000-000000000508",
      buildId: "web-42",
      latencies: { "ca-central-1": 41 },
    })).rejects.toMatchObject({ status: 502, retryable: true });
  });

  it("cancels by opaque queue ticket and surfaces incomplete reconciliation", async () => {
    const controller = new AbortController();
    const responses = [
      new Response(JSON.stringify({ error: "reconciling", retryable: true }), { status: 503 }),
      new Response(JSON.stringify({ cancelled: true }), { status: 200 }),
    ];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://matchmaker.example/prod/quick-play/cancel");
      expect(init?.body).toBe(JSON.stringify({ token: "device-token", queueTicket: "opaque-ticket" }));
      expect(init?.signal).toBe(controller.signal);
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", request);
    await expect(cancelPublicPartyAllocation({ matchmakerUrl: "https://matchmaker.example/prod", token: "device-token", queueTicket: "opaque-ticket", signal: controller.signal }))
      .rejects.toMatchObject({ status: 503, retryable: true });
    await expect(cancelPublicPartyAllocation({ matchmakerUrl: "https://matchmaker.example/prod", token: "device-token", queueTicket: "opaque-ticket", signal: controller.signal }))
      .resolves.toBeUndefined();
  });

  it("recovers an uncertain response without exposing another party member's allocation", async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://matchmaker.example/prod/quick-play/status");
      expect(JSON.parse(String(init?.body))).toEqual({
        token: "device-token",
        queueTicket: "00000000-0000-4000-8000-000000000504",
      });
      return new Response(JSON.stringify({
        status: "active",
        queueTicket: "00000000-0000-4000-8000-000000000504",
        allocation: {
          mode: "public-hot-arena",
          arenaId: "A2BC",
          playerSessionId: "player-session-self",
          websocketUrl: "wss://compute.example:7001/ws",
          expiresAt: "2099-01-01T00:00:00.000Z",
          queueTicket: "00000000-0000-4000-8000-000000000504",
          partySize: 3,
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);
    await expect(getPublicPartyAllocationStatus({
      matchmakerUrl: "https://matchmaker.example/prod",
      token: "device-token",
      queueTicket: "00000000-0000-4000-8000-000000000504",
    })).resolves.toMatchObject({
      status: "active",
      allocation: { playerSessionId: "player-session-self" },
    });
  });

  it("accepts this member's unexpired completed-claim allocation for response-lost reconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      queueTicket: "00000000-0000-4000-8000-000000000505",
      allocation: {
        mode: "public-hot-arena",
        arenaId: "A2BC",
        playerSessionId: "player-session-self",
        websocketUrl: "wss://compute.example:7001/ws",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        queueTicket: "00000000-0000-4000-8000-000000000505",
        partySize: 3,
      },
    }), { status: 200 })));
    await expect(getPublicPartyAllocationStatus({
      matchmakerUrl: "https://matchmaker.example/prod",
      token: "device-token",
      queueTicket: "00000000-0000-4000-8000-000000000505",
    })).resolves.toMatchObject({
      status: "completed",
      allocation: { playerSessionId: "player-session-self" },
    });
  });

  it("does not treat a completed claim as proof of admission for an expired reservation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      queueTicket: "00000000-0000-4000-8000-000000000507",
      allocation: {
        mode: "public-hot-arena",
        arenaId: "A2BC",
        playerSessionId: "player-session-expired",
        websocketUrl: "wss://compute.example:7001/ws",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        queueTicket: "00000000-0000-4000-8000-000000000507",
        partySize: 1,
      },
    }), { status: 200 })));

    await expect(getPublicPartyAllocationStatus({
      matchmakerUrl: "https://matchmaker.example/prod",
      token: "device-token",
      queueTicket: "00000000-0000-4000-8000-000000000507",
    })).rejects.toMatchObject({ status: 502, retryable: true });
  });
});
