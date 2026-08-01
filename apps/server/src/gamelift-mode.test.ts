import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";
import { GameLiftSessionGate } from "./GameLiftSessionGate";
import { NoopPersistence } from "./db";
import { completedBaseTutorialState } from "@dotbot/game/baseTutorial";

class CompletedTestPersistence extends NoopPersistence {
  override readonly live = true;
  override async resolveOrRegisterPlayer(_token: string, offeredName: string) {
    return { playerId: "internal-player-b", publicPlayerId: "ABCDEFGH", name: offeredName };
  }
  override async getBaseTutorialForPlayer() {
    return { ...completedBaseTutorialState };
  }
}

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
        return new Response(JSON.stringify({ playerId: "ABCD-EFGH" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const gate = new GameLiftSessionGate({ fetch: request });
    const { app } = await createServer({
      // Player-session admission is isolated here; database identity matching
      // has separate coverage and must not depend on an ambient DATABASE_URL.
      persistence: new CompletedTestPersistence(),
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

  it("admits the additive public handshake from trusted player-session metadata without exposing a room code", async () => {
    process.env.NODE_ENV = "test";
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-public",
          GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        return new Response(JSON.stringify({
          playerId: "p-token-public",
          playerData: JSON.stringify({
            mode: "public-hot-arena",
            arenaId: "A2BC",
            partyId: "party-public",
            buildId: "web-42",
            region: "ca-central-1",
          }),
        }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const { app } = await createServer({
      persistence: new CompletedTestPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      publicQuickPlay: true,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      playerSessionReconnectMs: 10,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;

    const wrongMode = await connect(url);
    wrongMode.send(JSON.stringify({ type: "hello", token: "token-public", name: "Pilot", roomCode: "A2BC", playerSessionId: "psess-wrong" }));
    expect(await waitForMessage(wrongMode, "err")).toMatchObject({ code: "wrong_session_mode" });
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/v1/player-sessions/accept"))).toBe(false);

    const accepted = await connect(url);
    accepted.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-public",
      name: "Pilot",
      playerSessionId: "psess-public",
    }));
    const welcome = await waitForMessage(accepted, "arenaWelcome");
    expect(welcome).toMatchObject({ arenaId: "A2BC", phase: "assembling", retiring: false });
    expect(welcome).not.toHaveProperty("roomCode");
    accepted.close();
    await new Promise<void>((resolve) => accepted.once("close", () => resolve()));
    await vi.waitFor(() => expect(request.mock.calls.some(([input]) => String(input).endsWith("/v1/player-sessions/remove"))).toBe(true));
    await app.close();
  });

  it("removes a disconnected non-redeploying reservation as soon as the arena reopens", async () => {
    process.env.NODE_ENV = "test";
    let now = 0;
    const removed: string[] = [];
    class LinkedPersistence extends CompletedTestPersistence {
      override async resolveOrRegisterPlayer(token: string, offeredName: string) {
        const suffix = token.endsWith("stay") ? "stay" : "leave";
        return {
          playerId: `canonical-${suffix}`,
          name: offeredName,
          previousPlayerIds: [`reserved-${suffix}`],
        };
      }
    }
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-public",
          GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
        }), { status: 200 });
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { playerSessionId: string } : null;
      if (url.endsWith("/v1/player-sessions/accept") && body) {
        const suffix = body.playerSessionId.endsWith("stay") ? "stay" : "leave";
        return new Response(JSON.stringify({
          playerId: `reserved-${suffix}`,
          playerData: JSON.stringify({
            mode: "public-hot-arena",
            arenaId: "A2BC",
            partyId: `party-${suffix}`,
            buildId: "web-42",
            region: "ca-central-1",
          }),
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/remove") && body) removed.push(body.playerSessionId);
      return new Response(null, { status: 204 });
    });
    const { app, rooms } = await createServer({
      persistence: new LinkedPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      publicQuickPlay: true,
      now: () => now,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      playerSessionReconnectMs: 60_000,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const staying = await connect(url);
    const leaving = await connect(url);
    staying.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-stay",
      name: "Stay",
      playerSessionId: "psess-stay",
    }));
    leaving.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-leave",
      name: "Leave",
      playerSessionId: "psess-leave",
    }));
    await Promise.all([waitForMessage(staying, "arenaWelcome"), waitForMessage(leaving, "arenaWelcome")]);
    const stayingStart = waitForMessage(staying, "matchStart");
    const leavingStart = waitForMessage(leaving, "matchStart");
    now = 1_000;
    await Promise.all([stayingStart, leavingStart]);

    leaving.close();
    await new Promise<void>((resolve) => leaving.once("close", () => resolve()));
    const room = rooms.join("A2BC");
    if (!room) throw new Error("Expected assigned public arena");
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    staying.send(JSON.stringify({ type: "deployAgain" }));

    await vi.waitFor(() => expect(removed).toContain("psess-leave"));
    expect(removed).not.toContain("psess-stay");
    staying.close();
    await new Promise<void>((resolve) => staying.once("close", () => resolve()));
    await app.close();
  });

  it("retries transient GameLift reservation-removal failures before releasing the binding", async () => {
    process.env.NODE_ENV = "test";
    let removalAttempts = 0;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-public",
          GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        return new Response(JSON.stringify({
          playerId: "p-token-retry",
          playerData: JSON.stringify({
            mode: "public-hot-arena",
            arenaId: "A2BC",
            partyId: "party-retry",
            buildId: "web-42",
            region: "ca-central-1",
          }),
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/remove")) {
        removalAttempts += 1;
        return new Response(null, { status: removalAttempts < 3 ? 503 : 204 });
      }
      return new Response(null, { status: 204 });
    });
    const { app } = await createServer({
      persistence: new CompletedTestPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      publicQuickPlay: true,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await connect(`ws://127.0.0.1:${address.port}/ws`);
    client.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-retry",
      name: "Retry",
      playerSessionId: "psess-retry",
    }));
    await waitForMessage(client, "arenaWelcome");

    client.send(JSON.stringify({ type: "leaveRun" }));
    await vi.waitFor(() => expect(removalAttempts).toBe(3));
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it("retains and reconciles a reservation whose accepted metadata response cannot be trusted", async () => {
    process.env.NODE_ENV = "test";
    let adapterHealthy = false;
    let acceptanceAttempts = 0;
    let processEndingCalls = 0;
    const removed: string[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { playerSessionId?: string } : undefined;
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-public",
          GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        acceptanceAttempts += 1;
        return new Response(JSON.stringify({ playerId: "p-token-uncertain", playerData: "{}" }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/remove") && body?.playerSessionId) {
        removed.push(body.playerSessionId);
        return new Response(null, { status: adapterHealthy ? 204 : 503 });
      }
      if (url.endsWith("/v1/process/end")) {
        processEndingCalls += 1;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    const { app } = await createServer({
      persistence: new CompletedTestPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      publicQuickPlay: true,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      playerSessionRemovalRecoveryMs: 500,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await connect(`ws://127.0.0.1:${address.port}/ws`);
    client.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-uncertain",
      name: "Uncertain",
      playerSessionId: "psess-uncertain",
    }));

    expect(await waitForMessage(client, "err")).toMatchObject({ code: "player_session_rejected" });
    expect(acceptanceAttempts).toBe(1);
    expect(removed).toEqual(["psess-uncertain", "psess-uncertain", "psess-uncertain"]);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(503);
    expect(processEndingCalls).toBe(0);

    adapterHealthy = true;
    await vi.waitFor(
      async () => expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200),
      { timeout: 1_500 },
    );
    expect(acceptanceAttempts).toBe(1);
    expect(new Set(removed)).toEqual(new Set(["psess-uncertain"]));
    expect(processEndingCalls).toBe(0);
    await app.close();
  });

  it("fails admission closed after exhausted removal retries and automatically recovers without ending an active run", async () => {
    process.env.NODE_ENV = "test";
    let now = 0;
    let adapterHealthy = false;
    let processEndingCalls = 0;
    const accepted: string[] = [];
    const removed: string[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { playerSessionId?: string } : undefined;
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-public",
          GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept") && body?.playerSessionId) {
        accepted.push(body.playerSessionId);
        const suffix = body.playerSessionId.replace("psess-", "");
        return new Response(JSON.stringify({
          playerId: `p-token-${suffix}`,
          playerData: JSON.stringify({
            mode: "public-hot-arena",
            arenaId: "A2BC",
            partyId: `party-${suffix}`,
            buildId: "web-42",
            region: "ca-central-1",
          }),
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/remove") && body?.playerSessionId) {
        removed.push(body.playerSessionId);
        return new Response(null, { status: body.playerSessionId === "psess-leave" && !adapterHealthy ? 503 : 204 });
      }
      if (url.endsWith("/v1/process/end")) {
        processEndingCalls += 1;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    const { app, rooms } = await createServer({
      persistence: new CompletedTestPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      publicQuickPlay: true,
      now: () => now,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      playerSessionReconnectMs: 60_000,
      playerSessionRemovalRecoveryMs: 1_000,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    let staying = await connect(url);
    const leaving = await connect(url);
    const preopened = await connect(url);
    staying.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-stay",
      name: "Stay",
      playerSessionId: "psess-stay",
    }));
    leaving.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-leave",
      name: "Leave",
      playerSessionId: "psess-leave",
    }));
    await Promise.all([waitForMessage(staying, "arenaWelcome"), waitForMessage(leaving, "arenaWelcome")]);
    const stayingStart = waitForMessage(staying, "matchStart");
    const leavingStart = waitForMessage(leaving, "matchStart");
    now = 1_000;
    await Promise.all([stayingStart, leavingStart]);

    leaving.send(JSON.stringify({ type: "leaveRun" }));
    await vi.waitFor(() => expect(removed.filter((id) => id === "psess-leave")).toHaveLength(3));
    const degraded = await app.inject({ method: "GET", url: "/api/health" });
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json()).toMatchObject({ draining: false, reservationRemovalDegraded: true, rooms: 1 });
    expect([...accepted].sort()).toEqual(["psess-leave", "psess-stay"]);
    expect(rooms.join("A2BC")?.phase).toBe("live");
    expect(staying.readyState).toBe(WebSocket.OPEN);
    expect(processEndingCalls).toBe(0);

    preopened.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-preopened",
      name: "Preopened",
      playerSessionId: "psess-preopened",
    }));
    expect(await waitForMessage(preopened, "err")).toMatchObject({ code: "server_unavailable" });
    expect([...accepted].sort()).toEqual(["psess-leave", "psess-stay"]);

    staying.close();
    await new Promise<void>((resolve) => staying.once("close", () => resolve()));
    staying = await connect(url);
    staying.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-stay",
      name: "Stay",
      playerSessionId: "psess-stay",
    }));
    expect(await waitForMessage(staying, "arenaWelcome")).toMatchObject({ phase: "live" });
    expect([...accepted].sort()).toEqual(["psess-leave", "psess-stay"]);

    const blocked = await connect(url);
    blocked.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-blocked",
      name: "Blocked",
      playerSessionId: "psess-blocked",
    }));
    expect(await waitForMessage(blocked, "err")).toMatchObject({ code: "server_unavailable" });
    expect([...accepted].sort()).toEqual(["psess-leave", "psess-stay"]);
    expect(rooms.join("A2BC")?.phase).toBe("live");
    expect(staying.readyState).toBe(WebSocket.OPEN);
    expect(processEndingCalls).toBe(0);

    adapterHealthy = true;
    await vi.waitFor(
      async () => {
        expect(removed.filter((id) => id === "psess-leave").length).toBeGreaterThan(3);
        expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      },
      { timeout: 2_500 },
    );
    expect(new Set(removed)).toEqual(new Set(["psess-leave"]));
    expect(rooms.join("A2BC")?.phase).toBe("live");
    expect(staying.readyState).toBe(WebSocket.OPEN);

    const recovered = await connect(url);
    recovered.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-new",
      name: "New",
      playerSessionId: "psess-new",
    }));
    expect(await waitForMessage(recovered, "err")).toMatchObject({ code: "arena_capacity", retryable: true });
    expect(accepted).toContain("psess-new");
    expect(processEndingCalls).toBe(0);

    staying.close();
    await new Promise<void>((resolve) => staying.once("close", () => resolve()));
    await app.close();
    expect(processEndingCalls).toBe(0);
  });

  it("serializes concurrent claims for the same GameLift player session", async () => {
    process.env.NODE_ENV = "test";
    let releaseAccept!: () => void;
    const acceptGate = new Promise<void>((resolve) => { releaseAccept = resolve; });
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-1",
          GameProperties: { roomCode: "A2BC" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        await acceptGate;
        return new Response(JSON.stringify({ playerId: "p-token-race" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const { app } = await createServer({
      persistence: new CompletedTestPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      playerSessionReconnectMs: 10,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const first = await connect(url);
    const second = await connect(url);
    const hello = JSON.stringify({
      type: "hello",
      token: "token-race",
      name: "Pilot",
      roomCode: "A2BC",
      playerSessionId: "psess-race",
    });
    first.send(hello);
    await vi.waitFor(() => expect(request.mock.calls.filter(([input]) => String(input).endsWith("/v1/player-sessions/accept"))).toHaveLength(1));
    const secondError = waitForMessage(second, "err");
    second.send(hello);
    expect(await secondError).toMatchObject({ code: "player_session_in_use" });
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/v1/player-sessions/remove"))).toHaveLength(0);

    const firstWelcome = waitForMessage(first, "welcome");
    releaseAccept();
    expect(await firstWelcome).toMatchObject({ roomCode: "A2BC" });
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/v1/player-sessions/accept"))).toHaveLength(1);
    first.close();
    await new Promise<void>((resolve) => first.once("close", () => resolve()));
    await vi.waitFor(() => expect(second.readyState).toBe(WebSocket.CLOSED));
    await app.close();
  });

  it("removes an accepted reservation when its socket closes before adapter acceptance returns", async () => {
    process.env.NODE_ENV = "test";
    let markAcceptEntered!: () => void;
    let releaseAccept!: () => void;
    const acceptEntered = new Promise<void>((resolve) => { markAcceptEntered = resolve; });
    const acceptGate = new Promise<void>((resolve) => { releaseAccept = resolve; });
    const removed: string[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { playerSessionId?: string } : undefined;
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-public",
          GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        markAcceptEntered();
        await acceptGate;
        return new Response(JSON.stringify({
          playerId: "p-token-gone",
          playerData: JSON.stringify({
            mode: "public-hot-arena",
            arenaId: "A2BC",
            partyId: "party-gone",
            buildId: "web-42",
            region: "ca-central-1",
          }),
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/remove") && body?.playerSessionId) removed.push(body.playerSessionId);
      return new Response(null, { status: 204 });
    });
    const { app, rooms } = await createServer({
      persistence: new CompletedTestPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      publicQuickPlay: true,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await connect(`ws://127.0.0.1:${address.port}/ws`);
    client.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-gone",
      name: "Gone",
      playerSessionId: "psess-gone",
    }));
    await acceptEntered;
    client.close();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    releaseAccept();

    await vi.waitFor(() => expect(removed).toEqual(["psess-gone"]));
    expect(rooms.join("A2BC")?.size ?? 0).toBe(0);
    await app.close();
  });

  it("does not create a ghost member when the socket closes during identity lookup", async () => {
    process.env.NODE_ENV = "test";
    let markIdentityEntered!: () => void;
    let releaseIdentity!: () => void;
    const identityEntered = new Promise<void>((resolve) => { markIdentityEntered = resolve; });
    const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    class DeferredIdentityPersistence extends CompletedTestPersistence {
      override async resolveOrRegisterPlayer(token: string, offeredName: string) {
        markIdentityEntered();
        await identityGate;
        return super.resolveOrRegisterPlayer(token, offeredName);
      }
    }
    const removed: string[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { playerSessionId?: string } : undefined;
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-public",
          GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        return new Response(JSON.stringify({
          playerId: "p-token-identity",
          playerData: JSON.stringify({
            mode: "public-hot-arena",
            arenaId: "A2BC",
            partyId: "party-identity",
            buildId: "web-42",
            region: "ca-central-1",
          }),
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/remove") && body?.playerSessionId) removed.push(body.playerSessionId);
      return new Response(null, { status: 204 });
    });
    const { app, rooms } = await createServer({
      persistence: new DeferredIdentityPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      publicQuickPlay: true,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      playerSessionReconnectMs: 0,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await connect(`ws://127.0.0.1:${address.port}/ws`);
    client.send(JSON.stringify({
      type: "quickPlayHello",
      token: "token-identity",
      name: "Identity",
      playerSessionId: "psess-identity",
    }));
    await identityEntered;
    client.close();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    releaseIdentity();

    await vi.waitFor(() => expect(removed).toEqual(["psess-identity"]));
    expect(rooms.join("A2BC")?.size ?? 0).toBe(0);
    await app.close();
  });

  it("rejects a reconnect once exact reservation removal has begun", async () => {
    process.env.NODE_ENV = "test";
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/session")) {
        return new Response(JSON.stringify({
          GameSessionId: "session-1",
          GameProperties: { roomCode: "A2BC" },
        }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/accept")) {
        return new Response(JSON.stringify({ playerId: "p-token-expire" }), { status: 200 });
      }
      if (url.endsWith("/v1/player-sessions/remove")) await removalGate;
      return new Response(null, { status: 204 });
    });
    const { app } = await createServer({
      persistence: new CompletedTestPersistence(),
      gameLift: new GameLiftSessionGate({ fetch: request }),
      playerSessionReconnectMs: 0,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const first = await connect(url);
    const hello = JSON.stringify({
      type: "hello",
      token: "token-expire",
      name: "Expire",
      roomCode: "A2BC",
      playerSessionId: "psess-expire",
    });
    first.send(hello);
    await waitForMessage(first, "welcome");
    first.close();
    await new Promise<void>((resolve) => first.once("close", () => resolve()));
    await vi.waitFor(() => expect(request.mock.calls.filter(([input]) => String(input).endsWith("/v1/player-sessions/remove"))).toHaveLength(1));

    const late = await connect(url);
    late.send(hello);
    expect(await waitForMessage(late, "err")).toMatchObject({ code: "player_session_expired" });
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/v1/player-sessions/accept"))).toHaveLength(1);

    releaseRemoval();
    if (late.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => late.once("close", () => resolve()));
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
