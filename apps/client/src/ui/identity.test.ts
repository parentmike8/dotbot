import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptPartyInvite,
  createDurablePartyInvite,
  deviceTokenKey,
  disbandDurableParty,
  ensureAccountToken,
  fetchPartyState,
  fetchAccountState,
  createLinkedDeviceSession,
  linkGuestAccount,
  leaveDurableParty,
  partyInviteCodeFromHash,
  playerNameKey,
  resetIdentityTestState,
  revokeDurablePartyInvites,
  transferDurablePartyLeader,
  updateDisplayName,
} from "./identity";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("identity bootstrap", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    resetIdentityTestState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("coalesces concurrent registration and keeps the server-issued guest token", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ token: "a".repeat(32) }), { status: 200 }));
    vi.stubGlobal("fetch", request);

    const [first, second] = await Promise.all([ensureAccountToken("Ada"), ensureAccountToken("Ada")]);

    expect(first).toBe("a".repeat(32));
    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();
    expect(localStorage.getItem(deviceTokenKey)).toBe(first);
  });

  it("registers once after an authoritative 404 but preserves a token on transient failure", async () => {
    localStorage.setItem(deviceTokenKey, "b".repeat(32));
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "c".repeat(32) }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    expect(await ensureAccountToken("Pilot")).toBe("c".repeat(32));
    expect(request).toHaveBeenCalledTimes(2);

    resetIdentityTestState();
    request.mockReset();
    request.mockResolvedValue(new Response("{}", { status: 503 }));
    expect(await ensureAccountToken("Pilot")).toBe("c".repeat(32));
    expect(request).toHaveBeenCalledOnce();
  });

  it("reports stateless storage separately from guest link state", async () => {
    localStorage.setItem(deviceTokenKey, "d".repeat(32));
    localStorage.setItem(playerNameKey, "Offline Pilot");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));

    expect(await fetchAccountState()).toEqual({
      publicPlayerId: null,
      displayName: "Offline Pilot",
      linked: false,
      providers: [],
      storageAvailable: false,
    });
  });

  it("passes a Firebase token only to the link request and never stores it", async () => {
    localStorage.setItem(deviceTokenKey, "e".repeat(32));
    const firebaseToken = "signed.firebase.token";
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "x-device-token": "e".repeat(32),
        authorization: `Bearer ${firebaseToken}`,
      });
      return new Response(JSON.stringify({
        account: { publicPlayerId: "ABCD-EFGH", displayName: "Linked Pilot", linked: true, providers: ["email_link"] },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);

    expect(await linkGuestAccount(firebaseToken)).toMatchObject({ linked: true, storageAvailable: true });
    expect([...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))].map((key) => localStorage.getItem(key!)))
      .not.toContain(firebaseToken);
  });

  it("merges a valid guest before login instead of replacing its device token", async () => {
    localStorage.setItem(deviceTokenKey, "f".repeat(32));
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicPlayerId: "ABCD-EFGH" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        account: { publicPlayerId: "WXYZ-2345", displayName: "Canonical", linked: true, providers: ["phone"] },
      }), { status: 200 }));
    vi.stubGlobal("fetch", request);

    expect(await createLinkedDeviceSession("firebase-token")).toMatchObject({ linked: true, publicPlayerId: "WXYZ-2345" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe("/api/auth/hello");
    expect(request.mock.calls[1][0]).toBe("/api/auth/link");
    expect(request.mock.calls.some(([url]) => url === "/api/auth/session")).toBe(false);
    expect(localStorage.getItem(deviceTokenKey)).toBe("f".repeat(32));
  });

  it("changes the authoritative non-unique display name and parses invite links", async () => {
    localStorage.setItem(deviceTokenKey, "1".repeat(32));
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PATCH");
      expect(init?.body).toBe(JSON.stringify({ displayName: "New Pilot" }));
      return new Response(JSON.stringify({
        publicPlayerId: "ABCD-EFGH",
        displayName: "New Pilot",
        linked: false,
        providers: [],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);
    expect(await updateDisplayName("  New   Pilot  ")).toMatchObject({ displayName: "New Pilot", linked: false });
    expect(localStorage.getItem(playerNameKey)).toBe("New Pilot");
    expect(partyInviteCodeFromHash("#/party/abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(partyInviteCodeFromHash("#/party/short")).toBeNull();
  });

  it("submits a party invite bearer in the body rather than a logged URL path", async () => {
    localStorage.setItem(deviceTokenKey, "2".repeat(32));
    const code = "inviteBearerCode1234567890";
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/social/party-invites/accept");
      expect(String(input)).not.toContain(code);
      expect(init?.body).toBe(JSON.stringify({ code }));
      return new Response(JSON.stringify({
        inviter: { publicPlayerId: "ABCD-EFGH", displayName: "Inviter" },
        durable: false,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);

    await expect(acceptPartyInvite(code)).resolves.toMatchObject({ durable: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it("exposes durable party state and versioned mutations without internal identity fields", async () => {
    localStorage.setItem(deviceTokenKey, "3".repeat(32));
    const party = {
      version: 4,
      members: [{ publicPlayerId: "ABCD-EFGH", displayName: "Leader", leader: true }],
      canInvite: true,
    };
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({ "x-device-token": "3".repeat(32) });
      if (url === "/api/social/party" && init?.method === "GET") return new Response(JSON.stringify({ party }), { status: 200 });
      if (url === "/api/social/party-invites" && init?.method === "POST") {
        return new Response(JSON.stringify({ code: "durable-code", expiresAt: "2099-01-01T00:00:00.000Z", party }), { status: 201 });
      }
      if (url === "/api/social/party-invites" && init?.method === "DELETE") return new Response(JSON.stringify({ party }), { status: 200 });
      if (url === "/api/social/party/leader") {
        expect(init?.body).toBe(JSON.stringify({ version: 4, publicPlayerId: "JKLM-NPQR" }));
        return new Response(JSON.stringify({ party }), { status: 200 });
      }
      if (url === "/api/social/party/disband" || url === "/api/social/party/leave") {
        expect(init?.body).toBe(JSON.stringify({ version: 4 }));
        return new Response(JSON.stringify({ party: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });
    vi.stubGlobal("fetch", request);

    expect(await fetchPartyState()).toEqual(party);
    expect(await createDurablePartyInvite()).toMatchObject({ code: "durable-code", party });
    expect(await revokeDurablePartyInvites()).toEqual(party);
    expect(await transferDurablePartyLeader(4, "JKLM-NPQR")).toEqual(party);
    await expect(disbandDurableParty(4)).resolves.toBeNull();
    await expect(leaveDurableParty(4)).resolves.toBeNull();
  });
});
