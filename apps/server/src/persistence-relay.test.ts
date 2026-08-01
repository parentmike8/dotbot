import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./app";
import { NoopPersistence } from "./db";

class RelayTestPersistence extends NoopPersistence {
  override readonly live = true;
  readonly claims = new Set<string>();
  readonly outcomes: unknown[] = [];
  readonly starts: Array<Parameters<NoopPersistence["startMatch"]>[0]> = [];

  override async claimRelayRequest(requestId: string): Promise<boolean> {
    if (this.claims.has(requestId)) return false;
    this.claims.add(requestId);
    return true;
  }

  override async recordOutcome(input: Parameters<NoopPersistence["recordOutcome"]>[0]): Promise<void> {
    this.outcomes.push(input);
  }

  override async startMatch(input: Parameters<NoopPersistence["startMatch"]>[0]) {
    this.starts.push(input);
    return super.startMatch(input);
  }
}

const relaySecret = "test-relay-secret-at-least-32-bytes";

afterEach(() => {
  delete process.env.DOTBOT_RELAY_SECRET;
  vi.restoreAllMocks();
});

describe("authoritative persistence relay", () => {
  it("requires a nonce-bound signature and rejects replayed request ids", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = relaySecret;
    const persistence = new RelayTestPersistence();
    const { app } = await createServer({ persistence });
    const body = {
      operation: "recordOutcome",
      args: {
        matchId: randomUUID(),
        playerId: randomUUID(),
        outcome: "died",
      },
    };
    const headers = signedHeaders(body, "game-persistence");

    const accepted = await app.inject({ method: "POST", url: "/api/internal/game-persistence", headers, payload: body });
    expect(accepted.statusCode).toBe(200);
    expect(persistence.outcomes).toEqual([body.args]);

    const replayed = await app.inject({ method: "POST", url: "/api/internal/game-persistence", headers, payload: body });
    expect(replayed.statusCode).toBe(409);
    expect(persistence.outcomes).toHaveLength(1);

    const tampered = await app.inject({
      method: "POST",
      url: "/api/internal/game-persistence",
      headers,
      payload: { ...body, args: { ...body.args, outcome: "timeout" } },
    });
    expect(tampered.statusCode).toBe(401);
    await app.close();
  });

  it("validates operation arguments before invoking persistence", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = relaySecret;
    const persistence = new RelayTestPersistence();
    const { app } = await createServer({ persistence });
    const validBody = {
      operation: "recordExtraction",
      args: {
        matchId: randomUUID(),
        playerId: randomUUID(),
        blueprintLearningThreshold: 3,
        manifest: {
          reason: "extracted",
          keptItems: ["b:shelf"],
          lostItems: [],
          learnedBlueprints: [],
          cargo: [{ kind: "blueprint", blueprintId: "shelf", sourceBuildingId: "lot6" }],
        },
      },
    };
    const accepted = await app.inject({
      method: "POST",
      url: "/api/internal/game-persistence",
      headers: signedHeaders(validBody, "game-persistence"),
      payload: validBody,
    });
    expect(accepted.statusCode).toBe(200);

    const invalidBody = {
      operation: "recordExtraction",
      args: {
        matchId: randomUUID(),
        playerId: randomUUID(),
        blueprintLearningThreshold: 3,
        manifest: { reason: "extracted", keptItems: ["forged-item"], lostItems: [], learnedBlueprints: [] },
      },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/game-persistence",
      headers: signedHeaders(invalidBody, "game-persistence"),
      payload: invalidBody,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("Invalid extraction payload.");
    await app.close();
  });

  it("accepts the complete 18-human public roster and rejects a nineteenth participant", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = relaySecret;
    const persistence = new RelayTestPersistence();
    const { app } = await createServer({ persistence });
    const playerIds = Array.from({ length: 19 }, () => randomUUID());
    const body = {
      operation: "startMatch",
      args: {
        matchId: randomUUID(),
        roomCode: "FULL",
        mapId: "downtown",
        startedAt: new Date().toISOString(),
        playerIds: playerIds.slice(0, 18),
      },
    };

    const accepted = await app.inject({
      method: "POST",
      url: "/api/internal/game-persistence",
      headers: signedHeaders(body, "game-persistence"),
      payload: body,
    });
    expect(accepted.statusCode).toBe(200);
    expect(persistence.starts[0].playerIds).toEqual(playerIds.slice(0, 18));

    const oversized = { ...body, args: { ...body.args, matchId: randomUUID(), playerIds } };
    const rejected = await app.inject({
      method: "POST",
      url: "/api/internal/game-persistence",
      headers: signedHeaders(oversized, "game-persistence"),
      payload: oversized,
    });
    expect(rejected.statusCode).toBe(400);
    expect(persistence.starts).toHaveLength(1);
    await app.close();
  });

  it("keeps identity, friendship, invite, and deletion operations off the dedicated-server allow-list", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = relaySecret;
    const persistence = new RelayTestPersistence();
    const { app } = await createServer({ persistence });
    for (const operation of ["linkAccount", "requestFriend", "createPartyInvite", "deleteLinkedAccount"]) {
      const body = { operation, args: {} };
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/game-persistence",
        headers: signedHeaders(body, "game-persistence"),
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("Persistence relay operation is not allowed.");
    }
    await app.close();
  });

  it("confines matchmaker UUID authentication to a signed replay-protected endpoint", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = relaySecret;
    const persistence = new RelayTestPersistence();
    const { app } = await createServer({ persistence });
    const body = { token: "matchmaker-device-token" };
    const headers = signedHeaders(body, "matchmaker-auth");
    const accepted = await app.inject({ method: "POST", url: "/api/internal/matchmaker-auth", headers, payload: body });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ playerId: string }>().playerId).toBeTruthy();
    expect((await app.inject({ method: "POST", url: "/api/internal/matchmaker-auth", headers, payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/internal/matchmaker-auth", payload: body })).statusCode).toBe(401);
    await app.close();
  });

  it("separates matchmaker authentication from persistence signature domains", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = relaySecret;
    const persistence = new RelayTestPersistence();
    const { app } = await createServer({ persistence });
    const body = { token: "matchmaker-device-token" };
    const headers = signedHeaders(body, "matchmaker-auth");

    const confused = await app.inject({ method: "POST", url: "/api/internal/game-persistence", headers, payload: body });
    expect(confused.statusCode).toBe(401);
    expect(persistence.claims).not.toContain(headers["x-dotbot-request-id"]);

    const correctlyScoped = await app.inject({ method: "POST", url: "/api/internal/matchmaker-auth", headers, payload: body });
    expect(correctlyScoped.statusCode).toBe(200);
    await app.close();
  });
});

function signedHeaders(body: unknown, scope: "matchmaker-auth" | "game-persistence") {
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const serialized = JSON.stringify(body);
  return {
    "content-type": "application/json",
    "x-dotbot-timestamp": timestamp,
    "x-dotbot-request-id": requestId,
    "x-dotbot-signature": createHmac("sha256", relaySecret).update(`${scope}.${timestamp}.${requestId}.${serialized}`).digest("hex"),
  };
}
