import { afterEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHmac } from "node:crypto";
import { canonicalTrustedPartyReservation, type TrustedPartyRoster } from "@dotbot/protocol";
import {
  addPartyPackingReservation,
  atomicGameSessionIdempotencyToken,
  arenaAdmissionUpdateRequest,
  generateRoomCode,
  handler,
  isAtomicPartyAllocationEnabled,
  isClosedGameSessionError,
  isFleetWakingError,
  isFullGameSessionError,
  normalizeAtomicQuickPlayRequest,
  normalizeQuickPlayTicket,
  packingReservation,
  parseArenaAdmissionUpdate,
  partyPackingUpdateRequest,
  partyRosterAllocationDigest,
  publicArenaKey,
  retainAtomicAllocationCleanupRequest,
  selectPartyCleanupPlayerSessions,
  secureWebSocketUrl,
  signControlPlaneRequest,
  stalePublicArenaDeleteRequest,
  strandedAtomicAllocationDeleteRequest,
  validateWholePartyPlayerSessions,
} from "./handler";

afterEach(() => {
  delete process.env.DOTBOT_PUBLIC_QUICK_PLAY;
  delete process.env.DOTBOT_ATOMIC_PARTY_ALLOCATION;
  delete process.env.QUICK_PLAY_BUILD_ID;
  delete process.env.QUICK_PLAY_REGIONS;
});

describe("matchmaker endpoint helpers", () => {
  it("generates shareable room codes without ambiguous characters", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it("returns a secure browser-compatible GameLift endpoint", () => {
    expect(secureWebSocketUrl("abc.ca-central-1.amazongamelift.com", 7001))
      .toBe("wss://abc.ca-central-1.amazongamelift.com:7001/ws");
    expect(() => secureWebSocketUrl("bad/path", 7001)).toThrow("Invalid GameLift endpoint");
  });

  it("only retries errors that indicate a zero-capacity fleet is waking", () => {
    expect(isFleetWakingError({ name: "FleetCapacityExceededException" })).toBe(true);
    expect(isFleetWakingError({ name: "NotReadyException" })).toBe(true);
    expect(isFleetWakingError({ name: "InternalServiceException" })).toBe(false);
    expect(isFleetWakingError(new Error("network failure"))).toBe(false);
  });

  it("maps closed and full sessions to stable client errors", () => {
    expect(isClosedGameSessionError({ name: "NotFoundException" })).toBe(true);
    expect(isClosedGameSessionError({ name: "InvalidGameSessionStatusException" })).toBe(true);
    expect(isFullGameSessionError({ name: "GameSessionFullException" })).toBe(true);
    expect(isClosedGameSessionError({ name: "InternalServiceException" })).toBe(false);
  });

  it("keys the one public pool only by compatible build and latency-selected region", () => {
    const ticket = normalizeQuickPlayTicket({
      buildId: "web-42",
      partyId: "friends",
      latencies: { "ca-central-1": 47, "us-east-1": 92 },
    }, { playerId: "player-1", name: "Pilot", partyId: "friends" }, ["ca-central-1", "us-east-1"], "web-42");
    expect(ticket).toMatchObject({
      buildId: "web-42",
      partyId: "friends",
      region: "ca-central-1",
      latencyMs: 47,
      playerId: "player-1",
    });
    expect(publicArenaKey(ticket)).toBe("PUBLIC#ca-central-1#web-42");
    expect(publicArenaKey({ region: ticket.region, buildId: ticket.buildId })).toBe("PUBLIC#ca-central-1#web-42");
  });

  it("rejects invalid build, party, and latency metadata", () => {
    const identity = { playerId: "player-1", name: "Pilot" };
    expect(() => normalizeQuickPlayTicket({ buildId: "", latencies: { "ca-central-1": 10 } }, identity, ["ca-central-1"], "web-42")).toThrow();
    expect(() => normalizeQuickPlayTicket({ buildId: "disabled", latencies: { "ca-central-1": 10 } }, identity, ["ca-central-1"], "disabled")).toThrow();
    expect(() => normalizeQuickPlayTicket({ buildId: "Disabled", latencies: { "ca-central-1": 10 } }, identity, ["ca-central-1"], "Disabled")).toThrow();
    expect(() => normalizeQuickPlayTicket({ buildId: "web-old", latencies: { "ca-central-1": 10 } }, identity, ["ca-central-1"], "web-42")).toThrow();
    expect(() => normalizeQuickPlayTicket({ buildId: "web-42", latencies: { "ca-central-1": 10 } }, { ...identity, partyId: "x".repeat(129) }, ["ca-central-1"], "web-42")).toThrow();
    expect(() => normalizeQuickPlayTicket({ buildId: "web-42", latencies: { "ca-central-1": -1 } }, identity, ["ca-central-1"], "web-42")).toThrow();
    const soloPartyId = normalizeQuickPlayTicket({ buildId: "web-42", partyId: "spoofed", latencies: { "ca-central-1": 10 } }, identity, ["ca-central-1"], "web-42").partyId;
    expect(soloPartyId).toMatch(/^solo-[a-f0-9]{24}$/);
    expect(soloPartyId).not.toContain(identity.playerId);
  });

  it("keeps the public allocator disabled until the explicit control-plane flag is set", async () => {
    delete process.env.DOTBOT_PUBLIC_QUICK_PLAY;
    const result = await handler({ routeKey: "POST /quick-play" } as APIGatewayProxyEventV2) as { statusCode: number; body?: string };
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "Route not found." });
  });

  it("keeps the public allocator disabled when the boolean flag uses the sentinel build id", async () => {
    process.env.DOTBOT_PUBLIC_QUICK_PLAY = "true";
    process.env.QUICK_PLAY_BUILD_ID = "disabled";
    const result = await handler({ routeKey: "POST /quick-play" } as APIGatewayProxyEventV2) as { statusCode: number; body?: string };
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "Route not found." });
  });

  it("does not allocate legacy sessions while the public process mode is active", async () => {
    process.env.DOTBOT_PUBLIC_QUICK_PLAY = "true";
    process.env.QUICK_PLAY_BUILD_ID = "web-42";
    for (const routeKey of ["POST /rooms", "POST /rooms/{roomCode}/join"] as const) {
      const result = await handler({ routeKey } as APIGatewayProxyEventV2) as { statusCode: number; body?: string };
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body ?? "{}")).toEqual({ error: "Route not found." });
    }
  });

  it("keeps atomic party allocation independently default-off", async () => {
    process.env.DOTBOT_PUBLIC_QUICK_PLAY = "true";
    process.env.QUICK_PLAY_BUILD_ID = "web-42";
    expect(isAtomicPartyAllocationEnabled()).toBe(false);
    const disabled = await handler({ routeKey: "POST /quick-play/cancel" } as APIGatewayProxyEventV2) as { statusCode: number };
    expect(disabled.statusCode).toBe(404);
    process.env.DOTBOT_ATOMIC_PARTY_ALLOCATION = "true";
    expect(isAtomicPartyAllocationEnabled()).toBe(true);
  });

  it("selects only a configured compatible build and lowest allowed latency", () => {
    process.env.QUICK_PLAY_BUILD_ID = "web-42";
    process.env.QUICK_PLAY_REGIONS = "ca-central-1,us-east-1";
    expect(normalizeAtomicQuickPlayRequest({
      queueRequestId: "00000000-0000-4000-8000-000000000901",
      buildId: "web-42",
      latencies: { "ca-central-1": 43, "us-east-1": 25, "eu-west-1": 1 },
      partyId: "client-spoof",
      mmr: 9999,
    })).toEqual({
      queueRequestId: "00000000-0000-4000-8000-000000000901",
      buildId: "web-42",
      region: "us-east-1",
      latencyMs: 25,
    });
  });

  it("packs complete parties idempotently and never over capacity or duplicate a canonical identity", () => {
    let reservations: ReturnType<typeof packingReservation>[] = [];
    for (let party = 1; party <= 6; party += 1) {
      const roster = rosterFor(party, 3);
      reservations = addPartyPackingReservation(reservations, packingReservation(roster))!;
    }
    expect(reservations.flatMap((reservation) => reservation.memberPlayerIds)).toHaveLength(18);
    expect(addPartyPackingReservation(reservations, packingReservation(rosterFor(7, 1)))).toBeNull();

    const first = packingReservation(rosterFor(10, 3));
    expect(addPartyPackingReservation([first], { ...first, memberPlayerIds: [...first.memberPlayerIds] })).toEqual([first]);
    expect(addPartyPackingReservation([first], { ...first, version: first.version + 1 })).toBeNull();
    expect(addPartyPackingReservation([first], {
      ...packingReservation(rosterFor(11, 1)),
      memberPlayerIds: [first.memberPlayerIds[0]],
    })).toBeNull();
  });

  it("makes two allocators contend on the exact arena and packing revisions", () => {
    const existing = {
      pk: "PUBLIC#ca-central-1#web-42",
      status: "active" as const,
      expiresAt: 99_999,
      gameSessionId: "game-session-1",
      arenaId: "A2BC",
      buildId: "web-42",
      region: "ca-central-1",
      admissionClosesAt: Date.now() + 5_000,
      admissionRevision: 9,
      endpointHost: "compute.example",
      endpointPort: 7001,
      partySecret: "a".repeat(64),
      packingRevision: 7,
      partyReservations: [],
    };
    const left = packingReservation(rosterFor(20, 3));
    const right = packingReservation(rosterFor(21, 3));
    const leftRequest = partyPackingUpdateRequest("sessions", existing.pk, existing, [left], 8);
    const rightRequest = partyPackingUpdateRequest("sessions", existing.pk, existing, [right], 8);
    expect(leftRequest.ConditionExpression).toContain("packingRevision = :packingRevision");
    expect(leftRequest.ConditionExpression).toContain("admissionRevision = :admissionRevision");
    expect(leftRequest.ConditionExpression).toContain("admissionClosesAt > :now");
    expect(leftRequest.ExpressionAttributeValues).toMatchObject({ ":packingRevision": 7, ":admissionRevision": 9 });
    expect(rightRequest.ExpressionAttributeValues).toMatchObject({ ":packingRevision": 7, ":admissionRevision": 9 });
    // DynamoDB permits only one of those revision-7 conditions. The loser
    // rereads revision 8 and can add its whole roster without partial slots.
    expect(addPartyPackingReservation([left], right)?.map((reservation) => reservation.claimId)).toEqual([left.claimId, right.claimId]);
  });

  it("accepts only an exact whole-party GameLift batch", () => {
    const ids = rosterFor(30, 3).members.map((member) => member.playerId);
    const complete = ids.map((playerId, index) => ({
      PlayerId: playerId,
      PlayerSessionId: `player-session-${index}`,
      DnsName: "compute.example",
      Port: 7001,
    }));
    expect(validateWholePartyPlayerSessions(ids, complete)).toHaveLength(3);
    expect(validateWholePartyPlayerSessions(ids, complete.slice(0, 2))).toBeNull();
    expect(validateWholePartyPlayerSessions(ids, complete.map((session) => ({ ...session, PlayerSessionId: "duplicate" })))).toBeNull();
    expect(validateWholePartyPlayerSessions(ids, complete.map((session, index) => index === 1 ? { ...session, Port: undefined } : session))).toBeNull();
  });

  it("keeps allocation idempotency stable across member order and requesting device", () => {
    const first = rosterFor(40, 3);
    const second: TrustedPartyRoster = {
      ...first,
      requestingPlayerId: first.members[2].playerId,
      issuedAt: first.issuedAt + 1,
      expiresAt: first.expiresAt + 1,
      members: [...first.members].reverse(),
    };
    expect(partyRosterAllocationDigest(second)).toBe(partyRosterAllocationDigest(first));
  });

  it("derives one bounded GameLift creation token from the canonical claim", () => {
    const claimId = "00000000-0000-4000-8000-000000000040";
    expect(atomicGameSessionIdempotencyToken(claimId)).toBe(`party-${claimId}`);
    expect(atomicGameSessionIdempotencyToken(claimId)).toHaveLength(42);
    expect(() => atomicGameSessionIdempotencyToken("client-controlled")).toThrow();
  });

  it("discovers cleanup ids only from this GameSession's signed canonical claim", () => {
    const roster = rosterFor(41, 2);
    const secret = "a".repeat(64);
    const arenaId = "A2BC";
    const gameSessionId = "game-session-1";
    const memberPlayerIds = roster.members.map((member) => member.playerId).sort();
    const sessionFor = (playerId: string, playerSessionId: string, overrides: Record<string, unknown> = {}) => {
      const reservation = {
        claimId: roster.claimId,
        partyId: roster.partyId,
        version: roster.version,
        playerId,
        memberPlayerIds,
        arenaId,
        buildId: roster.buildId,
        region: roster.region,
        expiresAt: roster.expiresAt,
      };
      const reservationSignature = createHmac("sha256", secret)
        .update(`party-reservation.${canonicalTrustedPartyReservation(reservation)}`)
        .digest("hex");
      return {
        PlayerId: playerId,
        PlayerSessionId: playerSessionId,
        GameSessionId: gameSessionId,
        Status: "RESERVED",
        PlayerData: JSON.stringify({ mode: "public-hot-arena", reservation, reservationSignature }),
        ...overrides,
      };
    };
    const trusted = memberPlayerIds.map((playerId, index) => sessionFor(playerId, `player-session-${index + 1}`));
    expect(selectPartyCleanupPlayerSessions(
      gameSessionId, arenaId, secret, roster.claimId, memberPlayerIds, trusted,
    )).toEqual(memberPlayerIds.map((playerId, index) => ({ playerId, playerSessionId: `player-session-${index + 1}` })));
    expect(selectPartyCleanupPlayerSessions(
      gameSessionId,
      arenaId,
      secret,
      roster.claimId,
      memberPlayerIds,
      [
        ...trusted,
        sessionFor(memberPlayerIds[0], "foreign-session", { GameSessionId: "different-session" }),
        sessionFor(memberPlayerIds[0], "tampered-session", { PlayerData: "{}" }),
        sessionFor(memberPlayerIds[0], "completed-session", { Status: "COMPLETED" }),
      ],
    )).toEqual(memberPlayerIds.map((playerId, index) => ({ playerId, playerSessionId: `player-session-${index + 1}` })));
    expect(selectPartyCleanupPlayerSessions(
      gameSessionId,
      arenaId,
      secret,
      roster.claimId,
      memberPlayerIds,
      [sessionFor(memberPlayerIds[0], "unknown-status", { Status: "UNKNOWN" })],
    )).toBeNull();
  });

  it("retains exact cleanup evidence before compensating and fences expired-owner deletion", () => {
    const allocation = {
      arenaKey: "PUBLIC#ca-central-1#web-42",
      gameSessionId: "game-session-1",
      arenaId: "A2BC",
      endpointHost: "compute.example",
      endpointPort: 7001,
      partySecret: "a".repeat(64),
      packingRevision: 4,
      memberPlayerIds: ["00000000-0000-4000-8000-000000000001"],
      allocations: [{
        playerId: "00000000-0000-4000-8000-000000000001",
        playerSessionId: "player-session-1",
        websocketUrl: "wss://compute.example:7001/ws",
      }],
      cleanupPlayerSessionIds: ["player-session-1"],
      cleanupDiscoveryUntil: 0,
      terminateGameSession: false,
    };
    const retained = retainAtomicAllocationCleanupRequest(
      "sessions",
      "ALLOCATION#claim",
      "allocator-owner",
      "roster-digest",
      allocation,
    );
    expect(retained.ConditionExpression).toContain("#status = :allocating AND #owner = :owner");
    expect(retained.ConditionExpression).toContain("#status = :cancelling");
    expect(retained.UpdateExpression).toContain("allocations = :allocations");
    expect(retained.UpdateExpression).toContain("cleanupPlayerSessionIds = :cleanupIds");
    expect(retained.UpdateExpression).toContain("cleanupDiscoveryUntil = :discoveryUntil");
    expect(retained.ExpressionAttributeValues).toMatchObject({
      ":owner": "allocator-owner",
      ":digest": "roster-digest",
      ":allocations": allocation.allocations,
      ":cleanupIds": allocation.cleanupPlayerSessionIds,
      ":memberIds": allocation.memberPlayerIds,
      ":discoveryUntil": 0,
      ":session": "game-session-1",
    });

    const partial = retainAtomicAllocationCleanupRequest(
      "sessions",
      "ALLOCATION#claim",
      "allocator-owner",
      "roster-digest",
      {
        ...allocation,
        allocations: [],
        cleanupPlayerSessionIds: [],
        cleanupDiscoveryUntil: 123_456,
        terminateGameSession: true,
      },
    );
    expect(partial.ExpressionAttributeValues).toMatchObject({
      ":allocations": [],
      ":cleanupIds": [],
      ":discoveryUntil": 123_456,
      ":terminate": true,
    });

    const stranded = strandedAtomicAllocationDeleteRequest("sessions", "ALLOCATION#claim", {
      pk: "ALLOCATION#claim",
      status: "allocating",
      owner: "allocator-owner",
      ownerLeaseExpiresAt: 1234,
      rosterDigest: "roster-digest",
      gameSessionId: "game-session-1",
      arenaId: "A2BC",
      allocations: allocation.allocations,
      arenaKey: allocation.arenaKey,
      endpointHost: allocation.endpointHost,
      endpointPort: allocation.endpointPort,
      partySecret: allocation.partySecret,
      expiresAt: 9999,
    }, "roster-digest");
    expect(stranded.ConditionExpression).toContain("ownerLeaseExpiresAt = :lease");
    expect(stranded.ConditionExpression).toContain("gameSessionId = :session AND arenaId = :arena");
    expect(stranded.ExpressionAttributeValues).toMatchObject({
      ":owner": "allocator-owner",
      ":lease": 1234,
      ":session": "game-session-1",
      ":arena": "A2BC",
    });
  });

  it("accepts only bounded availability windows for the exact public arena metadata", () => {
    const now = 10_000;
    expect(parseArenaAdmissionUpdate({
      gameSessionId: "game-session-1",
      arenaId: "a2bc",
      buildId: "web-42",
      region: "ca-central-1",
      open: true,
      closesAt: 16_000,
      revision: 1,
    }, now)).toEqual({ gameSessionId: "game-session-1", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1", open: true, closesAt: 16_000, revision: 1 });
    const closed = { gameSessionId: "game-session-1", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1", open: false, revision: 2 };
    expect(parseArenaAdmissionUpdate(closed, now).closesAt).toBe(0);
    expect(() => parseArenaAdmissionUpdate({ ...closed, open: true, closesAt: 17_000 }, now)).toThrow();
    expect(() => parseArenaAdmissionUpdate({ ...closed, arenaId: "wrong" }, now)).toThrow();
    expect(() => parseArenaAdmissionUpdate({ ...closed, revision: 0 }, now)).toThrow();
    expect(() => parseArenaAdmissionUpdate({ ...closed, gameSessionId: "" }, now)).toThrow();
  });

  it("hands the pool pointer to a reopened arena only when the current pointer is closed", () => {
    const open = parseArenaAdmissionUpdate({
      gameSessionId: "game-session-old",
      arenaId: "A2BC",
      buildId: "web-42",
      region: "ca-central-1",
      open: true,
      closesAt: 16_000,
      revision: 7,
    }, 10_000);
    const openRequest = arenaAdmissionUpdateRequest(open, "sessions", 10_000);
    expect(openRequest.ConditionExpression).toContain("gameSessionId = :session AND arenaId = :arena");
    expect(openRequest.ConditionExpression).toContain("#status = :active");
    expect(openRequest.ConditionExpression).not.toContain("attribute_not_exists(pk)");
    expect(openRequest.ConditionExpression).not.toContain("gameSessionId <> :session");
    expect(openRequest.ExpressionAttributeValues).toMatchObject({
      ":session": "game-session-old",
      ":revision": 7,
    });

    const closeRequest = arenaAdmissionUpdateRequest({ ...open, open: false, closesAt: 0, revision: 8 }, "sessions", 10_001);
    expect(closeRequest.ConditionExpression).toContain("arenaId = :arena AND gameSessionId = :session");
    expect(closeRequest.ConditionExpression).toContain("admissionRevision < :revision");
  });

  it("cannot delete a replacement pool pointer after a stale session reports full", () => {
    expect(stalePublicArenaDeleteRequest("sessions", "PUBLIC#ca-central-1#web-42", "session-old", "A2BC", 16_000, 7)).toEqual({
      TableName: "sessions",
      Key: { pk: "PUBLIC#ca-central-1#web-42" },
      ConditionExpression: "gameSessionId = :session AND arenaId = :arena AND admissionClosesAt = :closes AND admissionRevision = :revision",
      ExpressionAttributeValues: {
        ":session": "session-old",
        ":arena": "A2BC",
        ":closes": 16_000,
        ":revision": 7,
      },
    });
  });

  it("guards an initial pointer without a revision from a later reopen before stale deletion", () => {
    expect(stalePublicArenaDeleteRequest("sessions", "PUBLIC#ca-central-1#web-42", "session-old", "A2BC", 16_000))
      .toMatchObject({
        ConditionExpression: expect.stringContaining("attribute_not_exists(admissionRevision)"),
        ExpressionAttributeValues: expect.not.objectContaining({ ":revision": expect.anything() }),
      });
  });

  it("signs matchmaker authentication with the replay-protected control-plane contract", () => {
    const secret = "test-secret";
    const body = JSON.stringify({ token: "device-token" });
    const timestamp = "1785552000000";
    const requestId = "00000000-0000-4000-8000-000000000001";
    expect(signControlPlaneRequest(secret, body, timestamp, requestId)).toEqual({
      "x-dotbot-timestamp": timestamp,
      "x-dotbot-request-id": requestId,
      "x-dotbot-signature": createHmac("sha256", secret).update(`matchmaker-auth.${timestamp}.${requestId}.${body}`).digest("hex"),
    });
  });
});

function rosterFor(seed: number, size: 1 | 2 | 3): TrustedPartyRoster {
  const ids = Array.from({ length: size }, (_, index) => uuid(seed * 3 + index + 1));
  return {
    claimId: uuid(800 + seed),
    partyId: `party-${seed.toString(16).padStart(32, "0")}`,
    version: seed + 1,
    leaderPlayerId: ids[0],
    requestingPlayerId: ids[0],
    buildId: "web-42",
    region: "ca-central-1",
    issuedAt: 1_785_552_000_000,
    expiresAt: 1_785_552_030_000,
    members: ids.map((playerId, index) => ({ playerId, name: `Pilot ${seed}-${index}` })),
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
