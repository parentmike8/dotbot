import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelPublicPartyAllocation, PublicPartyQueueError, requestPublicPartyAllocation } from "./publicPartyQueue";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public party queue API", () => {
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "public-hot-arena",
      arenaId: "A2BC",
      playerSessionId: "player-session-self",
      websocketUrl: "ws://compute.example/ws",
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
  });

  it("cancels by opaque queue ticket and surfaces incomplete reconciliation", async () => {
    const responses = [
      new Response(JSON.stringify({ error: "reconciling", retryable: true }), { status: 503 }),
      new Response(JSON.stringify({ cancelled: true }), { status: 200 }),
    ];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://matchmaker.example/prod/quick-play/cancel");
      expect(init?.body).toBe(JSON.stringify({ token: "device-token", queueTicket: "opaque-ticket" }));
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", request);
    await expect(cancelPublicPartyAllocation({ matchmakerUrl: "https://matchmaker.example/prod", token: "device-token", queueTicket: "opaque-ticket" }))
      .rejects.toMatchObject({ status: 503, retryable: true });
    await expect(cancelPublicPartyAllocation({ matchmakerUrl: "https://matchmaker.example/prod", token: "device-token", queueTicket: "opaque-ticket" }))
      .resolves.toBeUndefined();
  });
});
