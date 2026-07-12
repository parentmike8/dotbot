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

  it("resolves accounts, commits extraction before run end, records outcomes, and accumulates profile stash", async () => {
    process.env.NODE_ENV = "test";
    const { app, rooms, persistence } = await createServer({
      databaseUrl,
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
      alice.send({ type: "input", seq: 1, move: [1, 0], dash: false });
      await waitForBotPosition(alice, aliceStart.yourBotId, ([x]) => x >= 1000);
      alice.send({ type: "input", seq: 2, move: [0, 1], dash: false });
      await waitForBotPosition(alice, aliceStart.yourBotId, ([, y]) => y >= 1160);
      alice.send({ type: "input", seq: 3, move: [0, 0], dash: false });

      const extracted = await alice.waitFor("runOver", 5000);
      expect(extracted).toEqual({ type: "runOver", reason: "extracted", keptItems: ["h"], lostItems: [], learnedBlueprints: [] });
      expect(rooms.join(welcome.roomCode)?.phase).toBe("live");
      expect(alice.messages.some((message) => message.type === "matchEnd")).toBe(false);

      const [stored] = await sql!<Array<{ stashRows: number; participants: number }>>`
        select
          (select count(*)::int from hold_items hi join match_results mr on mr.id = hi.acquired_match_id
            where hi.player_id = ${account.playerId} and mr.room_code = ${welcome.roomCode}) as "stashRows",
          (select count(*)::int from match_participants mp join match_results mr on mr.id = mp.match_id
            where mp.player_id = ${account.playerId} and mp.outcome = 'extracted' and mr.room_code = ${welcome.roomCode}) as participants
      `;
      expect(stored).toEqual({ stashRows: 1, participants: 1 });

      const bobResult = await bob.waitFor("runOver", 7000);
      expect(bobResult.reason).toBe("timeout");
      await alice.waitFor("matchEnd");
      await waitForDatabase(async () => {
        const [row] = await sql!<Array<{ count: number }>>`
          select count(*)::int as count from match_participants mp join match_results mr on mr.id = mp.match_id
          where mr.room_code = ${welcome.roomCode} and mp.outcome = 'timeout'
        `;
        return row.count === 1;
      });
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
    expect(profile.stash).toContainEqual({ itemType: "h", qty: 2 });
    expect(profile.learnedBlueprints).toEqual([]);
    expect(profile.recentManifests.filter((manifest) => manifest.outcome === "extracted" && manifest.keptItems.join() === "h")).toHaveLength(2);

    const diedAccount = await persistence.registerPlayer("Died Player");
    const diedMatchId = crypto.randomUUID();
    await persistence.startMatch({ matchId: diedMatchId, roomCode: "DIED", mapId: "downtown", startedAt: new Date() });
    await persistence.recordOutcome({ matchId: diedMatchId, playerId: diedAccount.playerId, outcome: "died" });
    const [died] = await sql!<Array<{ outcome: string }>>`
      select outcome from match_participants where match_id = ${diedMatchId} and player_id = ${diedAccount.playerId}
    `;
    expect(died.outcome).toBe("died");

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
