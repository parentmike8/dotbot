import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./app";
import { NoopPersistence } from "./db/NoopPersistence";

const originalSecret = process.env.DOTBOT_RELAY_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.DOTBOT_RELAY_SECRET;
  else process.env.DOTBOT_RELAY_SECRET = originalSecret;
});

describe("authoritative persistence relay", () => {
  it("accepts a fresh HMAC-signed allow-listed operation", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = "test-relay-secret";
    const { app } = await createServer({ persistence: new NoopPersistence() });
    const payload = { operation: "resolveOrRegisterPlayer", args: { token: "token-abcdef123456", offeredName: "Ada" } };
    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const signature = createHmac("sha256", process.env.DOTBOT_RELAY_SECRET).update(`${timestamp}.${body}`).digest("hex");

    const response = await app.inject({
      method: "POST",
      url: "/api/internal/game-persistence",
      headers: { "x-dotbot-timestamp": timestamp, "x-dotbot-signature": signature, "content-type": "application/json" },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: { playerId: "p-token-abcdef", name: "Ada" } });
    await app.close();
  });

  it("rejects unsigned relay traffic", async () => {
    process.env.NODE_ENV = "test";
    process.env.DOTBOT_RELAY_SECRET = "test-relay-secret";
    const { app } = await createServer({ persistence: new NoopPersistence() });
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/game-persistence",
      payload: { operation: "consumeLoadout", args: { playerId: "p-1" } },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
