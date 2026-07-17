import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";
import { GameLiftSessionGate } from "./GameLiftSessionGate";

const clients: WebSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe("GameLift dedicated server mode", () => {
  it("requires an accepted player session and pins the process to one allocated room", async () => {
    process.env.NODE_ENV = "test";
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-1",
          GameProperties: { roomCode: "A2BC" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        return new Response(JSON.stringify({ playerId: "p-token-b" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const gate = new GameLiftSessionGate({ fetch: request });
    const { app } = await createServer({
      // Player-session admission is isolated here; database identity matching
      // has separate coverage and must not depend on an ambient DATABASE_URL.
      databaseUrl: null,
      gameLift: gate,
      playerSessionReconnectMs: 50,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;

    const rejected = await connect(url);
    rejected.send(JSON.stringify({ type: "hello", token: "token-a", name: "Alice", roomCode: "A2BC" }));
    expect(await waitForMessage(rejected, "err")).toMatchObject({ code: "player_session_required" });

    const accepted = await connect(url);
    accepted.send(JSON.stringify({
      type: "hello",
      token: "token-b",
      name: "Bob",
      roomCode: "A2BC",
      playerSessionId: "psess-1",
    }));
    expect(await waitForMessage(accepted, "welcome")).toMatchObject({ roomCode: "A2BC" });
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/v1/player-sessions/accept"))).toBe(true);

    accepted.close();
    await new Promise<void>((resolve) => accepted.once("close", () => resolve()));
    const resumed = await connect(url);
    resumed.send(JSON.stringify({
      type: "hello",
      token: "token-b",
      name: "Bob",
      roomCode: "A2BC",
      playerSessionId: "psess-1",
    }));
    expect(await waitForMessage(resumed, "welcome")).toMatchObject({ roomCode: "A2BC" });
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/v1/player-sessions/accept"))).toHaveLength(1);
    resumed.close();
    await new Promise<void>((resolve) => resumed.once("close", () => resolve()));
    await vi.waitFor(() => expect(request.mock.calls.some(([input]) => String(input).endsWith("/v1/player-sessions/remove"))).toBe(true));
    await app.close();
  });
});

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  clients.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function waitForMessage<T extends ServerMessage["type"]>(ws: WebSocket, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3000);
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type !== type) return;
      clearTimeout(timeout);
      resolve(message as Extract<ServerMessage, { type: T }>);
    });
  });
}
