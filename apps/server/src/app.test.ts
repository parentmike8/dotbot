import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";
import { NoopPersistence } from "./db";

type Inbox = {
  ws: WebSocket;
  messages: ServerMessage[];
  send(message: ClientMessage): void;
  waitFor<T extends ServerMessage["type"]>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { type: T }>>;
};

const clients: WebSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe("multiplayer server", () => {
  it("runs extraction, spectator streams, AI events, timeout, and match end authoritatively", async () => {
    process.env.NODE_ENV = "test";
    const { app } = await createServer({
      // This suite tests realtime simulation behavior, not Postgres. Keep it
      // independent from an ambient DATABASE_URL used by persistence tests.
      databaseUrl: null,
      countdownMs: 0,
      config: {
        botRadius: 5,
        botSpeed: 4000,
        coverDurationMs: 100,
        damageSpeed: 99_999,
        extractionDurationMs: 100,
        baySlots: 1,
        holdSlots: 0,
        maxShields: 30,
        playerSpeed: 1000,
        runDurationMs: 2500,
      },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000016",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;

    const a = await connect(url);
    expect(a.ws.extensions).toContain("permessage-deflate");
    a.send({ type: "hello", token: "token-a", name: "Alice", roomCode: "" });
    const welcomeA = await a.waitFor("welcome");
    expect(welcomeA.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);

    const b = await connect(url);
    b.send({ type: "hello", token: "token-b", name: "Bob", roomCode: welcomeA.roomCode });
    const welcomeB = await b.waitFor("welcome");
    expect(welcomeB.members).toHaveLength(2);

    a.send({ type: "startMatch" });
    const [startA, startB] = await Promise.all([a.waitFor("matchStart", 10_000), b.waitFor("matchStart", 10_000)]);
    expect(startA.yourBotId).not.toBe(startB.yourBotId);
    expect(startA.meta.some((meta) => meta.isAmbient)).toBe(true);
    expect(startA.endTick).toBe(150);

    const firstA = await a.waitFor("snap");
    expect(firstA.bots.find((bot) => bot.i === startA.yourBotId)?.b?.filter(Boolean)).toHaveLength(1);

    // The deterministic insertion test seed puts Alpha at WEST GATE. Enter
    // the Main St corridor, move east beyond the depot wall, then south into
    // the 910..1020 x 1150..1260 extraction rectangle. The east target is set
    // short of the pad's centre on purpose: the drive loop polls every 33ms, so
    // the bot coasts roughly 56 units past whatever it is told to stop at.
    a.send({ type: "input", seq: 1, move: [0, 1], dash: false });
    await waitForBotPosition(a, startA.yourBotId, ([, y]) => y >= 948);
    // Lane at 950, not 920: street trees now collide, and their canopies occupy
    // y 862..898 in the south footway's furniture strip, so 920 is 2 units inside
    // them. 950 keeps a bot's full radius clear of the kerb-side planting.
    const seqAfterLane = await driveEastAlongLane(a, startA.yourBotId, 950, 910, 1);
    // Then steer onto the pad instead of coasting into it. Coasting depended on
    // how often the 33ms poll loop actually ran, so under full-suite load the bot
    // could sail straight past a 110-wide rectangle — a flake with nothing to do
    // with the behaviour under test.
    await steerTo(a, startA.yourBotId, { x: 965, y: 1205 }, seqAfterLane + 1);

    const runOverA = await a.waitFor("runOver", 5000);
    expect(runOverA).toEqual({ type: "runOver", reason: "extracted", keptItems: ["h"], lostItems: [], learnedBlueprints: [] });

    const bSnapshotsAtExtraction = b.messages.filter((message) => message.type === "snap").length;
    await delay(250);
    expect(b.messages.filter((message) => message.type === "snap").length).toBeGreaterThan(bSnapshotsAtExtraction);
    expect(a.messages.filter((message) => message.type === "snap").length).toBeGreaterThan(1);

    const runOverB = await b.waitFor("runOver", 7000);
    expect(runOverB).toMatchObject({ type: "runOver", reason: "timeout", keptItems: [] });
    const [endA, endB] = await Promise.all([a.waitFor("matchEnd"), b.waitFor("matchEnd")]);
    expect(endA.reason).toBe("timeout");
    expect(endB.reason).toBe("timeout");

    const events = a.messages
      .filter((message): message is Extract<ServerMessage, { type: "ev" }> => message.type === "ev")
      .flatMap((message) => message.events);
    const everVisible = new Set(a.messages
      .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
      .flatMap((message) => message.bots.map((bot) => bot.i)));
    const squadByBot = new Map(startA.meta.map((entry) => [entry.id, entry.squadId]));
    expect(events.every((event) =>
      everVisible.has(event.botId)
        || squadByBot.get(event.botId) === "alpha"
        || ("byBotId" in event && event.byBotId !== undefined
          && (everVisible.has(event.byBotId) || squadByBot.get(event.byBotId) === "alpha")),
    )).toBe(true);
    expect(a.messages.filter((message) => message.type === "runOver")).toEqual([runOverA]);
    const finalSnap = a.messages.filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap").at(-1)!;
    expect(Math.abs(finalSnap.tick - startA.endTick)).toBeLessThanOrEqual(2);

    a.ws.close();
    b.ws.close();
    await Promise.all([onceClosed(a.ws), onceClosed(b.ws)]);
    await app.close();
  }, 20_000);

  it("preserves hello admission order when identity lookup is slow", async () => {
    let releaseIdentity: () => void = () => {};
    const identityGate = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    class DelayedIdentityPersistence extends NoopPersistence {
      override async resolveOrRegisterPlayer(token: string, offeredName: string) {
        await identityGate;
        return super.resolveOrRegisterPlayer(token, offeredName);
      }
    }

    const { app } = await createServer({
      persistence: new DelayedIdentityPersistence(),
      aiWingmates: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await connect(`ws://127.0.0.1:${address.port}/ws`);

    try {
      client.send({ type: "hello", token: "slow-identity-token", name: "Ada", roomCode: "" });
      client.send({ type: "joinSquad", squadId: "crew-3" });
      await delay(25);
      expect(client.messages).toEqual([]);

      releaseIdentity();
      await client.waitFor("welcome");
      await delay(25);
      expect(client.messages.filter((message) => message.type === "err")).toEqual([]);
    } finally {
      releaseIdentity();
      client.ws.close();
      await onceClosed(client.ws);
      await app.close();
    }
  });
});

async function connect(url: string): Promise<Inbox> {
  const ws = new WebSocket(url);
  clients.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const messages: ServerMessage[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  return {
    ws,
    messages,
    send(message) { ws.send(JSON.stringify(message)); },
    async waitFor(type, timeoutMs = 3000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const message = messages.find((candidate) => candidate.type === type);
        if (message) return message as never;
        await delay(5);
      }
      throw new Error(`Timed out waiting for ${type}; saw ${messages.map((message) => message.type).join(",")}`);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drives along a horizontal lane, correcting latitude each input frame —
 * street furniture protrudes into Main St, so a fixed heading drifts into
 * face-blocks that the kinematic model (correctly) does not squeeze past. */
async function driveEastAlongLane(
  inbox: Inbox,
  botId: string,
  laneY: number,
  untilX: number,
  seqStart: number,
): Promise<number> {
  let seq = seqStart;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const latest = inbox.messages
      .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
      .at(-1);
    const position = latest?.bots.find((bot) => bot.i === botId)?.p;
    if (position && position[0] >= untilX) return seq;
    if (position) {
      const correction = Math.max(-0.6, Math.min(0.6, (laneY - position[1]) / 30));
      inbox.send({ type: "input", seq: ++seq, move: [1, correction], dash: false });
    }
    await delay(33);
  }
  throw new Error(`Timed out driving ${botId} east to ${untilX}`);
}

/** The bot's position in the most recent snapshot, if there is one. */
function latestPosition(inbox: Inbox, botId: string): [number, number] | undefined {
  return inbox.messages
    .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
    .at(-1)?.bots.find((bot) => bot.i === botId)?.p;
}

/**
 * Steer to a point and stop on it.
 *
 * Proportional on both axes, so an overshoot corrects itself rather than failing
 * the run. Only safe once the bot is already in open ground — it drives straight
 * at the target and will happily press into a wall between here and there.
 */
async function steerTo(
  inbox: Inbox,
  botId: string,
  target: { x: number; y: number },
  seqStart: number,
): Promise<number> {
  let seq = seqStart;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    // Arriving *is* the goal, and extraction can complete while we are still
    // nudging — at which point the bot stops being simulated and its position
    // freezes, so a loop that only watched distance would spin until it timed out.
    if (inbox.messages.some((message) => message.type === "runOver")) return seq;
    const position = latestPosition(inbox, botId);
    if (position) {
      const dx = target.x - position[0];
      const dy = target.y - position[1];
      if (Math.hypot(dx, dy) <= 18) {
        inbox.send({ type: "input", seq: ++seq, move: [0, 0], dash: false });
        return seq;
      }
      const scale = Math.max(Math.abs(dx), Math.abs(dy), 1);
      inbox.send({ type: "input", seq: ++seq, move: [dx / scale, dy / scale], dash: false });
    }
    await delay(33);
  }
  throw new Error(`Timed out steering ${botId} to ${target.x},${target.y}`);
}

async function waitForBotPosition(inbox: Inbox, botId: string, predicate: (position: [number, number]) => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const latest = inbox.messages
      .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
      .at(-1);
    const position = latest?.bots.find((bot) => bot.i === botId)?.p;
    if (position && predicate(position)) return;
    await delay(5);
  }
  const latest = inbox.messages
    .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
    .at(-1);
  throw new Error(`Timed out waiting for ${botId} position; last=${JSON.stringify(latest?.bots.find((bot) => bot.i === botId)?.p)}`);
}

function onceClosed(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", () => resolve()));
}
