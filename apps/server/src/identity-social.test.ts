import { describe, expect, it, vi } from "vitest";
import { createServer } from "./app";
import { NoopPersistence } from "./db";
import type {
  AccountSummary,
  FriendEntry,
  LinkAccountResult,
  PartyInviteAcceptance,
  PlayerIdentity,
  PublicPlayer,
  RegisteredPlayer,
  VerifiedExternalIdentity,
} from "./db";
import type { FirebaseIdentityVerifier } from "./identity/FirebaseIdentityVerifier";

const internalPlayerId = "00000000-0000-4000-8000-000000000001";
const identity: VerifiedExternalIdentity = {
  issuer: "https://securetoken.google.com/dotbot-test",
  subject: "firebase-user-1",
  provider: "email_link",
  authenticatedAt: Date.now(),
};

class IdentityTestPersistence extends NoopPersistence {
  override readonly live = true;
  linked = false;
  deleted = false;
  linkCalls: VerifiedExternalIdentity[] = [];

  override async registerPlayer(name: string): Promise<RegisteredPlayer> {
    return { playerId: internalPlayerId, publicPlayerId: "ABCDEFGH", name, token: "guest-token" };
  }

  override async helloPlayer(token: string): Promise<PlayerIdentity | null> {
    return token === "guest-token"
      ? { playerId: internalPlayerId, publicPlayerId: "ABCDEFGH", name: "Guest Pilot" }
      : null;
  }

  override async getAccount(token: string): Promise<AccountSummary | null> {
    if (token !== "guest-token") return null;
    return { publicPlayerId: "ABCDEFGH", displayName: "Guest Pilot", linked: this.linked, providers: this.linked ? ["email_link"] : [] };
  }

  override async linkAccount(token: string, verified: VerifiedExternalIdentity): Promise<LinkAccountResult> {
    if (token !== "guest-token") throw new Error("Unknown device token.");
    this.linkCalls.push(verified);
    const replayed = this.linked;
    this.linked = true;
    return {
      account: { publicPlayerId: "ABCDEFGH", displayName: "Guest Pilot", linked: true, providers: [verified.provider] },
      merged: false,
      replayed,
    };
  }

  override async createLinkedSession(verified: VerifiedExternalIdentity): Promise<RegisteredPlayer | null> {
    return verified.subject === identity.subject
      ? { playerId: internalPlayerId, publicPlayerId: "ABCDEFGH", name: "Guest Pilot", token: "second-device-token" }
      : null;
  }

  override async updateDisplayName(token: string, displayName: string): Promise<AccountSummary | null> {
    return token === "guest-token"
      ? { publicPlayerId: "ABCDEFGH", displayName, linked: this.linked, providers: this.linked ? ["email_link"] : [] }
      : null;
  }

  override async updatePrivacy(token: string): Promise<AccountSummary | null> {
    return token === "guest-token" && this.linked ? this.getAccount(token) : null;
  }

  override async findPublicPlayer(token: string, publicPlayerId: string): Promise<PublicPlayer | null> {
    return token === "guest-token" && this.linked && publicPlayerId.replace("-", "").toUpperCase() === "JKLMNPQR"
      ? { publicPlayerId: "JKLMNPQR", displayName: "Friend" }
      : null;
  }

  override async listFriends(token: string): Promise<FriendEntry[] | null> {
    return token === "guest-token" && this.linked
      ? [{ publicPlayerId: "JKLMNPQR", displayName: "Friend", status: "friends" }]
      : null;
  }

  override async requestFriend(token: string, publicPlayerId: string): Promise<FriendEntry | null> {
    const player = await this.findPublicPlayer(token, publicPlayerId);
    return player ? { ...player, status: "outgoing" } : null;
  }

  override async acceptFriend(token: string, publicPlayerId: string): Promise<FriendEntry | null> {
    const player = await this.findPublicPlayer(token, publicPlayerId);
    return player ? { ...player, status: "friends" } : null;
  }

  override async createPartyInvite(token: string): Promise<{ code: string; expiresAt: string } | null> {
    return token === "guest-token" && this.linked ? { code: "high-entropy-code", expiresAt: "2099-01-01T00:00:00.000Z" } : null;
  }

  override async acceptPartyInvite(token: string, code: string): Promise<PartyInviteAcceptance | null> {
    if (token !== "guest-token" || code !== "high-entropy-code") return null;
    return {
      inviter: { publicPlayerId: "JKLMNPQR", displayName: "Friend" },
      durable: this.linked,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  override async deleteLinkedAccount(token: string, verified: VerifiedExternalIdentity): Promise<boolean> {
    if (token !== "guest-token") return false;
    if (verified.subject !== identity.subject) throw new Error("Verified identity does not own this DotBot account.");
    this.deleted = true;
    return true;
  }
}

const verifier = (verified = identity): FirebaseIdentityVerifier => ({
  verifyIdToken: vi.fn(async () => verified),
});

describe("identity and social control-plane routes", () => {
  it("never serializes the internal UUID and replays the same provider link idempotently", async () => {
    const persistence = new IdentityTestPersistence();
    const providerVerifier: FirebaseIdentityVerifier = {
      verifyIdToken: vi.fn()
        .mockResolvedValueOnce(identity)
        .mockResolvedValueOnce({ ...identity, provider: "phone" }),
    };
    const { app } = await createServer({ persistence, firebaseIdentityVerifier: providerVerifier });

    const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Guest Pilot" } });
    expect(registered.json()).toMatchObject({ playerId: "ABCD-EFGH", publicPlayerId: "ABCD-EFGH", linked: false });
    expect(registered.body).not.toContain(internalPlayerId);

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/link",
      headers: { "x-device-token": "guest-token", authorization: "Bearer firebase-token" },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/link",
      headers: { "x-device-token": "guest-token", authorization: "Bearer firebase-token" },
    });
    expect(first.json()).toMatchObject({ account: { publicPlayerId: "ABCD-EFGH", linked: true }, replayed: false });
    expect(replay.json()).toMatchObject({ account: { publicPlayerId: "ABCD-EFGH", linked: true }, replayed: true });
    expect(`${first.body}${replay.body}`).not.toContain(internalPlayerId);
    expect(persistence.linkCalls).toEqual([identity, { ...identity, provider: "phone" }]);
    await app.close();
  });

  it("keeps provider verification injectable and rejects invalid or unavailable verification", async () => {
    const persistence = new IdentityTestPersistence();
    const invalid: FirebaseIdentityVerifier = { verifyIdToken: vi.fn(async () => { throw new Error("expired"); }) };
    const { app } = await createServer({ persistence, firebaseIdentityVerifier: invalid });
    expect((await app.inject({ method: "POST", url: "/api/auth/link", headers: { "x-device-token": "guest-token", authorization: "Bearer bad" } })).statusCode).toBe(401);
    await app.close();

    const unavailable = await createServer({ persistence: new IdentityTestPersistence(), firebaseIdentityVerifier: null });
    expect((await unavailable.app.inject({ method: "POST", url: "/api/auth/link", headers: { "x-device-token": "guest-token", authorization: "Bearer token" } })).statusCode).toBe(503);
    await unavailable.app.close();
  });

  it("requires linked ownership for durable friends while allowing a guest to accept an invite", async () => {
    const persistence = new IdentityTestPersistence();
    const { app } = await createServer({ persistence, firebaseIdentityVerifier: verifier() });
    expect((await app.inject({ method: "GET", url: "/api/social/friends", headers: { "x-device-token": "guest-token" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/social/party-invites", headers: { "x-device-token": "guest-token" } })).statusCode).toBe(403);

    const guestAcceptance = await app.inject({ method: "POST", url: "/api/social/party-invites/high-entropy-code/accept", headers: { "x-device-token": "guest-token" } });
    expect(guestAcceptance.json()).toMatchObject({ inviter: { publicPlayerId: "JKLM-NPQR", displayName: "Friend" }, durable: false });

    await persistence.linkAccount("guest-token", identity);
    const lookup = await app.inject({ method: "GET", url: "/api/social/players/jklm-npqr", headers: { "x-device-token": "guest-token" } });
    expect(lookup.json()).toEqual({ publicPlayerId: "JKLM-NPQR", displayName: "Friend" });
    expect(lookup.body).not.toContain(internalPlayerId);
    expect((await app.inject({ method: "POST", url: "/api/social/party-invites", headers: { "x-device-token": "guest-token" } })).statusCode).toBe(201);
    await app.close();
  });

  it("requires the verified external owner for deletion and does not treat mismatch as a merge", async () => {
    const persistence = new IdentityTestPersistence();
    persistence.linked = true;
    const mismatch = verifier({ ...identity, subject: "someone-else" });
    const first = await createServer({ persistence, firebaseIdentityVerifier: mismatch });
    expect((await first.app.inject({ method: "DELETE", url: "/api/account", headers: { "x-device-token": "guest-token", authorization: "Bearer other" } })).statusCode).toBe(409);
    expect(persistence.deleted).toBe(false);
    await first.app.close();

    const stale = await createServer({
      persistence,
      firebaseIdentityVerifier: verifier({ ...identity, authenticatedAt: Date.now() - 10 * 60_000 }),
    });
    expect((await stale.app.inject({ method: "DELETE", url: "/api/account", headers: { "x-device-token": "guest-token", authorization: "Bearer stale" } })).statusCode).toBe(401);
    expect(persistence.deleted).toBe(false);
    await stale.app.close();

    const second = await createServer({ persistence, firebaseIdentityVerifier: verifier() });
    expect((await second.app.inject({ method: "DELETE", url: "/api/account", headers: { "x-device-token": "guest-token", authorization: "Bearer owner" } })).statusCode).toBe(204);
    expect(persistence.deleted).toBe(true);
    await second.app.close();
  });

  it("fails durable identity and social writes explicitly in stateless mode", async () => {
    const { app } = await createServer({ databaseUrl: null, firebaseIdentityVerifier: verifier() });
    const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Offline" } });
    const token = registered.json<{ token: string }>().token;
    expect((await app.inject({ method: "GET", url: "/api/account", headers: { "x-device-token": token } })).statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/auth/link", headers: { "x-device-token": token, authorization: "Bearer firebase" } })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/social/friends", headers: { "x-device-token": token } })).statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/social/party-invites/code/accept", headers: { "x-device-token": token } })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/social/players/ABCD-EFGH", headers: { "x-device-token": token } })).statusCode).toBe(503);
    expect((await app.inject({ method: "DELETE", url: "/api/account", headers: { "x-device-token": token, authorization: "Bearer firebase" } })).statusCode).toBe(503);
    await app.close();
  });

  it("rejects malformed invite codes before hashing or persistence lookup", async () => {
    const persistence = new IdentityTestPersistence();
    const accept = vi.spyOn(persistence, "acceptPartyInvite");
    const { app } = await createServer({ persistence, firebaseIdentityVerifier: verifier() });
    const response = await app.inject({
      method: "POST",
      url: `/api/social/party-invites/${"x".repeat(15)}/accept`,
      headers: { "x-device-token": "guest-token" },
    });
    expect(response.statusCode).toBe(400);
    expect(accept).not.toHaveBeenCalled();
    await app.close();
  });

  it("rate-limits identity abuse before verification or persistence mutation", async () => {
    const persistence = new IdentityTestPersistence();
    const firebase = verifier();
    const { app } = await createServer({
      persistence,
      firebaseIdentityVerifier: firebase,
      identityRateLimiter: { consume: () => ({ allowed: false, retryAfterSeconds: 17 }) },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/link",
      headers: { "x-device-token": "guest-token", authorization: "Bearer firebase-token" },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(firebase.verifyIdToken).not.toHaveBeenCalled();
    expect(persistence.linkCalls).toEqual([]);
    await app.close();
  });

  it("never reflects persistence details from identity conflicts", async () => {
    class LeakyPersistence extends IdentityTestPersistence {
      override async linkAccount(): Promise<LinkAccountResult> {
        throw new Error(`${internalPlayerId} firebase-user-1 guest-token unique constraint`);
      }
    }
    const { app } = await createServer({ persistence: new LeakyPersistence(), firebaseIdentityVerifier: verifier() });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/link",
      headers: { "x-device-token": "guest-token", authorization: "Bearer firebase-token" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain(internalPlayerId);
    expect(response.body).not.toContain("firebase-user-1");
    expect(response.body).not.toContain("guest-token");
    expect(response.body).not.toContain("constraint");
    await app.close();
  });

  it("redacts unexpected persistence errors across public identity and social routes", async () => {
    class LeakyPersistence extends IdentityTestPersistence {
      private leak(): never {
        throw new Error(`${internalPlayerId} firebase-user-1 guest-token secret-constraint`);
      }
      override async registerPlayer(): Promise<RegisteredPlayer> { return this.leak(); }
      override async requestFriend(): Promise<FriendEntry | null> { return this.leak(); }
    }
    const persistence = new LeakyPersistence();
    persistence.linked = true;
    const { app } = await createServer({ persistence, firebaseIdentityVerifier: verifier() });
    for (const response of [
      await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Leak test" } }),
      await app.inject({
        method: "POST",
        url: "/api/social/friend-requests",
        headers: { "x-device-token": "guest-token" },
        payload: { publicPlayerId: "JKLM-NPQR" },
      }),
    ]) {
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(internalPlayerId);
      expect(response.body).not.toContain("firebase-user-1");
      expect(response.body).not.toContain("guest-token");
      expect(response.body).not.toContain("constraint");
    }
    await app.close();
  });
});
