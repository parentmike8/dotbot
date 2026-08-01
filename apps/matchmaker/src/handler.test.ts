import { afterEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { arenaAdmissionUpdateRequest, generateRoomCode, handler, isClosedGameSessionError, isFleetWakingError, isFullGameSessionError, normalizeQuickPlayTicket, parseArenaAdmissionUpdate, publicArenaKey, secureWebSocketUrl, stalePublicArenaDeleteRequest } from "./handler";

afterEach(() => {
  delete process.env.DOTBOT_PUBLIC_QUICK_PLAY;
  delete process.env.QUICK_PLAY_BUILD_ID;
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
    expect(normalizeQuickPlayTicket({ buildId: "web-42", partyId: "spoofed", latencies: { "ca-central-1": 10 } }, identity, ["ca-central-1"], "web-42").partyId)
      .toBe("solo-player-1");
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
});
