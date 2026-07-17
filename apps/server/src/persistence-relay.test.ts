import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./app";
import { NoopPersistence } from "./db";

class RelayTestPersistence extends NoopPersistence {
  override readonly live = true;
  readonly claims = new Set<string>();
  readonly outcomes: unknown[] = [];

  override async claimRelayRequest(requestId: string): Promise<boolean> {
    if (this.claims.has(requestId)) return false;
    this.claims.add(requestId);
    return true;
  }

  override async recordOutcome(input: Parameters<NoopPersistence["recordOutcome"]>[0]): Promise<void> {
    this.outcomes.push(input);
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
    const headers = signedHeaders(body);

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
      headers: signedHeaders(validBody),
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
      headers: signedHeaders(invalidBody),
      payload: invalidBody,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("Invalid extraction payload.");
    await app.close();
  });
});

function signedHeaders(body: unknown) {
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const serialized = JSON.stringify(body);
  return {
    "content-type": "application/json",
    "x-dotbot-timestamp": timestamp,
    "x-dotbot-request-id": requestId,
    "x-dotbot-signature": createHmac("sha256", relaySecret).update(`${timestamp}.${requestId}.${serialized}`).digest("hex"),
  };
}
