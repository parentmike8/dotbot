/**
 * Scripted playtest harness. Boots the real server in-process (DB mode),
 * drives real websocket clients through pacing, combat, and load scenarios,
 * and prints a structured report. Run from apps/server:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55432/dotbot \
 *     npx tsx src/playtest/harness.ts
 *
 * This is measurement tooling, not a test suite: it uses PRODUCTION default
 * config wherever the number being measured is a feel/pacing number.
 */
import WebSocket from "ws";
import postgres from "postgres";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createServer } from "../app";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required (55432 dotbot db)");
const sql = postgres(databaseUrl, { max: 2 });

type Inbox = {
  ws: WebSocket;
  messages: ServerMessage[];
  bytes: { total: number; bySnap: number; snapCount: number; matchStart: number };
  send(message: ClientMessage): void;
  waitFor<T extends ServerMessage["type"]>(type: T, timeoutMs?: number, after?: number): Promise<Extract<ServerMessage, { type: T }>>;
  close(): void;
};

const report: Record<string, unknown> = {};

async function connect(url: string): Promise<Inbox> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const messages: ServerMessage[] = [];
  const bytes = { total: 0, bySnap: 0, snapCount: 0, matchStart: 0 };
  ws.on("message", (data) => {
    const text = data.toString();
    bytes.total += text.length;
    const message = JSON.parse(text) as ServerMessage;
    if (message.type === "snap") { bytes.bySnap += text.length; bytes.snapCount += 1; }
    if (message.type === "matchStart") bytes.matchStart = text.length;
    messages.push(message);
  });
  return {
    ws, messages, bytes,
    send(message) { ws.send(JSON.stringify(message)); },
    async waitFor(type, timeoutMs = 8000, after = 0) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const message = messages.slice(after).find((candidate) => candidate.type === type);
        if (message) return message as never;
        await delay(10);
      }
      throw new Error(`waitFor(${type}) timed out; saw ${messages.slice(-6).map((m) => m.type).join(",")}`);
    },
    close() { ws.close(); },
  };
}

function latestSnap(inbox: Inbox) {
  for (let index = inbox.messages.length - 1; index >= 0; index -= 1) {
    const message = inbox.messages[index];
    if (message.type === "snap") return message;
  }
  return null;
}
function botOf(inbox: Inbox, botId: string) {
  return latestSnap(inbox)?.bots.find((bot) => bot.i === botId) ?? null;
}
function events(inbox: Inbox) {
  return inbox.messages.flatMap((message) => (message.type === "ev" ? message.events : []));
}
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Proportional steer toward a target; ends on arrival, doneWhen, or timeout. */
async function steer(
  inbox: Inbox, botId: string, target: { x: number; y: number }, seqRef: { seq: number },
  options: { timeoutMs?: number; arriveWithin?: number; doneWhen?: () => boolean; dashWhenClose?: boolean } = {},
): Promise<boolean> {
  const { timeoutMs = 30_000, arriveWithin = 14, doneWhen, dashWhenClose } = options;
  const started = Date.now();
  let axisFlip = false;
  let lastPosition: [number, number] | null = null;
  let stalledIterations = 0;
  while (Date.now() - started < timeoutMs) {
    if (doneWhen?.()) { inbox.send({ type: "input", seq: ++seqRef.seq, move: [0, 0], dash: false }); return true; }
    const bot = botOf(inbox, botId);
    if (bot && (bot.s ?? "alive") === "alive") {
      const dx = target.x - bot.p[0];
      const dy = target.y - bot.p[1];
      const dist = Math.hypot(dx, dy);
      if (dist <= arriveWithin && !doneWhen) { inbox.send({ type: "input", seq: ++seqRef.seq, move: [0, 0], dash: false }); return true; }
      // Axis-priority movement (streets are axis-aligned) with stall
      // detection: a wall on one axis flips the walk to the other, which
      // self-solves every L-shaped street route without pathfinding.
      if (lastPosition && Math.hypot(bot.p[0] - lastPosition[0], bot.p[1] - lastPosition[1]) < 2) {
        stalledIterations += 1;
        if (stalledIterations > 30) { axisFlip = !axisFlip; stalledIterations = 0; }
      } else stalledIterations = 0;
      lastPosition = [bot.p[0], bot.p[1]];
      const xDone = Math.abs(dx) <= 6;
      const yDone = Math.abs(dy) <= 6;
      const useX = xDone ? false : yDone ? true : !axisFlip;
      // Decelerate near the target: at 230px/s a 20Hz snapshot moves ~11px,
      // which overshoots tight windows unless the approach slows down.
      const gain = Math.min(1, Math.max(0.2, dist / 90));
      const move: [number, number] = useX ? [Math.sign(dx) * gain, 0] : [0, Math.sign(dy) * gain];
      inbox.send({
        type: "input", seq: ++seqRef.seq,
        move,
        dash: Boolean(dashWhenClose && dist < 160),
      });
    }
    await delay(33);
  }
  return false;
}

async function registerPlayer(app: { inject: Function }, name: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name } });
  return response.json() as { playerId: string; token: string };
}

// ---------------------------------------------------------------------------
// Scenario 1 — pacing: default config, one scripted player runs the depot
// loot route and extracts. Every number here is production-config.
// ---------------------------------------------------------------------------
async function scenarioPacing() {
  const { app, persistence } = await createServer({
    databaseUrl,
    countdownMs: 0,
    aiWingmates: false,
    matchIdFactory: () => "00000000-0000-4000-8000-000000000016",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const wsUrl = `ws://127.0.0.1:${(address as { port: number }).port}/ws`;
  const account = await registerPlayer(app, "Pacer");

  const alice = await connect(wsUrl);
  alice.send({ type: "hello", token: account.token, name: "Pacer", roomCode: "" });
  const welcome = await alice.waitFor("welcome");
  const buddy = await connect(wsUrl);
  buddy.send({ type: "hello", token: "pacer-buddy", name: "Buddy", roomCode: welcome.roomCode });
  await buddy.waitFor("welcome");
  alice.send({ type: "startMatch" });
  const start = await alice.waitFor("matchStart", 15_000);
  await alice.waitFor("snap");
  const seqRef = { seq: 0 };
  const t0 = Date.now();
  const marks: Record<string, number> = {};

  const bays = () => botOf(alice, start.yourBotId)?.b ?? [];
  // Route: WEST GATE → Main St → depot dots → extraction pad (same legs the
  // integration test uses, at production speed).
  await steer(alice, start.yourBotId, { x: 300, y: 920 }, seqRef, { arriveWithin: 40 });
  await steer(alice, start.yourBotId, { x: 340, y: 1080 }, seqRef, { arriveWithin: 30 });
  await steer(alice, start.yourBotId, { x: 438, y: 1140 }, seqRef, { arriveWithin: 30 });
  marks.reachedDepotMs = Date.now() - t0;
  await steer(alice, start.yourBotId, { x: 440, y: 1270 }, seqRef, { doneWhen: () => bays().filter(Boolean).length >= 2, timeoutMs: 25_000 });
  marks.firstLootMs = Date.now() - t0;
  // Exit mirrors the inbound legs; hold x=450 to stay clear of the shelf
  // column (x380..406, clearance to bot center 430) on the way out.
  await steer(alice, start.yourBotId, { x: 450, y: 1260 }, seqRef, { arriveWithin: 16 });
  await steer(alice, start.yourBotId, { x: 450, y: 1100 }, seqRef, { arriveWithin: 30 });
  await steer(alice, start.yourBotId, { x: 340, y: 1080 }, seqRef, { arriveWithin: 30 });
  await steer(alice, start.yourBotId, { x: 340, y: 920 }, seqRef, { arriveWithin: 40 });
  await steer(alice, start.yourBotId, { x: 1000, y: 920 }, seqRef, { arriveWithin: 40 });
  // Aim at the depot pad from map data, not a guessed coordinate.
  const pad = start.map.extractionPoints.find((point) => point.id === "extract-depot")!.rect;
  const padCenter = { x: pad.x + pad.w / 2, y: pad.y + pad.h / 2 };
  await steer(alice, start.yourBotId, padCenter, seqRef, { arriveWithin: 45 });
  alice.send({ type: "input", seq: ++seqRef.seq, move: [0, 0], dash: false });
  let over: Extract<ServerMessage, { type: "runOver" }> | null = null;
  try {
    over = await alice.waitFor("runOver", 30_000);
    marks.extractedMs = Date.now() - t0;
  } catch {
    const bot = botOf(alice, start.yourBotId);
    marks.extractionStall = 1;
    report.pacingDebug = { finalPosition: bot?.p, carried: bot?.c, pad };
  }

  report.pacing = {
    insertion: start.insertionName,
    runTimerMs: start.config.runDurationMs,
    playerSpeed: start.config.playerSpeed,
    dashCooldownMs: start.config.dashCooldownMs,
    ...marks,
    outcome: over?.reason ?? "none",
    keptItems: over?.keptItems ?? [],
    shareOfTimerUsed: over ? Number((marks.extractedMs / start.config.runDurationMs).toFixed(3)) : null,
  };
  alice.close(); buddy.close();
  await app.close(); await persistence.close();
}

// ---------------------------------------------------------------------------
// Scenario 2 — combat, plea, loot-then-revive, mines. Production combat
// numbers; the only scripted liberties are deterministic ids and routes.
// ---------------------------------------------------------------------------
async function scenarioCombat() {
  const { app, persistence, rooms } = await createServer({
    databaseUrl,
    countdownMs: 0,
    aiWingmates: false,
    // This id assigns alpha → EAST GATE and bravo → WEST GATE: both squads on
    // the same y=760 street line, so every combat leg is a straight walk.
    matchIdFactory: () => "00000000-0000-4000-8000-000000000009",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = (address as { port: number }).port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const attacker = await registerPlayer(app, "Attacker");
  // The attacker carries mines: two banked, both loaded.
  await sql`insert into hold_items (player_id, item_type, qty) values (${attacker.playerId}, 'm', 2)`;
  const loadoutResponse = await fetch(`http://127.0.0.1:${port}/api/base/loadout`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": attacker.token },
    body: JSON.stringify({ loadout: ["m", "m"] }),
  });
  if (!loadoutResponse.ok) throw new Error(`mine loadout failed: ${loadoutResponse.status}`);

  const atk = await connect(wsUrl);
  atk.send({ type: "hello", token: attacker.token, name: "Attacker", roomCode: "" });
  const welcome = await atk.waitFor("welcome");
  const vic = await connect(wsUrl);
  vic.send({ type: "hello", token: "victim-token", name: "Victim", roomCode: welcome.roomCode });
  await vic.waitFor("welcome");
  vic.send({ type: "joinSquad", squadId: "bravo" });
  await delay(150);
  atk.send({ type: "startMatch" });
  const [atkStart, vicStart] = await Promise.all([atk.waitFor("matchStart", 15_000), vic.waitFor("matchStart", 15_000)]);
  await Promise.all([atk.waitFor("snap"), vic.waitFor("snap")]);
  // Sterile arena: remove ambient greys so verb/mine measurements are pure
  // human-vs-human (grey interference measured separately in scenario 1/3).
  const arena = rooms.join(welcome.roomCode) as unknown as { simulation?: { getSnapshot(): { bots: Array<{ id: string }> }; removeBot(id: string): void } };
  for (const bot of arena.simulation?.getSnapshot().bots ?? []) {
    if (!bot.id.startsWith("human")) arena.simulation?.removeBot(bot.id);
  }
  const atkSeq = { seq: 0 };
  const vicSeq = { seq: 0 };
  // Main St (y≈920) is verified open ground: the duel happens there.
  const meeting = { x: 620, y: 920 };
  const t0 = Date.now();

  // The victim walks to the meeting point and HOLDS STILL: a landed dash
  // needs relative speed above damageSpeed, which a fleeing target denies —
  // a stationary target measures clean time-to-down per plate.
  const vicDowned = () => botOf(atk, vicStart.yourBotId)?.s === "downed";
  const vicPath = (async () => {
    const arrived = await steer(vic, vicStart.yourBotId, meeting, vicSeq, { arriveWithin: 20, timeoutMs: 60_000 });
    report.combatDebug = { victimReachedMeeting: arrived, victimAt: botOf(vic, vicStart.yourBotId)?.p };
  })();
  const atkPath = (async () => {
    await steer(atk, atkStart.yourBotId, { x: meeting.x + 220, y: meeting.y }, atkSeq, { arriveWithin: 30, timeoutMs: 60_000 });
  })();
  await Promise.all([vicPath, atkPath]);
  const duelStart = Date.now();
  const dashLog: number[] = [];
  while (!vicDowned() && Date.now() - duelStart < 60_000) {
    const target = botOf(atk, vicStart.yourBotId);
    const self = botOf(atk, atkStart.yourBotId);
    if (target && self) {
      const dist = Math.hypot(target.p[0] - self.p[0], target.p[1] - self.p[1]);
      if (dist > 240) {
        // Reposition for a run-up, then dash through the target.
        await steer(atk, atkStart.yourBotId, { x: target.p[0] - 200, y: target.p[1] }, atkSeq, { arriveWithin: 24, timeoutMs: 8000 });
      }
      dashLog.push(Date.now() - duelStart);
      const chaseEnd = Date.now() + 1400;
      while (Date.now() < chaseEnd && !vicDowned()) {
        const live = botOf(atk, vicStart.yourBotId);
        const me = botOf(atk, atkStart.yourBotId);
        if (live && me) {
          const dx = live.p[0] - me.p[0];
          const dy = live.p[1] - me.p[1];
          const norm = Math.max(Math.hypot(dx, dy), 1);
          atk.send({ type: "input", seq: ++atkSeq.seq, move: [dx / norm, dy / norm], dash: true });
        }
        await delay(33);
      }
    } else await delay(100);
  }
  const downedAtMs = Date.now() - duelStart;
  const downed = vicDowned();
  (report.combatDebug as Record<string, unknown>).dashAttempts = dashLog.length;

  let pleaSeen = false;
  let reviveResult: Record<string, unknown> = {};
  if (downed) {
    const evBaseline = atk.messages.length;
    vic.send({ type: "input", seq: ++vicSeq.seq, move: [0, 0], dash: false, plea: true });
    const pleaDeadline = Date.now() + 4000;
    while (Date.now() < pleaDeadline && !pleaSeen) {
      pleaSeen = atk.messages.slice(evBaseline).some((message) => message.type === "ev" && message.events.some((event) => event.type === "plea"));
      await delay(25);
    }

    // Loot-then-revive over the body (production 4500ms channel). Coverage
    // needs the actor's center inside coverCenterTolerance (12px), so track
    // the body until inside 8px, then hold still with the verb latched.
    const channelStart = Date.now();
    const coverageSamples: unknown[] = [];
    let lastSample = 0;
    while (botOf(atk, vicStart.yourBotId)?.s === "downed" && Date.now() - channelStart < 20_000) {
      if (Date.now() - lastSample > 2000) {
        lastSample = Date.now();
        const snap = latestSnap(atk);
        const room = rooms.join(welcome.roomCode) as unknown as { simulation?: { getSnapshot(): { bots: Array<{ id: string; position: { x: number; y: number }; state: string }> } } };
        const truth = room?.simulation?.getSnapshot().bots.filter((bot) => bot.id.startsWith("human")).map((bot) => ({ id: bot.id.slice(0, 12), at: [Math.round(bot.position.x), Math.round(bot.position.y)], s: bot.state }));
        const sim = room?.simulation as unknown as {
          inputs?: Map<string, unknown>;
          coverages?: Map<string, unknown>;
        };
        const bodyInfo = {
          atkStoredInput: sim?.inputs?.get(`human-${attacker.playerId}`) ?? null,
          coverageEntries: sim?.coverages ? [...sim.coverages.entries()] : null,
        };
        coverageSamples.push({
          coverages: snap?.coverages,
          atkAt: botOf(atk, atkStart.yourBotId)?.p,
          vicAt: botOf(atk, vicStart.yourBotId)?.p,
          atkState: botOf(atk, atkStart.yourBotId)?.s,
          simTruth: truth,
          bodyInfo,
        });
      }
      const body = botOf(atk, vicStart.yourBotId)!;
      const self = botOf(atk, atkStart.yourBotId)!;
      const dx = body.p[0] - self.p[0];
      const dy = body.p[1] - self.p[1];
      const dist = Math.hypot(dx, dy);
      // Direct-vector firm approach (matches the verified sim-level probe):
      // coverage tolerates 37px, so press in decisively rather than orbiting.
      const norm = Math.max(dist, 1);
      atk.send({
        type: "input", seq: ++atkSeq.seq,
        move: dist > 6 ? [(dx / norm) * 0.5, (dy / norm) * 0.5] : [0, 0],
        dash: false,
        downedVerb: "lootThenRevive",
      });
      await delay(33);
    }
    const revived = botOf(atk, vicStart.yourBotId);
    reviveResult = {
      channelObservedMs: Date.now() - channelStart,
      victimStateAfter: revived?.s,
      victimPlatesAfter: revived?.sh,
      attackerCarriedAfter: botOf(atk, atkStart.yourBotId)?.c,
      coverageSamples,
    };
  }

  // Mines: place on the known-walkable gate street, then retreat. The victim
  // loiters inside sense radius, then steps onto the first mine.
  await steer(atk, atkStart.yourBotId, { x: 460, y: 920 }, atkSeq, { arriveWithin: 10, timeoutMs: 30_000 });
  const mine1At = botOf(atk, atkStart.yourBotId)!.p;
  atk.send({ type: "input", seq: ++atkSeq.seq, move: [0, 0], dash: false, useBay: 0 });
  await delay(300);
  await steer(atk, atkStart.yourBotId, { x: 520, y: 920 }, atkSeq, { arriveWithin: 10, timeoutMs: 12_000 });
  atk.send({ type: "input", seq: ++atkSeq.seq, move: [0, 0], dash: false, useBay: 1 });
  await delay(300);
  const minePos = { x: mine1At[0], y: mine1At[1] };
  await steer(atk, atkStart.yourBotId, { x: 900, y: 920 }, atkSeq, { arriveWithin: 40, timeoutMs: 20_000 });

  const sensorBaseline = events(atk).filter((event) => event.type === "mineSensor").length;
  const loiterReached = await steer(vic, vicStart.yourBotId, { x: minePos.x + 170, y: minePos.y }, vicSeq, { arriveWithin: 24, timeoutMs: 25_000 });
  await delay(4500);
  const sensorPings = events(atk).filter((event) => event.type === "mineSensor").length - sensorBaseline;
  const vicPlatesBefore = botOf(vic, vicStart.yourBotId)?.sh?.filter((plate) => plate > 0.6).length;
  const steppedOn = await steer(vic, vicStart.yourBotId, minePos, vicSeq, { arriveWithin: 5, timeoutMs: 15_000 });
  await delay(800);
  const vicAfter = botOf(vic, vicStart.yourBotId);
  const minesVisibleToVictim = latestSnap(vic)?.mines ?? [];
  (report.combatDebug as Record<string, unknown>).mineLegs = { loiterReached, steppedOn, minePos, victimAt: vicAfter?.p };

  report.combat = {
    downed,
    timeToDownMs: downed ? downedAtMs : null,
    pleaReachedEnemySquad: pleaSeen,
    lootThenRevive: reviveResult,
    mines: {
      sensorPingsDuringLoiter: sensorPings,
      victimIntactPlatesBefore: vicPlatesBefore,
      victimPlatesAfterMine: vicAfter?.sh,
      victimStateAfterMine: vicAfter?.s,
      victimSawPresentation: minesVisibleToVictim.map((mine) => (mine as { presentation?: string }).presentation),
    },
  };
  atk.close(); vic.close();
  await app.close(); await persistence.close();
}

// ---------------------------------------------------------------------------
// Scenario 3 — load: six humans by default, three squads, everyone moving.
// ---------------------------------------------------------------------------
async function scenarioLoad() {
  const { app, persistence } = await createServer({ databaseUrl, countdownMs: 0 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = (address as { port: number }).port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const host = await connect(wsUrl);
  host.send({ type: "hello", token: "load-0", name: "Load 0", roomCode: "" });
  const welcome = await host.waitFor("welcome");
  const clients: Inbox[] = [host];
  const squads = ["alpha", "alpha", "bravo", "bravo", "crew-3", "crew-3"];
  const playerCount = Math.max(2, Math.min(6, Number(process.env.PLAYERS ?? 6)));
  for (let index = 1; index < playerCount; index += 1) {
    const client = await connect(wsUrl);
    client.send({ type: "hello", token: `load-${index}`, name: `Load ${index}`, roomCode: welcome.roomCode });
    await client.waitFor("welcome");
    clients.push(client);
  }
  clients.forEach((client, index) => client.send({ type: "joinSquad", squadId: squads[index] as never }));
  await delay(300);
  host.send({ type: "startMatch" });
  const starts = await Promise.all(clients.map((client) => client.waitFor("matchStart", 20_000)));
  await Promise.all(clients.map((client) => client.waitFor("snap")));

  // Reset byte counters after the (one-time) matchStart payload.
  const matchStartBytes = clients.map((client) => client.bytes.matchStart);
  clients.forEach((client) => { client.bytes.total = 0; client.bytes.bySnap = 0; client.bytes.snapCount = 0; });

  const seqs = clients.map(() => ({ seq: 0 }));
  const measureMs = 45_000;
  const t0 = Date.now();
  const movers = clients.map(async (client, index) => {
    while (Date.now() - t0 < measureMs) {
      const angle = (Date.now() / 900) + index;
      client.send({
        type: "input", seq: ++seqs[index].seq,
        move: [Math.cos(angle), Math.sin(angle)],
        dash: Date.now() % 4000 < 40,
      });
      await delay(33);
    }
    client.send({ type: "input", seq: ++seqs[index].seq, move: [0, 0], dash: false });
  });
  await Promise.all(movers);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
  report.load = {
    players: playerCount,
    matchStartPayloadBytes: matchStartBytes,
    perClientBytesPerSecond: clients.map((client) => Math.round(client.bytes.total / (measureMs / 1000))),
    perClientSnapBytesPerSecond: clients.map((client) => Math.round(client.bytes.bySnap / (measureMs / 1000))),
    avgSnapBytes: clients.map((client) => (client.bytes.snapCount ? Math.round(client.bytes.bySnap / client.bytes.snapCount) : 0)),
    snapRateHz: clients.map((client) => Number((client.bytes.snapCount / (measureMs / 1000)).toFixed(1))),
    health,
    insertions: starts.map((start) => start.insertionName),
  };
  clients.forEach((client) => client.close());
  await app.close(); await persistence.close();
}

process.env.NODE_ENV = "test";
const only = process.env.SCENARIO;
const scenarios: Array<[string, () => Promise<void>]> = ([
  ["pacing", scenarioPacing],
  ["combat", scenarioCombat],
  ["load", scenarioLoad],
] as Array<[string, () => Promise<void>]>).filter(([name]) => !only || name === only);
for (const [name, run] of scenarios) {
  const started = Date.now();
  try {
    await run();
    console.error(`[harness] ${name} done in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (error) {
    report[name] = { error: error instanceof Error ? error.message : String(error) };
    console.error(`[harness] ${name} FAILED: ${error instanceof Error ? error.message : error}`);
  }
}
await sql.end({ timeout: 1 });
console.log(JSON.stringify(report, null, 2));
process.exit(0);
