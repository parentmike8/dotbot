import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import postgres, { type Sql } from "postgres";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";
import { Room, type RoomPeer } from "./Room";
import { starterBaseLayout } from "@dotbot/game/content/base";
import type { BaseLayout, ContractDefinition, SimEvent } from "@dotbot/game/types";

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
      // Simulation and websocket extraction have their own deterministic
      // coverage. Inject the authoritative extraction event here so this
      // integration test isolates the server-to-database transaction instead
      // of depending on a long collision-sensitive route through the map.
      const activeRoom = rooms.join(welcome.roomCode);
      expect(activeRoom).toBeDefined();
      (activeRoom as unknown as { processRunEvents(events: SimEvent[]): void }).processRunEvents([{
        type: "extracted",
        botId: aliceStart.yourBotId,
        squadId: "alpha",
        items: [
          { kind: "powerup", type: "health", sourceBuildingId: "lot6" },
          { kind: "blueprint", blueprintId: "shelf", sourceBuildingId: "lot6" },
        ],
      }]);

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
    await persistence.startMatch({ matchId: diedMatchId, roomCode: "DIED", mapId: "downtown", startedAt: new Date(), playerIds: [diedAccount.playerId] });
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
    const { app, persistence } = await createServer({ databaseUrl });
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

    await sql!`insert into hold_items(player_id, item_type, qty) values (${account.playerId}, 'i', 1)`;
    const mine = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "fabricate-mine" } });
    expect(mine.statusCode).toBe(200);
    expect(stashQty(mine.json<{ stash: Array<{ itemType: string; qty: number }> }>().stash, "m")).toBe(1);
    const mineLoadout = await app.inject({ method: "POST", url: "/api/base/loadout", headers, payload: { loadout: ["m"] } });
    expect(mineLoadout.statusCode).toBe(200);
    expect(mineLoadout.json<{ loadout: string[] }>().loadout).toEqual(["m"]);
    expect(await persistence.consumeLoadout(account.playerId)).toEqual(["m"]);
    const mineMatchId = crypto.randomUUID();
    await persistence.startMatch({ matchId: mineMatchId, roomCode: "MINE", mapId: "downtown", startedAt: new Date(), playerIds: [account.playerId] });
    const mineManifest = await persistence.recordExtraction({
      matchId: mineMatchId,
      playerId: account.playerId,
      blueprintLearningThreshold: 3,
      manifest: { reason: "extracted", keptItems: ["m"], lostItems: [], learnedBlueprints: [] },
    });
    expect(mineManifest.manifest.keptItems).toEqual(["m"]);
    expect(stashQty((await persistence.getBase(account.token))!.stash, "m")).toBe(1);
    expect((await persistence.getProfile(account.token))!.recentManifests[0]).toMatchObject({ roomCode: "MINE", keptItems: ["m"] });
    await app.close();
  });

  it("purchases the second floor atomically, rejects repeats and unauthorized F1 layouts, and counts F1 lockers", async () => {
    await sql!`truncate table base_upgrades, base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app } = await createServer({ databaseUrl });
    const account = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Expansion Pilot" } })).json<{ playerId: string; token: string }>();
    const headers = { "x-device-token": account.token };
    const f1Layout = { ...starterBaseLayout, "up-wall-a": "locker" } satisfies BaseLayout;

    const unauthorized = await app.inject({ method: "POST", url: "/api/base/layout", headers, payload: { layout: f1Layout } });
    expect(unauthorized.statusCode).toBe(409);
    expect(unauthorized.json<{ error: string }>().error).toMatch(/requires expansion-secondFloor/i);
    expect((await app.inject({ method: "GET", url: "/api/base", headers })).json<{ upgrades: string[] }>().upgrades).toEqual([]);

    await sql!`insert into hold_items(player_id, item_type, qty) values
      (${account.playerId}, 'h', 6), (${account.playerId}, 'r', 6), (${account.playerId}, 'd', 6), (${account.playerId}, 'i', 6)`;
    const purchased = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "expansion-secondFloor" } });
    expect(purchased.statusCode).toBe(200);
    expect(purchased.json<{ upgrades: string[] }>().upgrades).toEqual(["secondFloor"]);
    expect(await stashTotals(account.playerId)).toEqual({ h: 0, r: 0, d: 0, i: 0 });
    expect((await sql!<Array<{ count: number }>>`select count(*)::int as count from base_upgrades where player_id = ${account.playerId} and upgrade_id = 'secondFloor'`)[0].count).toBe(1);

    const repeated = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "expansion-secondFloor" } });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json<{ error: string }>().error).toMatch(/already owned/i);
    expect(await stashTotals(account.playerId)).toEqual({ h: 0, r: 0, d: 0, i: 0 });

    await sql!`insert into learned_blueprints(player_id, blueprint_id) values (${account.playerId}, 'locker')`;
    await sql!`insert into hold_items(player_id, item_type, qty) values (${account.playerId}, 'r', 1), (${account.playerId}, 'd', 1)`;
    const locker = await app.inject({ method: "POST", url: "/api/base/fabricate", headers, payload: { recipeId: "furniture-locker", slotId: "up-wall-a" } });
    expect(locker.statusCode).toBe(200);
    expect(locker.json<{ layout: BaseLayout; stashCapacity: number }>().layout["up-wall-a"]).toBe("locker");
    expect(locker.json<{ stashCapacity: number }>().stashCapacity).toBe(60);

    const short = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Short Pilot" } })).json<{ playerId: string; token: string }>();
    await sql!`insert into hold_items(player_id, item_type, qty) values
      (${short.playerId}, 'h', 5), (${short.playerId}, 'r', 6), (${short.playerId}, 'd', 6), (${short.playerId}, 'i', 6)`;
    const before = await stashTotals(short.playerId);
    const insufficient = await app.inject({ method: "POST", url: "/api/base/fabricate", headers: { "x-device-token": short.token }, payload: { recipeId: "expansion-secondFloor" } });
    expect(insufficient.statusCode).toBe(409);
    expect(await stashTotals(short.playerId)).toEqual(before);
    expect((await sql!<Array<{ count: number }>>`select count(*)::int as count from base_upgrades where player_id = ${short.playerId}`)[0].count).toBe(0);
    await app.close();
  });

  it("enforces contract flow rules and completes payouts inside extraction banking", async () => {
    await sql!`truncate table contracts, base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app, persistence } = await createServer({ databaseUrl });
    const account = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Contract Pilot" } })).json<{ playerId: string; token: string }>();
    const headers = { "x-device-token": account.token };
    const initial = (await app.inject({ method: "GET", url: "/api/base", headers })).json<{ contractOffers: ContractDefinition[]; activeContracts: ContractDefinition[] }>();
    expect(initial.contractOffers).toHaveLength(3);
    expect(initial.activeContracts).toEqual([]);

    for (const offer of initial.contractOffers.slice(0, 2)) {
      expect((await app.inject({ method: "POST", url: "/api/base/contracts/accept", headers, payload: { contractId: offer.id } })).statusCode).toBe(200);
    }
    const capped = await app.inject({ method: "POST", url: "/api/base/contracts/accept", headers, payload: { contractId: initial.contractOffers[2].id } });
    expect(capped.statusCode).toBe(409);
    expect(capped.json<{ error: string }>().error).toMatch(/CAP IS 2/);
    const rerolled = await app.inject({ method: "POST", url: "/api/base/contracts/reroll", headers });
    expect(rerolled.statusCode).toBe(200);
    expect(rerolled.json<{ contractOffers: ContractDefinition[] }>().contractOffers.map((contract) => contract.id))
      .not.toEqual(initial.contractOffers.map((contract) => contract.id));
    expect(rerolled.json<{ activeContracts: ContractDefinition[] }>().activeContracts).toHaveLength(2);
    const abandonedId = rerolled.json<{ activeContracts: ContractDefinition[] }>().activeContracts[0].id;
    const abandoned = await app.inject({ method: "POST", url: "/api/base/contracts/abandon", headers, payload: { contractId: abandonedId } });
    expect(abandoned.statusCode).toBe(200);
    expect(abandoned.json<{ activeContracts: ContractDefinition[] }>().activeContracts).toHaveLength(1);

    // Isolate a known objective so exact and near-miss transaction outcomes
    // can be asserted without depending on the daily offer mix.
    await sql!`update contracts set status = 'abandoned' where player_id = ${account.playerId}`;
    const exactContract: ContractDefinition = {
      id: "contract-exact-health",
      templateId: "test-health",
      title: "EXACT HEALTH HAUL",
      objective: { kind: "extractPowerups", powerupType: "health", count: 2 },
      difficulty: 2,
      payout: { items: [{ kind: "powerup", type: "radar" }] },
    };
    await sql!`insert into contracts (id, player_id, contract, status) values (${exactContract.id}, ${account.playerId}, ${sql!.json(exactContract)}, 'active')`;
    const exactMatch = crypto.randomUUID();
    await persistence.startMatch({ matchId: exactMatch, roomCode: "CNTR", mapId: "downtown", startedAt: new Date(), playerIds: [account.playerId] });
    const exact = await persistence.recordExtraction({
      matchId: exactMatch,
      playerId: account.playerId,
      manifest: {
        reason: "extracted",
        keptItems: ["h", "h"],
        lostItems: [],
        learnedBlueprints: [],
        cargo: [{ kind: "powerup", type: "health" }, { kind: "powerup", type: "health" }],
      },
      blueprintLearningThreshold: 3,
    });
    expect(exact.manifest.contractCompletions).toEqual([{
      contractId: exactContract.id,
      title: exactContract.title,
      payout: ["r"],
    }]);
    expect((await sql!<Array<{ status: string }>>`select status from contracts where id = ${exactContract.id}`)[0].status).toBe("completed");
    expect(await stashTotals(account.playerId)).toMatchObject({ h: 2, r: 1 });

    const nearMiss: ContractDefinition = { ...exactContract, id: "contract-near-miss", title: "NEAR MISS" };
    await sql!`insert into contracts (id, player_id, contract, status) values (${nearMiss.id}, ${account.playerId}, ${sql!.json(nearMiss)}, 'active')`;
    const nearMatch = crypto.randomUUID();
    await persistence.startMatch({ matchId: nearMatch, roomCode: "MISS", mapId: "downtown", startedAt: new Date(), playerIds: [account.playerId] });
    const near = await persistence.recordExtraction({
      matchId: nearMatch,
      playerId: account.playerId,
      manifest: { reason: "extracted", keptItems: ["h"], lostItems: [], learnedBlueprints: [], cargo: [{ kind: "powerup", type: "health" }] },
      blueprintLearningThreshold: 3,
    });
    expect(near.manifest.contractCompletions).toBeUndefined();
    expect((await sql!<Array<{ status: string }>>`select status from contracts where id = ${nearMiss.id}`)[0].status).toBe("active");

    const diedContract: ContractDefinition = { ...exactContract, id: "contract-died", title: "DIED PATH" };
    await sql!`insert into contracts (id, player_id, contract, status) values (${diedContract.id}, ${account.playerId}, ${sql!.json(diedContract)}, 'active')`;
    const diedMatch = crypto.randomUUID();
    await persistence.startMatch({ matchId: diedMatch, roomCode: "DEAD", mapId: "downtown", startedAt: new Date(), playerIds: [account.playerId] });
    await persistence.recordOutcome({ matchId: diedMatch, playerId: account.playerId, outcome: "died" });
    expect((await sql!<Array<{ status: string }>>`select status from contracts where id = ${diedContract.id}`)[0].status).toBe("active");
    await app.close();
  });

  it("banks extraction items in fragment-first stash-cap order and preserves existing over-cap data", async () => {
    await sql!`truncate table base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app, persistence } = await createServer({ databaseUrl });
    const account = await persistence.registerPlayer("Capacity Pilot");
    await sql!`insert into hold_items(player_id, item_type, qty) values (${account.playerId}, 'h', 39)`;
    const matchId = crypto.randomUUID();
    await persistence.startMatch({ matchId, roomCode: "CAP1", mapId: "downtown", startedAt: new Date(), playerIds: [account.playerId] });
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
    await persistence.startMatch({ matchId: secondMatchId, roomCode: "CAP2", mapId: "downtown", startedAt: new Date(), playerIds: [account.playerId] });
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

  it("makes match start, loadout withdrawal, extraction, and relay claims idempotent", async () => {
    await sql!`truncate table relay_requests, contracts, base_layouts, hold_items, match_participants, match_results, learned_blueprints, players cascade`;
    process.env.NODE_ENV = "test";
    const { app, persistence } = await createServer({ databaseUrl });
    const player = await persistence.registerPlayer("Retry Pilot");
    const outsider = await persistence.registerPlayer("Outsider");
    await sql!`insert into hold_items(player_id, item_type, qty) values (${player.playerId}, 'h', 1)`;
    await sql!`update players set loadout = '["h"]'::jsonb where id = ${player.playerId}`;

    const matchId = crypto.randomUUID();
    const startedAt = new Date();
    const startInput = { matchId, roomCode: "SAFE", mapId: "downtown", startedAt, playerIds: [player.playerId] };
    const firstStart = await persistence.startMatch(startInput);
    const retriedStart = await persistence.startMatch(startInput);
    expect(firstStart.loadouts[player.playerId]).toEqual(["h"]);
    expect(retriedStart).toEqual(firstStart);
    expect((await sql!<Array<{ loadout: string[] }>>`select loadout from players where id = ${player.playerId}`)[0].loadout).toEqual([]);
    await expect(persistence.startMatch({ ...startInput, playerIds: [player.playerId, outsider.playerId] }))
      .rejects.toThrow(/different player roster/i);

    const extraction = {
      matchId,
      playerId: player.playerId,
      blueprintLearningThreshold: 3,
      manifest: { reason: "extracted" as const, keptItems: ["r" as const], lostItems: [], learnedBlueprints: [] },
    };
    const [firstExtraction, retriedExtraction] = await Promise.all([
      persistence.recordExtraction(extraction),
      persistence.recordExtraction(extraction),
    ]);
    expect(retriedExtraction).toEqual(firstExtraction);
    expect((await sql!<Array<{ count: number }>>`
      select count(*)::int as count from hold_items where player_id = ${player.playerId} and item_type = 'r' and acquired_match_id = ${matchId}
    `)[0].count).toBe(1);
    await expect(persistence.recordExtraction({ ...extraction, playerId: outsider.playerId }))
      .rejects.toThrow(/not registered for this match/i);

    const requestId = crypto.randomUUID();
    expect(await persistence.claimRelayRequest(requestId, new Date(Date.now() + 60_000))).toBe(true);
    expect(await persistence.claimRelayRequest(requestId, new Date(Date.now() + 60_000))).toBe(false);
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
