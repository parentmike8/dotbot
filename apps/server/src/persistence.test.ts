import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import postgres, { type Sql } from "postgres";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";

const databaseUrl = process.env.DATABASE_URL;
let databaseAvailable = false;
let sql: Sql | null = null;

if (databaseUrl) {
  sql = postgres(databaseUrl, { connect_timeout: 2, max: 2 });
  try {
    await sql`select 1`;
    databaseAvailable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    sql = null;
  }
}

type Inbox = {
  ws: WebSocket;
  messages: ServerMessage[];
  send(message: ClientMessage): void;
  waitFor<T extends ServerMessage["type"]>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { type: T }>>;
};

describe.skipIf(!databaseAvailable)("Postgres persistence", () => {
  const clients: WebSocket[] = [];

  beforeAll(async () => {
    await sql!`truncate table hold_items, match_participants, match_results, learned_blueprints, players cascade`;
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await sql?.end({ timeout: 1 });
  });

  it("banks itemized extractions atomically and learns a blueprint on the third fragment", async () => {
    process.env.NODE_ENV = "test";
    const { app, rooms, persistence } = await createServer({
      databaseUrl,
      countdownMs: 0,
      config: {
        botSpeed: 4000,
        coverDurationMs: 100,
        damageSpeed: 99_999,
        extractionDurationMs: 100,
        baySlots: 2,
        holdSlots: 0,
        dotCaptureDurationMs: 100,
        maxShields: 30,
        playerSpeed: 1000,
        runDurationMs: 12_000,
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

    const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Persist Alice" } });
    expect(registration.statusCode).toBe(200);
    const account = registration.json<{ playerId: string; token: string }>();
    expect(account.token).toMatch(/^[a-f0-9]{32}$/);
    // One prior shelf fragment makes the two live extractions below fragments
    // two and three, so the second run crosses the learning threshold.
    await sql!`insert into hold_items (player_id, item_type, qty) values (${account.playerId}, 'b:shelf', 1)`;

    for (let run = 1; run <= 2; run += 1) {
      const alice = await connect(wsUrl, clients);
      alice.send({ type: "hello", token: account.token, name: "Ignored rename", roomCode: "" });
      const welcome = await alice.waitFor("welcome");
      expect(welcome.playerId).toBe(account.playerId);

      const bob = await connect(wsUrl, clients);
      bob.send({ type: "hello", token: `partner-${run}`, name: `Partner ${run}`, roomCode: welcome.roomCode });
      await bob.waitFor("welcome");

      alice.send({ type: "startMatch" });
      const [aliceStart] = await Promise.all([alice.waitFor("matchStart", 10_000), bob.waitFor("matchStart", 10_000)]);
      await alice.waitFor("snap");
      let seq = 0;
      alice.send({ type: "input", seq: ++seq, move: [0, 0], dash: false, useBay: 0 });
      await waitForInventory(alice, aliceStart.yourBotId, (bays) => bays.every((item) => item === null));
      const moveUntil = async (move: [number, number], predicate: (position: [number, number]) => boolean) => {
        alice.send({ type: "input", seq: ++seq, move, dash: false });
        await waitForBotPosition(alice, aliceStart.yourBotId, predicate);
      };
      await moveUntil([1, 0], ([x]) => x >= 340);
      await moveUntil([0, 1], ([, y]) => y >= 1080);
      await moveUntil([0.2, 0], ([x]) => x >= 438);
      seq = await steerBotTo(alice, aliceStart.yourBotId, { x: 440, y: 1270 }, seq);
      await waitForInventory(alice, aliceStart.yourBotId, (bays) => bays.includes("b:shelf"));

      await moveUntil([0, -1], ([, y]) => y <= 1080);
      await moveUntil([-1, 0], ([x]) => x <= 340);
      await moveUntil([0, -1], ([, y]) => y <= 920);
      await moveUntil([1, 0], ([x]) => x >= 1000);
      await moveUntil([0, 1], ([, y]) => y >= 1160);
      alice.send({ type: "input", seq: ++seq, move: [0, 0], dash: false });

      const extracted = await alice.waitFor("runOver", 5000);
      expect(extracted).toMatchObject({
        type: "runOver",
        reason: "extracted",
        lostItems: [],
        learnedBlueprints: run === 2 ? ["shelf"] : [],
      });
      expect(extracted.keptItems).toHaveLength(2);
      expect(extracted.keptItems).toEqual(expect.arrayContaining(["h", "b:shelf"]));
      expect(rooms.join(welcome.roomCode)?.phase).toBe("live");
      expect(alice.messages.some((message) => message.type === "matchEnd")).toBe(false);

      const [stored] = await sql!<Array<{ health: number; fragments: number; learned: number; participants: number }>>`
        select
          (select count(*)::int from hold_items where player_id = ${account.playerId} and item_type = 'h') as health,
          (select count(*)::int from hold_items where player_id = ${account.playerId} and item_type = 'b:shelf') as fragments,
          (select count(*)::int from learned_blueprints where player_id = ${account.playerId} and blueprint_id = 'shelf') as learned,
          (select count(*)::int from match_participants mp join match_results mr on mr.id = mp.match_id
            where mp.player_id = ${account.playerId} and mp.outcome = 'extracted' and mr.room_code = ${welcome.roomCode}) as participants
      `;
      expect(stored).toEqual({
        health: run,
        fragments: run === 1 ? 2 : 0,
        learned: run === 2 ? 1 : 0,
        participants: 1,
      });

      bob.send({ type: "leaveRun" });
      await alice.waitFor("matchEnd");
      alice.ws.close();
      bob.ws.close();
    }

    const profileResponse = await fetch(`${baseUrl}/api/profile`, { headers: { "x-device-token": account.token } });
    expect(profileResponse.status).toBe(200);
    const profile = await profileResponse.json() as {
      name: string;
      stash: Array<{ itemType: string; qty: number }>;
      learnedBlueprints: string[];
      recentManifests: Array<{ outcome: string; keptItems: string[] }>;
    };
    expect(profile.name).toBe("Persist Alice");
    expect(profile.stash).toEqual([{ itemType: "h", qty: 2 }]);
    expect(profile.learnedBlueprints).toEqual(["shelf"]);
    expect(profile.recentManifests.filter((manifest) => manifest.outcome === "extracted" && manifest.keptItems.includes("b:shelf"))).toHaveLength(2);

    const diedAccount = await persistence.registerPlayer("Died Player");
    const diedMatchId = crypto.randomUUID();
    await persistence.startMatch({ matchId: diedMatchId, roomCode: "DIED", mapId: "downtown", startedAt: new Date() });
    await persistence.recordOutcome({ matchId: diedMatchId, playerId: diedAccount.playerId, outcome: "died" });
    const [died] = await sql!<Array<{ outcome: string }>>`
      select outcome from match_participants where match_id = ${diedMatchId} and player_id = ${diedAccount.playerId}
    `;
    expect(died.outcome).toBe("died");
    const [diedStash] = await sql!<Array<{ count: number }>>`
      select count(*)::int as count from hold_items where player_id = ${diedAccount.playerId}
    `;
    expect(diedStash.count).toBe(0);

    await app.close();
  }, 30_000);
});

async function connect(url: string, clients: WebSocket[]): Promise<Inbox> {
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
  throw new Error(`Timed out waiting for ${botId}`);
}

async function waitForInventory(
  inbox: Inbox,
  botId: string,
  predicate: (bays: NonNullable<Extract<ServerMessage, { type: "snap" }>["bots"][number]["b"]>) => boolean,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const latest = inbox.messages
      .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
      .at(-1);
    const bays = latest?.bots.find((bot) => bot.i === botId)?.b;
    if (bays && predicate(bays)) return;
    await delay(5);
  }
  const latest = inbox.messages
    .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
    .at(-1);
  const bot = latest?.bots.find((candidate) => candidate.i === botId);
  const nearbyDots = bot ? latest?.dots.filter((dot) => Math.hypot(dot.position.x - bot.p[0], dot.position.y - bot.p[1]) < 80) : [];
  throw new Error(`Timed out waiting for ${botId} inventory; bot=${JSON.stringify(bot)} dots=${JSON.stringify(nearbyDots)}`);
}

async function steerBotTo(
  inbox: Inbox,
  botId: string,
  target: { x: number; y: number },
  initialSeq: number,
): Promise<number> {
  let seq = initialSeq;
  let settledAt: number | null = null;
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const latest = inbox.messages
      .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
      .at(-1);
    const position = latest?.bots.find((bot) => bot.i === botId)?.p;
    if (position) {
      const dx = target.x - position[0];
      const dy = target.y - position[1];
      if (Math.hypot(dx, dy) <= 8) {
        inbox.send({ type: "input", seq: ++seq, move: [0, 0], dash: false });
        settledAt ??= Date.now();
        if (Date.now() - settledAt >= 300) return seq;
      } else {
        settledAt = null;
        inbox.send({
          type: "input",
          seq: ++seq,
          move: [Math.max(-0.15, Math.min(0.15, dx / 100)), Math.max(-0.15, Math.min(0.15, dy / 100))],
          dash: false,
        });
      }
    }
    await delay(30);
  }
  throw new Error(`Timed out steering ${botId} to ${JSON.stringify(target)}`);
}

async function waitForDatabase(predicate: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for database write");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
