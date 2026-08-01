import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalTrustedPartyRoster, type TrustedPartyRoster } from "@dotbot/protocol";
import { createServer, releasePartyReservations } from "./app";
import { NoopPersistence, PartyConflictError, type PartyQueueClaim, type PartySummary } from "./db";
import type { GameLiftSessionGate } from "./GameLiftSessionGate";

const leaderId = "00000000-0000-4000-8000-000000000101";
const memberId = "00000000-0000-4000-8000-000000000102";
const claimId = "00000000-0000-4000-8000-000000000103";
const secret = "party-api-test-secret";

class DurableApiPersistence extends NoopPersistence {
  override readonly live = true;
  readonly relayClaims = new Set<string>();
  full = false;
  party: PartySummary = {
    version: 7,
    members: [
      { publicPlayerId: "ABCDEFGH", displayName: "Leader", leader: true },
      { publicPlayerId: "JKLMNPQR", displayName: "Member", leader: false },
    ],
    canInvite: true,
  };

  override async getParty(): Promise<PartySummary> { return this.party; }
  override async createPartyInvite() { return { code: "legacy-invite-code", expiresAt: "2099-01-01T00:00:00.000Z" }; }
  override async createDurablePartyInvite() {
    if (this.full) throw new PartyConflictError("party_full", "sensitive internal party state");
    return { code: "durable-invite-code", expiresAt: "2099-01-01T00:00:00.000Z", party: this.party };
  }
  override async claimRelayRequest(requestId: string): Promise<boolean> {
    if (this.relayClaims.has(requestId)) return false;
    this.relayClaims.add(requestId);
    return true;
  }
  override async claimPartyQueue(_token: string, input: { requestId: string; buildId: string; region: string }): Promise<PartyQueueClaim> {
    return {
      claimId: input.requestId,
      partyId: `party-${"a".repeat(32)}`,
      version: 7,
      leaderPlayerId: leaderId,
      requestingPlayerId: leaderId,
      buildId: input.buildId,
      region: input.region,
      status: "active",
      members: [
        { playerId: leaderId, name: "Leader", loadoutRevision: 4 },
        { playerId: memberId, name: "Member", loadoutRevision: 9 },
      ],
    };
  }
  override async getPartyQueueStatus(_token: string, requestedClaimId: string): Promise<PartyQueueClaim | null> {
    return requestedClaimId === claimId
      ? this.claimPartyQueue(_token, { requestId: requestedClaimId, buildId: "web-42", region: "ca-central-1" })
      : null;
  }
}

afterEach(() => {
  delete process.env.DOTBOT_RELAY_SECRET;
});

describe("durable party APIs", () => {
  it("keeps public deployment client config default-off and exposes only an explicitly complete launch spine", async () => {
    const { app: legacy } = await createServer({
      persistence: new DurableApiPersistence(),
      matchmakerUrl: null,
      quickPlayBuildId: null,
      quickPlayRegions: [],
    });
    expect((await legacy.inject({ method: "GET", url: "/api/game-config" })).json()).toEqual({
      matchmakerUrl: null,
      publicQuickPlayEnabled: false,
      durablePartiesEnabled: false,
      atomicPartyAllocationEnabled: false,
      quickPlayBuildId: null,
      quickPlayRegions: [],
    });
    await legacy.close();

    const { app: publicApp } = await createServer({
      persistence: new DurableApiPersistence(),
      publicQuickPlay: true,
      durableParties: true,
      atomicPartyAllocation: true,
      matchmakerUrl: "https://match.example.test/public",
      quickPlayBuildId: "web-42",
      quickPlayRegions: ["ca-central-1", "ca-central-1", "invalid region"],
    });
    expect((await publicApp.inject({ method: "GET", url: "/api/game-config" })).json()).toEqual({
      matchmakerUrl: "https://match.example.test/public",
      publicQuickPlayEnabled: true,
      durablePartiesEnabled: true,
      atomicPartyAllocationEnabled: true,
      quickPlayBuildId: "web-42",
      quickPlayRegions: ["ca-central-1"],
    });
    await publicApp.close();
  });

  it("preserves legacy behavior and hides every new route while the durable gate is off", async () => {
    const persistence = new DurableApiPersistence();
    const legacy = vi.spyOn(persistence, "createPartyInvite");
    const durable = vi.spyOn(persistence, "createDurablePartyInvite");
    const { app } = await createServer({ persistence, durableParties: false });
    const invite = await app.inject({ method: "POST", url: "/api/social/party-invites", headers: { "x-device-token": "device-token" } });
    expect(invite.statusCode).toBe(201);
    expect(legacy).toHaveBeenCalledOnce();
    expect(durable).not.toHaveBeenCalled();
    for (const route of [
      { method: "GET", url: "/api/social/party" },
      { method: "DELETE", url: "/api/social/party-invites" },
      { method: "POST", url: "/api/social/party/leave" },
      { method: "POST", url: "/api/social/party/disband" },
      { method: "POST", url: "/api/social/party/leader" },
    ] as const) {
      expect((await app.inject({ ...route, headers: { "x-device-token": "device-token" }, payload: {} })).statusCode).toBe(404);
    }
    await app.close();
  });

  it("serializes only public IDs and removes the invite action at three", async () => {
    const persistence = new DurableApiPersistence();
    persistence.party = {
      version: 8,
      members: [
        ...persistence.party.members,
        { publicPlayerId: "RSTUVWXY", displayName: "Third", leader: false },
      ],
      canInvite: false,
    };
    persistence.full = true;
    const { app } = await createServer({ persistence, durableParties: true });
    const party = await app.inject({ method: "GET", url: "/api/social/party", headers: { "x-device-token": "device-token" } });
    expect(party.json()).toEqual({
      party: {
        version: 8,
        members: [
          { publicPlayerId: "ABCD-EFGH", displayName: "Leader", leader: true },
          { publicPlayerId: "JKLM-NPQR", displayName: "Member", leader: false },
          { publicPlayerId: "RSTU-VWXY", displayName: "Third", leader: false },
        ],
        canInvite: false,
      },
    });
    for (const privateValue of [leaderId, memberId, `party-${"a".repeat(32)}`, claimId, "device-token"]) {
      expect(party.body).not.toContain(privateValue);
    }
    const invite = await app.inject({ method: "POST", url: "/api/social/party-invites", headers: { "x-device-token": "device-token" } });
    expect(invite.statusCode).toBe(409);
    expect(invite.json()).toEqual({ error: "That party already has three members.", code: "party_full" });
    expect(invite.body).not.toContain("sensitive internal party state");
    expect((await app.inject({
      method: "POST", url: "/api/social/party/leave", headers: { "x-device-token": "device-token" }, payload: {},
    })).statusCode).toBe(400);
    expect(app.printRoutes()).not.toContain(":party");
    await app.close();
  });

  it("returns a short-lived canonical roster only across the operation-separated signed boundary", async () => {
    process.env.DOTBOT_RELAY_SECRET = secret;
    const persistence = new DurableApiPersistence();
    const { app } = await createServer({ persistence, publicQuickPlay: true, durableParties: true, atomicPartyAllocation: true });
    const body = JSON.stringify({
      token: "device-token-with-enough-entropy",
      partyAllocationVersion: "party-v1",
      operation: "allocate",
      queueRequestId: claimId,
      buildId: "web-42",
      region: "ca-central-1",
    });
    const requestId = randomUUID();
    const timestamp = Date.now().toString();
    const signed = signedHeaders("matchmaker-auth", body, timestamp, requestId);
    const response = await app.inject({
      method: "POST", url: "/api/internal/matchmaker-auth", headers: { "content-type": "application/json", ...signed }, payload: JSON.parse(body),
    });
    expect(response.statusCode).toBe(200);
    const result = response.json<{ partyRoster: TrustedPartyRoster; rosterSignature: string }>();
    expect(result.partyRoster).toMatchObject({ claimId, version: 7, requestingPlayerId: leaderId, buildId: "web-42", region: "ca-central-1" });
    expect(result.partyRoster.expiresAt - result.partyRoster.issuedAt).toBe(30_000);
    expect(result.rosterSignature).toBe(createHmac("sha256", secret)
      .update(`party-roster.${requestId}.${canonicalTrustedPartyRoster(result.partyRoster)}`).digest("hex"));

    const replay = await app.inject({
      method: "POST", url: "/api/internal/matchmaker-auth", headers: { "content-type": "application/json", ...signed }, payload: JSON.parse(body),
    });
    expect(replay.statusCode).toBe(409);
    const wrongDomain = await app.inject({
      method: "POST",
      url: "/api/internal/matchmaker-auth",
      headers: { "content-type": "application/json", ...signedHeaders("game-persistence", body, Date.now().toString(), randomUUID()) },
      payload: JSON.parse(body),
    });
    expect(wrongDomain.statusCode).toBe(401);
    await app.close();
  });

  it("signs status on its own operation domain without returning roster or party metadata", async () => {
    process.env.DOTBOT_RELAY_SECRET = secret;
    const { app } = await createServer({
      persistence: new DurableApiPersistence(), publicQuickPlay: true, durableParties: true, atomicPartyAllocation: true,
    });
    const body = JSON.stringify({
      token: "device-token-with-enough-entropy",
      partyAllocationVersion: "party-v1",
      operation: "status",
      claimId,
    });
    const requestId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/matchmaker-auth",
      headers: {
        "content-type": "application/json",
        ...signedHeaders("matchmaker-auth", body, Date.now().toString(), requestId),
      },
      payload: JSON.parse(body),
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<{ queueClaimId: string; playerId: string; status: string; statusSignature: string }>();
    expect(payload).toEqual({
      queueClaimId: claimId,
      playerId: leaderId,
      status: "active",
      statusSignature: createHmac("sha256", secret)
        .update(`party-status.${requestId}.${claimId}.${leaderId}.active`).digest("hex"),
    });
    expect(response.body).not.toContain(`party-${"a".repeat(32)}`);
    expect(response.body).not.toContain(memberId);
    await app.close();
  });

  it("preflights without mutating the arena and rejects replayed allocator operations", async () => {
    const verifyPartyOperation = vi.fn(async () => ({
      gameSessionId: "game-session-1", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1",
    }));
    const gameLift = {
      verifyPartyOperation,
      arenaId: async () => "A2BC",
      removePlayerSession: vi.fn(async () => undefined),
      endProcess: vi.fn(async () => undefined),
    } as unknown as GameLiftSessionGate;
    const { app, rooms } = await createServer({
      persistence: new DurableApiPersistence(), gameLift, publicQuickPlay: true, durableParties: true, atomicPartyAllocation: true, hotArena: {},
    });
    const room = rooms.createRoom("A2BC");
    const now = Date.now();
    const roster: TrustedPartyRoster = {
      claimId,
      partyId: `party-${"a".repeat(32)}`,
      version: 7,
      leaderPlayerId: leaderId,
      requestingPlayerId: leaderId,
      buildId: "web-42",
      region: "ca-central-1",
      issuedAt: now,
      expiresAt: now + 30_000,
      members: [
        { playerId: leaderId, name: "Leader", loadoutRevision: 4 },
        { playerId: memberId, name: "Member", loadoutRevision: 9 },
      ],
    };
    const requestId = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: "/api/internal/public-party-preflight",
      headers: { "x-dotbot-request-id": requestId },
      payload: { partyRoster: roster },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: true });
    expect(room.connectedCount).toBe(0);
    expect(rooms.rooms).toBe(1);
    const replay = await app.inject({
      method: "POST", url: "/api/internal/public-party-preflight", headers: { "x-dotbot-request-id": requestId }, payload: { partyRoster: roster },
    });
    expect(replay.statusCode).toBe(409);
    expect(verifyPartyOperation).toHaveBeenCalledWith("party-preflight", undefined, requestId, undefined, expect.any(String));
    await app.close();
  });

  it("retries partial GameLift removals independently and reports only unreconciled reservations", async () => {
    const attempts = new Map<string, number>();
    const gameLift = {
      removePlayerSession: vi.fn(async (playerSessionId: string) => {
        const count = (attempts.get(playerSessionId) ?? 0) + 1;
        attempts.set(playerSessionId, count);
        if (playerSessionId === "eventual" && count < 3) throw new Error("retry");
        if (playerSessionId === "permanent") throw new Error("down");
      }),
    };
    expect(await releasePartyReservations(gameLift as never, ["ready", "eventual", "permanent"])).toEqual({
      releasedPlayerSessionIds: ["ready", "eventual"],
      failedPlayerSessionIds: ["permanent"],
    });
    expect(attempts).toEqual(new Map([["ready", 1], ["eventual", 3], ["permanent", 3]]));
  });
});

function signedHeaders(scope: "matchmaker-auth" | "game-persistence", body: string, timestamp: string, requestId: string) {
  return {
    "x-dotbot-timestamp": timestamp,
    "x-dotbot-request-id": requestId,
    "x-dotbot-signature": createHmac("sha256", secret).update(`${scope}.${timestamp}.${requestId}.${body}`).digest("hex"),
  };
}
