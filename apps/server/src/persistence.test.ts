import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import postgres, { type Sql } from "postgres";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";
import { Room, type RoomPeer } from "./Room";
import { starterBaseLayout } from "@dotbot/game/content/base";
import type { BaseLayout } from "@dotbot/game/types";

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
    const deterministicMatchIds = [
      "00000000-0000-4000-8000-000000000016",
      "00000000-0000-4000-8000-000000000021",
    ];
    const { app, rooms, persistence } = await createServer({
      databaseUrl,
      countdownMs: 0,
      // Scripted pickups must have no AI rivals contesting map dots.
      aiWingmates: false,
      matchIdFactory: () => deterministicMatchIds.shift() ?? crypto.randomUUID(),
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
        // Generous: the route legs are position-gated, so extra budget costs
        // nothing when healthy but absorbs full-workspace test load.
        runDurationMs: 25_000,
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
      const moveUntil = async (move: [number, number], predicate: (position: [number, number]) => boolean) => {
        alice.send({ type: "input", seq: ++seq, move, dash: false });
        await waitForBotPosition(alice, aliceStart.yourBotId, predicate);
      };
      // Deterministic seeds put Alpha at WEST GATE; enter Main St before the
      // established depot fragment route.
      await moveUntil([0, 1], ([, y]) => y >= 920);
      await moveUntil([1, 0], ([x]) => x >= 340);
      // Settle in the clear strip between the top wall and the first column;
      // a coarse south predicate can overshoot into the column's radius.
      seq = await steerBotTo(alice, aliceStart.yourBotId, { x: 340, y: 1080 }, seq);
      await moveUntil([0.2, 0], ([x]) => x >= 438);
      // The health dot overlaps the blueprint approach. If health resolves
      // first, consume the original health to make room, then hold the same
      // settled position for the shelf fragment.
      seq = await steerBotTo(alice, aliceStart.yourBotId, { x: 440, y: 1270 }, seq, (bays) => bays.filter(Boolean).length === 2);
      if (!latestBays(alice, aliceStart.yourBotId)?.includes("b:shelf")) {
        alice.send({ type: "input", seq: ++seq, move: [0, 0], dash: false, useBay: 0 });
        await waitForBays(alice, aliceStart.yourBotId, (bays) => bays.filter(Boolean).length === 1);
        seq = await steerBotTo(alice, aliceStart.yourBotId, { x: 440, y: 1270 }, seq, (bays) => bays.includes("b:shelf"));
      }

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

  it("round-trips base layouts and treats loadouts as one-shot at-risk withdrawals", async () => {
    await sql!`truncate table base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app, persistence } = await createServer({
      databaseUrl,
      countdownMs: 0,
      aiWingmates: false,
      config: { runDurationMs: 30_000 },
    });
    const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Base Pilot" } });
    const account = registration.json<{ playerId: string; token: string }>();
    const headers = { "x-device-token": account.token };

    const seeded = await sql!<Array<{ count: number }>>`select count(*)::int as count from base_layouts where player_id = ${account.playerId}`;
    expect(seeded[0].count).toBe(Object.keys(starterBaseLayout).length);
    const initial = await app.inject({ method: "GET", url: "/api/base", headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<{ storageLinked: boolean; layout: BaseLayout }>().storageLinked).toBe(true);
    expect(initial.json<{ layout: BaseLayout }>().layout).toEqual(starterBaseLayout);
    expect(initial.json<{ shell: string }>().shell).toBe("workshop");
    expect(initial.json<{ insertionPreference: string | null }>().insertionPreference).toBeNull();
    const preferredInsertion = await app.inject({ method: "POST", url: "/api/base/insertion", headers, payload: { insertionPointId: "ne-park" } });
    expect(preferredInsertion.statusCode).toBe(200);
    expect(preferredInsertion.json<{ insertionPreference: string | null }>().insertionPreference).toBe("ne-park");
    expect((await app.inject({ method: "GET", url: "/api/base", headers })).json<{ insertionPreference: string | null }>().insertionPreference).toBe("ne-park");
    expect((await app.inject({ method: "POST", url: "/api/base/insertion", headers, payload: { insertionPointId: "nowhere" } })).statusCode).toBe(400);
    const clearedInsertion = await app.inject({ method: "POST", url: "/api/base/insertion", headers, payload: { insertionPointId: null } });
    expect(clearedInsertion.json<{ insertionPreference: string | null }>().insertionPreference).toBeNull();

    // Shell choice is cosmetic: it round-trips per player and never touches
    // the layout (identical slot roster across shells).
    const reshelled = await app.inject({ method: "POST", url: "/api/base/shell", headers, payload: { shell: "berths" } });
    expect(reshelled.statusCode).toBe(200);
    expect(reshelled.json<{ shell: string; layout: BaseLayout }>().shell).toBe("berths");
    expect(reshelled.json<{ layout: BaseLayout }>().layout).toEqual(starterBaseLayout);
    expect((await app.inject({ method: "GET", url: "/api/base", headers })).json<{ shell: string }>().shell).toBe("berths");
    expect((await app.inject({ method: "POST", url: "/api/base/shell", headers, payload: { shell: "mansion" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/base/shell", headers: { "x-device-token": "0".repeat(32) }, payload: { shell: "hangar" } })).statusCode).toBe(404);

    const movedLayout = { ...starterBaseLayout };
    delete movedLayout["wall-nw"];
    movedLayout["wall-west"] = "fabricator";
    const saved = await app.inject({ method: "POST", url: "/api/base/layout", headers, payload: { layout: movedLayout } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ layout: BaseLayout }>().layout).toEqual(movedLayout);
    expect((await app.inject({ method: "GET", url: "/api/base", headers })).json<{ layout: BaseLayout }>().layout).toEqual(movedLayout);
    expect((await app.inject({ method: "POST", url: "/api/base/layout", headers, payload: { layout: { mystery: "locker" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/base/layout", headers, payload: { layout: { "wall-n": "mystery" } } })).statusCode).toBe(400);

    await sql!`insert into hold_items (player_id, item_type, qty) values
      (${account.playerId}, 'h', 2), (${account.playerId}, 'r', 1), (${account.playerId}, 'b:shelf', 1)`;
    const withdrawn = await app.inject({ method: "POST", url: "/api/base/loadout", headers, payload: { loadout: ["h"] } });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json<{ loadout: string[] }>().loadout).toEqual(["h"]);
    expect(stashQty(withdrawn.json<{ stash: Array<{ itemType: string; qty: number }> }>().stash, "h")).toBe(1);

    const returned = await app.inject({ method: "POST", url: "/api/base/loadout", headers, payload: { loadout: [] } });
    expect(returned.statusCode).toBe(200);
    expect(returned.json<{ loadout: string[] }>().loadout).toEqual([]);
    expect(stashQty(returned.json<{ stash: Array<{ itemType: string; qty: number }> }>().stash, "h")).toBe(2);
    expect((await app.inject({ method: "POST", url: "/api/base/loadout", headers, payload: { loadout: ["b:shelf"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/base/loadout", headers, payload: { loadout: ["h", "h", "h"] } })).statusCode).toBe(409);
    const afterRollback = (await app.inject({ method: "GET", url: "/api/base", headers })).json<{ loadout: string[]; stash: Array<{ itemType: string; qty: number }> }>();
    expect(afterRollback.loadout).toEqual([]);
    expect(stashQty(afterRollback.stash, "h")).toBe(2);

    const radarLoadout = await app.inject({ method: "POST", url: "/api/base/loadout", headers, payload: { loadout: ["r"] } });
    expect(radarLoadout.statusCode).toBe(200);
    const extractedPeer = collectingPeer("extract-peer");
    const extractionRoom = new Room("LOAD", { countdownMs: 0, persistence, aiWingmates: false, config: { runDurationMs: 30_000 } });
    extractionRoom.join(extractedPeer.peer, account.token, "Base Pilot", account.playerId);
    extractionRoom.receive(account.playerId, { type: "startMatch" });
    await waitFor(() => extractionRoom.phase === "live");
    const extractionInternals = extractionRoom as unknown as {
      members: Map<string, { botId: string }>;
      simulation: { getSnapshot(): { bots: Array<{ id: string; squadId: string; bays: unknown[] }> } };
      processRunEvents(events: Array<{ type: "extracted"; botId: string; squadId: string; items: Array<{ kind: "powerup"; type: "radar" }> }>): void;
    };
    const extractionBotId = extractionInternals.members.get(account.playerId)!.botId;
    const extractionBot = extractionInternals.simulation.getSnapshot().bots.find((bot) => bot.id === extractionBotId)!;
    expect(extractionBot.bays[0]).toEqual({ kind: "powerup", type: "radar" });
    expect((await sql!<Array<{ loadout: unknown }>>`select loadout from players where id = ${account.playerId}`)[0].loadout).toEqual([]);
    extractionInternals.processRunEvents([{ type: "extracted", botId: extractionBotId, squadId: extractionBot.squadId, items: [{ kind: "powerup", type: "radar" }] }]);
    await waitFor(() => extractedPeer.messages.some((message) => message.type === "runOver"));
    expect(extractedPeer.messages.find((message) => message.type === "runOver")).toMatchObject({ reason: "extracted", keptItems: ["r"] });
    expect(Number((await sql!<Array<{ qty: number }>>`select coalesce(sum(qty), 0)::int as qty from hold_items where player_id = ${account.playerId} and item_type = 'r'`)[0].qty)).toBe(1);
    extractionRoom.dispose();

    expect((await app.inject({ method: "POST", url: "/api/base/loadout", headers, payload: { loadout: ["h"] } })).statusCode).toBe(200);
    const diedPeer = collectingPeer("died-peer");
    const diedRoom = new Room("LOSS", { countdownMs: 0, persistence, aiWingmates: false, config: { runDurationMs: 30_000 } });
    diedRoom.join(diedPeer.peer, account.token, "Base Pilot", account.playerId);
    diedRoom.receive(account.playerId, { type: "startMatch" });
    await waitFor(() => diedRoom.phase === "live");
    const diedInternals = diedRoom as unknown as {
      members: Map<string, { botId: string }>;
      simulation: { bots: Map<string, { state: string; shields: number }>; getSnapshot(): { bots: Array<{ id: string; bays: unknown[] }> } };
    };
    const diedBotId = diedInternals.members.get(account.playerId)!.botId;
    expect(diedInternals.simulation.getSnapshot().bots.find((bot) => bot.id === diedBotId)?.bays[0]).toEqual({ kind: "powerup", type: "health" });
    const diedBot = diedInternals.simulation.bots.get(diedBotId)!;
    diedBot.state = "downed";
    diedBot.shields = 0;
    diedRoom.receive(account.playerId, { type: "leaveRun" });
    await waitFor(() => diedPeer.messages.some((message) => message.type === "runOver"));
    expect(diedPeer.messages.find((message) => message.type === "runOver")).toMatchObject({ reason: "died", keptItems: [], lostItems: ["h"] });
    const finalBase = (await app.inject({ method: "GET", url: "/api/base", headers })).json<{ loadout: string[]; stash: Array<{ itemType: string; qty: number }> }>();
    expect(finalBase.loadout).toEqual([]);
    expect(stashQty(finalBase.stash, "h")).toBe(1);
    diedRoom.dispose();
    await app.close();
  }, 20_000);

  it("fabricates powerups and blueprint furniture atomically", async () => {
    await sql!`truncate table base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app } = await createServer({ databaseUrl });
    const account = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Fabricator Pilot" } })).json<{ playerId: string; token: string }>();
    const headers = { "x-device-token": account.token };

    const unlearned = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "furniture-shelf", slotId: "floor-nw" } });
    expect(unlearned.statusCode).toBe(409);
    expect(unlearned.json<{ error: string }>().error).toMatch(/REQUIRES BLUEPRINT: shelf/i);
    expect((await baseRowCounts(account.playerId))).toEqual({ layout: 5, stash: 0 });

    await sql!`insert into learned_blueprints(player_id, blueprint_id) values (${account.playerId}, 'shelf'), (${account.playerId}, 'workbench')`;
    const insufficient = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "furniture-shelf", slotId: "floor-nw" } });
    expect(insufficient.statusCode).toBe(409);
    expect((await baseRowCounts(account.playerId))).toEqual({ layout: 5, stash: 0 });

    await sql!`insert into hold_items(player_id, item_type, qty) values (${account.playerId}, 'r', 10), (${account.playerId}, 'd', 10)`;
    expect((await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "furniture-shelf", slotId: "wall-n" } })).statusCode).toBe(409);
    expect((await stashTotals(account.playerId))).toMatchObject({ r: 10, d: 10 });
    expect((await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "furniture-repairBench", slotId: "floor-nw" } })).statusCode).toBe(409);
    expect((await stashTotals(account.playerId))).toMatchObject({ r: 10, d: 10 });

    const shelf = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "furniture-shelf", slotId: "floor-nw" } });
    expect(shelf.statusCode).toBe(200);
    expect(shelf.json<{ layout: BaseLayout }>().layout["floor-nw"]).toBe("shelf");
    expect((await stashTotals(account.playerId))).toMatchObject({ r: 9, d: 9 });

    const healthBlocked = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "convert-health" } });
    expect(healthBlocked.statusCode).toBe(409);
    expect(healthBlocked.json<{ error: string }>().error).toMatch(/REQUIRES: REPAIR BENCH/);
    expect((await stashTotals(account.playerId))).toMatchObject({ r: 9, d: 9, h: 0 });

    const bench = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "furniture-repairBench", slotId: "wall-west" } });
    expect(bench.statusCode).toBe(200);
    expect(bench.json<{ layout: BaseLayout }>().layout["wall-west"]).toBe("repairBench");
    expect((await stashTotals(account.playerId))).toMatchObject({ r: 7, d: 8 });
    const health = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "convert-health" } });
    expect(health.statusCode).toBe(200);
    expect((await stashTotals(account.playerId))).toMatchObject({ r: 5, d: 8, h: 1 });
    expect((await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "not-a-recipe" } })).statusCode).toBe(400);
    await app.close();
  });

  it("banks extraction items in fragment-first stash-cap order and preserves existing over-cap data", async () => {
    await sql!`truncate table base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app, persistence } = await createServer({ databaseUrl });
    const account = await persistence.registerPlayer("Capacity Pilot");
    await sql!`insert into hold_items(player_id, item_type, qty) values (${account.playerId}, 'h', 39)`;
    const matchId = crypto.randomUUID();
    await persistence.startMatch({ matchId, roomCode: "CAP1", mapId: "downtown", startedAt: new Date() });
    const banked = await persistence.recordExtraction({
      matchId,
      playerId: account.playerId,
      blueprintLearningThreshold: 3,
      manifest: { reason: "extracted", keptItems: ["r", "d", "b:shelf"], lostItems: [], learnedBlueprints: [] },
    });
    expect(banked.manifest).toEqual({ reason: "extracted", keptItems: ["b:shelf"], lostItems: ["r", "d"], learnedBlueprints: [] });
    expect((await stashTotals(account.playerId))).toMatchObject({ h: 39, "b:shelf": 1, r: 0, d: 0 });
    const [participant] = await sql!<Array<{ manifest: { keptItems: string[]; lostItems: string[] } }>>`
      select extracted_manifest as manifest from match_participants where match_id = ${matchId} and player_id = ${account.playerId}
    `;
    expect(participant.manifest).toMatchObject({ keptItems: ["b:shelf"], lostItems: ["r", "d"] });

    await sql!`insert into hold_items(player_id, item_type, qty) values (${account.playerId}, 'h', 2)`;
    const overCapBefore = Number((await sql!<Array<{ qty: number }>>`select sum(qty)::int as qty from hold_items where player_id = ${account.playerId}`)[0].qty);
    const secondMatchId = crypto.randomUUID();
    await persistence.startMatch({ matchId: secondMatchId, roomCode: "CAP2", mapId: "downtown", startedAt: new Date() });
    const overCap = await persistence.recordExtraction({
      matchId: secondMatchId,
      playerId: account.playerId,
      blueprintLearningThreshold: 3,
      manifest: { reason: "extracted", keptItems: ["i"], lostItems: [], learnedBlueprints: [] },
    });
    expect(overCap.manifest.lostItems).toEqual(["i"]);
    expect(Number((await sql!<Array<{ qty: number }>>`select sum(qty)::int as qty from hold_items where player_id = ${account.playerId}`)[0].qty)).toBe(overCapBefore);
    await app.close();
  });

  it("round-trips three presets and partially applies available stock", async () => {
    await sql!`truncate table base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app } = await createServer({ databaseUrl });
    const account = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Preset Pilot" } })).json<{ playerId: string; token: string }>();
    const headers = { "x-device-token": account.token };
    await sql!`insert into hold_items(player_id, item_type, qty) values (${account.playerId}, 'h', 1), (${account.playerId}, 'r', 1)`;
    const presets = [{ name: "Scout", items: ["h", "r", "r", "i"] }];
    const saved = await app.inject({ method: "POST", url: "/api/base/presets", headers, payload: { presets } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ presets: unknown[] }>().presets).toEqual(presets);
    expect((await app.inject({ method: "GET", url: "/api/base", headers })).json<{ presets: unknown[] }>().presets).toEqual(presets);

    const applied = await app.inject({ method: "POST", url: "/api/base/presets/apply", headers, payload: { presetIndex: 0 } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ loadout: string[] }>().loadout).toEqual(["h", "r"]);
    expect(applied.json<{ missing: unknown[] }>().missing).toEqual([{ itemType: "r", qty: 1 }, { itemType: "i", qty: 1 }]);
    expect(await stashTotals(account.playerId)).toMatchObject({ h: 0, r: 0 });
    const appliedAgain = await app.inject({ method: "POST", url: "/api/base/presets/apply", headers, payload: { presetIndex: 0 } });
    expect(appliedAgain.json<{ loadout: string[] }>().loadout).toEqual(["h", "r"]);
    expect((await app.inject({ method: "POST", url: "/api/base/presets", headers, payload: { presets: Array.from({ length: 4 }, (_, index) => ({ name: `P${index}`, items: [] })) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/base/presets", headers, payload: { presets: [{ name: "Cargo", items: ["b:shelf"] }] } })).statusCode).toBe(400);
    await app.close();
  });
});

function collectingPeer(id: string): { peer: RoomPeer; messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return { peer: { id, send: (message) => messages.push(message) }, messages };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for state");
}

function stashQty(stash: Array<{ itemType: string; qty: number }>, itemType: string): number {
  return stash.find((entry) => entry.itemType === itemType)?.qty ?? 0;
}

async function baseRowCounts(playerId: string): Promise<{ layout: number; stash: number }> {
  const [row] = await sql!<Array<{ layout: number; stash: number }>>`
    select
      (select count(*)::int from base_layouts where player_id = ${playerId}) as layout,
      (select coalesce(sum(qty), 0)::int from hold_items where player_id = ${playerId}) as stash
  `;
  return row;
}

async function stashTotals(playerId: string): Promise<Record<string, number>> {
  const rows = await sql!<Array<{ itemType: string; qty: number }>>`
    select item_type as "itemType", sum(qty)::int as qty from hold_items where player_id = ${playerId} group by item_type
  `;
  const totals: Record<string, number> = { h: 0, r: 0, d: 0, i: 0 };
  for (const row of rows) totals[row.itemType] = Number(row.qty);
  return totals;
}

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
    async waitFor(type, timeoutMs = 5000) {
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
  while (Date.now() - started < 5000) {
    const latest = inbox.messages
      .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
      .at(-1);
    const position = latest?.bots.find((bot) => bot.i === botId)?.p;
    if (position && predicate(position)) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${botId}`);
}

async function waitForBays(
  inbox: Inbox,
  botId: string,
  predicate: (bays: NonNullable<Extract<ServerMessage, { type: "snap" }>["bots"][number]["b"]>) => boolean,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const latest = inbox.messages.filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap").at(-1);
    const bays = latest?.bots.find((bot) => bot.i === botId)?.b;
    if (bays && predicate(bays)) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${botId} bays`);
}

function latestBays(inbox: Inbox, botId: string) {
  return inbox.messages
    .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
    .at(-1)?.bots.find((bot) => bot.i === botId)?.b;
}

async function steerBotTo(
  inbox: Inbox,
  botId: string,
  target: { x: number; y: number },
  initialSeq: number,
  doneWhen?: (bays: NonNullable<Extract<ServerMessage, { type: "snap" }>["bots"][number]["b"]>) => boolean,
): Promise<number> {
  let seq = initialSeq;
  let settledAt: number | null = null;
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const latest = inbox.messages
      .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
      .at(-1);
    const bot = latest?.bots.find((candidate) => candidate.i === botId);
    // Capture (12px range, short channel) is the real goal; positional settle
    // is only the fallback. A doneWhen hit ends the steer even mid-approach.
    if (doneWhen && bot?.b && doneWhen(bot.b)) {
      inbox.send({ type: "input", seq: ++seq, move: [0, 0], dash: false });
      return seq;
    }
    const position = bot?.p;
    if (position) {
      const dx = target.x - position[0];
      const dy = target.y - position[1];
      if (Math.hypot(dx, dy) <= 8) {
        inbox.send({ type: "input", seq: ++seq, move: [0, 0], dash: false });
        settledAt ??= Date.now();
        if (!doneWhen && Date.now() - settledAt >= 300) return seq;
      } else {
        settledAt = null;
        inbox.send({
          type: "input",
          seq: ++seq,
          // Keep the final approach below one capture radius per snapshot;
          // faster steering can oscillate across adjacent 12px dots under
          // full-workspace load without ever holding either channel.
          move: [Math.max(-0.1, Math.min(0.1, dx / 160)), Math.max(-0.1, Math.min(0.1, dy / 160))],
          dash: false,
        });
      }
    }
    await delay(30);
  }
  const latest = inbox.messages
    .filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap")
    .at(-1);
  const bot = latest?.bots.find((candidate) => candidate.i === botId);
  const otherEvents = inbox.messages.filter((message) => message.type !== "snap").map((message) => message.type);
  throw new Error(
    `Timed out steering ${botId} to ${JSON.stringify(target)}; bot=${JSON.stringify(bot)} events=${otherEvents.join(",")}`,
  );
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
