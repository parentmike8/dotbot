import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { interactionDotReach, withinDownedCoverRange } from "./interactions";
import { classifyNoise, physicsFloorId, planningTableSurfaceRect } from "./mapModel";
import { carriedCount } from "./inventory";
import { DotBotSimulation, waypointRetired } from "./simulation";
import { buildContactShape, contactDistance, makeContactShape } from "./bodyContact";
import { contactReach } from "./shields";
import { hasLineOfSight } from "./visibility";
import type { BotSpawn, DotSpawn, GameConfig, GameSnapshot, InputCommand, Item, MapDocument, Vec2, WallSegment } from "./types";

const healthItem = { kind: "powerup", type: "health" } as const;
const radarItem = { kind: "powerup", type: "radar" } as const;
const overchargeItem = { kind: "powerup", type: "dashOvercharge" } as const;
const incognitoItem = { kind: "powerup", type: "incognito" } as const;
const mineItem = { kind: "mine" } as const;
const drop = (
  from: "bay" | "hold",
  index: number,
  revision: number,
  expected: Item = from === "bay" ? healthItem : radarItem,
) => ({ from, index, revision, expected });
/** `count` health items, then empties out to however many bays the game has. */
const testBays = (count: number) =>
  Array.from({ length: defaultGameConfig.baySlots }, (_, index) => index < count ? healthItem : null);
const emptyBays = () => testBays(0);
/** `AI_STALL_TICKS` in simulation.ts, plus room for the couple of ticks it takes
 * to notice and re-decide. A bot may lean on a jam for one window, not two. */
const AI_STALL_TICKS_BOUND = 120;

const testConfig: Partial<GameConfig> = {
  dotCaptureDurationMs: 120,
  coverDurationMs: 150,
  lootDurationMs: 150,
  pleaCooldownMs: 150,
  dashCooldownMs: 300,
  shieldInvulnerabilityMs: 120,
  extractionDurationMs: 200,
};

function bounds(width: number, height: number): WallSegment[] {
  return [
    { id: "north", x: 0, y: 0, w: width, h: 20 },
    { id: "south", x: 0, y: height - 20, w: width, h: 20 },
    { id: "west", x: 0, y: 0, w: 20, h: height },
    { id: "east", x: width - 20, y: 0, w: 20, h: height },
  ];
}

function makeMap(botSpawns: BotSpawn[], dotSpawns: DotSpawn[] = []): MapDocument {
  return {
    id: "test-map",
    name: "Test Map",
    width: 500,
    height: 360,
    outdoor: {
      roads: [],
      parks: [],
      walls: bounds(500, 360),
      objects: [],
      dotSpawns,
    },
    buildings: [],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns,
  };
}

async function makeSimulation(botSpawns: BotSpawn[], dotSpawns: DotSpawn[] = []) {
  return DotBotSimulation.create({
    map: makeMap(botSpawns, dotSpawns),
    config: testConfig,
  });
}

function playerSpawn(overrides: Partial<BotSpawn> = {}): BotSpawn {
  return {
    id: "player",
    name: "Player",
    squadId: "alpha",
    controller: "human",
    color: "#ff3b6b",
    position: { x: 100, y: 180 },
    bays: testBays(0),
    hold: [],
    ...overrides,
  };
}

function enemySpawn(overrides: Partial<BotSpawn> = {}): BotSpawn {
  return {
    id: "enemy",
    name: "Enemy",
    squadId: "rival-1",
    isAmbient: true,
    color: "#f2994a",
    position: { x: 220, y: 180 },
    bays: testBays(0),
    hold: [],
    ...overrides,
  };
}

function allySpawn(overrides: Partial<BotSpawn> = {}): BotSpawn {
  return {
    id: "ally",
    name: "Ally",
    squadId: "alpha",
    color: "#2f80ed",
    position: { x: 100, y: 180 },
    bays: testBays(0),
    hold: [],
    ...overrides,
  };
}

function runTicks(simulation: DotBotSimulation, count: number): void {
  for (let i = 0; i < count; i += 1) {
    simulation.step();
  }
}

function snapshotDigest(snapshot: GameSnapshot): string {
  return JSON.stringify({
    timeMs: Number(snapshot.timeMs.toFixed(3)),
    bots: [...snapshot.bots]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((bot) => ({
        id: bot.id,
        x: Number(bot.position.x.toFixed(3)),
        y: Number(bot.position.y.toFixed(3)),
        floorId: bot.floorId,
        state: bot.state,
        shields: bot.shields,
        carriedCount: carriedCount(bot),
      })),
    activeDots: snapshot.dots.filter((dot) => dot.active).map((dot) => dot.id).sort(),
  });
}

describe("DotBotSimulation", () => {
  it("preserves analog walking magnitude but keeps dash speed full", async () => {
    const walking = await makeSimulation([playerSpawn()]);
    walking.applyInput("player", { move: { x: 0.25, y: 0 }, dash: false });
    walking.step();
    const walked = walking.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(walked.position.x).toBeCloseTo(
      100 + (defaultGameConfig.playerSpeed * 0.25) / defaultGameConfig.tickHz,
      5,
    );
    walking.dispose();

    const dashing = await makeSimulation([playerSpawn()]);
    dashing.applyInput("player", { move: { x: 0.25, y: 0 }, dash: true });
    dashing.step();
    const dashed = dashing.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(dashed.position.x).toBeCloseTo(
      100 + defaultGameConfig.dashSpeed / defaultGameConfig.tickHz,
      5,
    );
    dashing.dispose();
  });

  it("keeps the player inside map bounds", async () => {
    const simulation = await makeSimulation([playerSpawn({ position: { x: 70, y: 180 } })]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 140);

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.position.x).toBeGreaterThanOrEqual(20 + defaultGameConfig.botRadius - 1);
    simulation.dispose();
  });

  /**
   * The authoritative simulation must be solid where every other system says it
   * is. It used to build its own static collision by walking `floor.walls`,
   * which quietly meant a path wall — the only kind a source-authored building
   * has — was solid to client prediction, navigation and line of sight, and
   * completely absent on the server. An entire depot shell was walk-through.
   */
  it("collides with path walls, not just rectangles", async () => {
    const drive = async (from: { x: number; y: number }, move: { x: number; y: number }) => {
      const simulation = await DotBotSimulation.create({
        map: { ...downtownMap, botSpawns: [playerSpawn({ position: from })] },
        config: testConfig,
      });
      simulation.applyInput("player", { move, dash: false });
      runTicks(simulation, 180);
      const probe = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
      simulation.dispose();
      return probe.position;
    };

    // Lot 6 Depot is authored in map source, so its whole shell is path walls.
    // North elevation, on the solid stretch between the two roll-ups.
    expect((await drive({ x: 460, y: 940 }, { x: 0, y: 1 })).y).toBeLessThan(1000);
    // West elevation.
    expect((await drive({ x: 100, y: 1240 }, { x: 1, y: 0 })).x).toBeLessThan(160);
    // …and the roll-up is still a real hole.
    expect((await drive({ x: 340, y: 940 }, { x: 0, y: 1 })).y).toBeGreaterThan(1040);
    /**
     * 20s, not the 5s default: this builds three whole-map simulations and steps
     * each 180 ticks. It sat just inside 5s and began timing out under full-suite
     * parallel load once street furniture became solid — around 150 more outdoor
     * colliders for every tick to consider. The cost is real and the test is worth
     * it; the budget was simply wrong.
     */
  }, 20_000);

  it("keeps an alive bot outside thin interior walls", async () => {
    const wallX = 220;
    const baseMap = makeMap([playerSpawn({ position: { x: 160, y: 180 } })]);
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        outdoor: {
          ...baseMap.outdoor,
          walls: [...bounds(500, 360), { id: "thin-wall", x: wallX, y: 80, w: 12, h: 220 }],
        },
      },
      config: {
        ...testConfig,
        dashDurationMs: 260,
        dashSpeed: 900,
      },
    });

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    runTicks(simulation, 90);

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.position.x).toBeLessThanOrEqual(wallX - defaultGameConfig.botRadius + 1);
    simulation.dispose();
  });

  it("lets a bot approach the visible contracts tabletop instead of its chair gutter", async () => {
    const table = { id: "contracts-table", kind: "planningTable" as const, x: 220, y: 140, w: 108, h: 72 };
    const surface = planningTableSurfaceRect(table);
    const baseMap = makeMap([playerSpawn({ position: { x: 120, y: surface.y + surface.h / 2 } })]);
    baseMap.outdoor.objects = [table];
    const simulation = await DotBotSimulation.create({ map: baseMap, config: testConfig });

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 120);

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(player.position.x + player.radius).toBeCloseTo(surface.x, 4);
    simulation.dispose();
  });

  it("captures a covered Dot and adds it to inventory", async () => {
    const simulation = await makeSimulation(
      [playerSpawn({ position: { x: 100, y: 100 } })],
      [{ id: "dot", item: healthItem, position: { x: 100, y: 100 } }],
    );

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 18);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.dots.find((dot) => dot.id === "dot")?.active).toBe(false);
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean).length).toBe(1);
    simulation.dispose();
  });

  it("starts capture when the visible bot and Dot footprints first overlap", async () => {
    const reach = interactionDotReach(defaultGameConfig.botRadius, defaultGameConfig.dotRadius);
    const touching = await makeSimulation(
      [playerSpawn({ position: { x: 100, y: 100 } })],
      [{ id: "touching-dot", item: healthItem, position: { x: 100 + reach, y: 100 } }],
    );
    runTicks(touching, 1);
    expect(touching.getSnapshot().coverages).toContainEqual(expect.objectContaining({
      kind: "capture",
      actorId: "player",
      targetId: "touching-dot",
    }));
    touching.dispose();

    const separated = await makeSimulation(
      [playerSpawn({ position: { x: 100, y: 100 } })],
      [{ id: "separated-dot", item: healthItem, position: { x: 100 + reach + 0.01, y: 100 } }],
    );
    runTicks(separated, 1);
    expect(separated.getSnapshot().coverages).not.toContainEqual(expect.objectContaining({
      kind: "capture",
      targetId: "separated-dot",
    }));
    separated.dispose();
  });

  it("preserves authored building provenance on captured contract cargo", async () => {
    const map = makeMap([playerSpawn({ position: { x: 100, y: 100 } })]);
    map.buildings = [{
      id: "source-building",
      kind: "warehouse",
      name: "SOURCE",
      footprint: { x: 60, y: 60, w: 160, h: 160 },
      floors: [{
        id: "source-building:GROUND",
        label: "GROUND",
        walls: [],
        doorways: [],
        objects: [],
        stairs: [],
        dotSpawns: [{ id: "source-dot", item: healthItem, position: { x: 100, y: 100 } }],
      }],
    }];
    const simulation = await DotBotSimulation.create({ map, config: testConfig });
    runTicks(simulation, 8);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.bays[0]).toEqual({
      ...healthItem,
      sourceBuildingId: "source-building",
    });
    simulation.dispose();
  });

  it("routes pickups through bays, hold, then refuses a full inventory", async () => {
    const items = [healthItem, radarItem, overchargeItem];
    const simulation = await DotBotSimulation.create({
      map: makeMap(
        [playerSpawn({ position: { x: 100, y: 100 }, bays: [null], hold: [] })],
        items.map((item, index) => ({ id: `dot-${index}`, item, position: { x: 100, y: 100 } })),
      ),
      config: { ...testConfig, baySlots: 1, holdSlots: 1 },
    });

    runTicks(simulation, 18);
    const snapshot = simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player")!;
    expect(player.bays).toEqual([healthItem]);
    expect(player.hold).toEqual([radarItem]);
    expect(snapshot.dots.find((dot) => dot.id === "dot-2")?.active).toBe(true);
    simulation.dispose();
  });

  it("drops authoritative cargo as a public runtime pickup without losing provenance", async () => {
    const cargo = { ...healthItem, sourceBuildingId: "source-building" };
    const simulation = await makeSimulation([
      playerSpawn({
        position: { x: 140, y: 180 },
        state: "downed",
        shields: 0,
        bays: [cargo, null, null],
        hold: [radarItem],
      }),
    ], [
      // Deliberately collide with the first generated runtime id. Runtime ids
      // must skip authored content rather than overwrite it.
      { id: "runtime-drop-0", item: incognitoItem, position: { x: 360, y: 180 } },
    ]);

    simulation.applyInput("player", {
      move: { x: 0, y: 0 },
      dash: false,
      drop: {
        ...drop("bay", 0, 0, cargo),
        // A hostile client may add fields at the JSON boundary. They are not
        // part of DropCommand and must never become authoritative.
        item: mineItem,
        position: { x: 420, y: 300 },
        floorId: "forged-floor",
      },
    } as InputCommand);
    simulation.step();

    let snapshot = simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player")!;
    const dropped = snapshot.dots.find((dot) => dot.id.startsWith("runtime-drop-") && dot.id !== "runtime-drop-0")!;
    expect(player.bays).toEqual([null, null, null]);
    expect(player.hold).toEqual([radarItem]);
    expect(dropped).toMatchObject({
      id: "runtime-drop-1",
      position: player.position,
      floorId: player.floorId,
      item: cargo,
      active: true,
    });

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, drop: drop("hold", 0, 1) } as InputCommand);
    simulation.step();
    snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")?.hold).toEqual([]);
    expect(snapshot.dots.filter((dot) => dot.id.startsWith("runtime-drop-") && dot.id !== "runtime-drop-0")).toHaveLength(2);
    simulation.dispose();
  });

  it("gives a dropped item to exactly one of two racing players", async () => {
    const cargo = { kind: "blueprint", blueprintId: "shelf", sourceBuildingId: "lot6" } as const;
    const simulation = await makeSimulation([
      playerSpawn({ id: "dropper", position: { x: 100, y: 180 }, state: "downed", shields: 0, bays: [cargo, null, null] }),
      playerSpawn({ id: "racer-a", squadId: "bravo", position: { x: 72, y: 180 } }),
      playerSpawn({ id: "racer-b", squadId: "crew-3", position: { x: 128, y: 180 } }),
    ]);

    simulation.applyInput("dropper", { move: { x: 0, y: 0 }, dash: false, drop: drop("bay", 0, 0, cargo) } as InputCommand);
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    const racers = snapshot.bots.filter((bot) => bot.id.startsWith("racer-"));
    expect(racers.flatMap((bot) => [...bot.bays.filter(Boolean), ...bot.hold])).toEqual([cargo]);
    expect(snapshot.bots.find((bot) => bot.id === "dropper")?.bays.filter(Boolean)).toEqual([]);
    expect(snapshot.dots.find((dot) => dot.id.startsWith("runtime-drop-"))).toBeUndefined();
    simulation.dispose();
  });

  it("accepts a drop precondition exactly once and rejects a stale shifted hold index", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ bays: [healthItem, null, null], hold: [radarItem, overchargeItem] }),
    ]);
    const first = drop("hold", 0, 0);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, drop: first } as InputCommand);
    simulation.step();
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, drop: first } as InputCommand);
    simulation.step();

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(player.inventoryRevision).toBe(1);
    expect(player.hold).toEqual([overchargeItem]);
    expect(simulation.getSnapshot().dots.filter((dot) => dot.id.startsWith("runtime-drop-"))).toHaveLength(1);
    simulation.dispose();
  });

  it("gives a valid drop authoritative precedence over a same-frame swap", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ bays: [healthItem, null, null], hold: [radarItem] }),
    ]);
    simulation.applyInput("player", {
      move: { x: 0, y: 0 },
      dash: false,
      drop: drop("hold", 0, 0),
      swapBay: { bayIndex: 0, holdIndex: 0 },
    } as InputCommand);
    simulation.step();

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")).toMatchObject({
      bays: [healthItem, null, null],
      hold: [],
      inventoryRevision: 1,
    });
    expect(snapshot.coverages.some((coverage) => coverage.kind === "swap")).toBe(false);
    expect(snapshot.dots.filter((dot) => dot.id.startsWith("runtime-drop-"))).toHaveLength(1);
    simulation.dispose();
  });

  it("rejects invalid drops without duplication or loss and leaves full-inventory pickups in the world", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({
          position: { x: 100, y: 100 },
          bays: [healthItem],
          hold: [radarItem],
        }),
      ], [{ id: "world-item", item: overchargeItem, position: { x: 100, y: 100 } }]),
      config: { ...testConfig, baySlots: 1, holdSlots: 1 },
    });

    for (const drop of [
      { from: "bay", index: -1 },
      { from: "bay", index: 1.5 },
      { from: "bay", index: 99 },
      { from: "hold", index: -1 },
      { from: "hold", index: 99 },
      { from: "forged", index: 0 },
      { from: "bay", index: 0, revision: 0, expected: mineItem },
      { from: "bay", index: 0, revision: 0, expected: null },
    ]) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, drop } as InputCommand);
      simulation.step();
    }

    runTicks(simulation, 12);
    const snapshot = simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player")!;
    expect(player.bays).toEqual([healthItem]);
    expect(player.hold).toEqual([radarItem]);
    expect(snapshot.dots.filter((dot) => dot.id.startsWith("runtime-drop-"))).toEqual([]);
    expect(snapshot.dots.find((dot) => dot.id === "world-item")?.active).toBe(true);
    simulation.dispose();
  });

  it("keeps a world channel running when an item is dropped", async () => {
    const map = makeMap([playerSpawn({
      position: { x: 100, y: 180 },
      bays: [healthItem, null, null],
      hold: [radarItem],
    })]);
    map.extractionPoints = [{ id: "exit", name: "EXIT", rect: { x: 60, y: 140, w: 80, h: 80 } }];
    const simulation = await DotBotSimulation.create({ map, config: { ...testConfig, extractionDurationMs: 1_000 } });
    simulation.step();
    const before = simulation.getSnapshot().coverages.find((coverage) => coverage.kind === "extract")!;

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, drop: drop("bay", 0, 0) } as InputCommand);
    simulation.step();
    const after = simulation.getSnapshot().coverages.find((coverage) => coverage.kind === "extract")!;
    expect(after.progressMs).toBeGreaterThan(before.progressMs);
    expect(simulation.getSnapshot().dots.some((dot) => dot.id.startsWith("runtime-drop-"))).toBe(true);
    simulation.dispose();
  });

  it("fires health with one-plate restore and caps at maximum", async () => {
    const simulation = await makeSimulation([playerSpawn({ maxShields: 3, shields: 1, bays: [healthItem, healthItem, null, null] })]);
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: 0 });
    simulation.step();
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.shields).toBe(2);
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: 1 });
    simulation.step();
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.shields).toBe(3);
    simulation.dispose();
  });

  it("records and ages through-wall radar ping marks", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ bays: [radarItem, null, null, null] }),
        enemySpawn({ position: { x: 180, y: 180 } }),
      ]),
      config: { ...testConfig, radarDurationMs: 300, radarPingIntervalMs: 50, radarRadius: 200, radarPingTtlMs: 120 },
    });
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: 0 });
    runTicks(simulation, 5);
    const ping = simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.radarPings[0];
    expect(ping).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(ping!.ageMs).toBeGreaterThan(0);
    runTicks(simulation, 30);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.radarPings).toEqual([]);
    simulation.dispose();
  });

  it("places mines silently, consumes bays, and rotates the oldest at the active cap", async () => {
    const simulation = await DotBotSimulation.create({
      // One placement past the cap is what proves rotation, so the cap sits one
      // below the bay count rather than at it.
      map: makeMap([playerSpawn({ bays: Array.from({ length: defaultGameConfig.baySlots }, () => mineItem) })]),
      config: { ...testConfig, maxActiveMines: defaultGameConfig.baySlots - 1 },
    });
    for (let bay = 0; bay < defaultGameConfig.baySlots; bay += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: bay });
      simulation.step();
    }
    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays).toEqual(emptyBays());
    expect(snapshot.mines.map((mine) => mine.id)).toEqual(["mine-player-1", "mine-player-2"]);
    expect(snapshot.noises).toEqual([]);
    expect(simulation.drainEvents()).toContainEqual({ type: "mineRotated", botId: "player", mineId: "mine-player-0" });
    simulation.dispose();
  });

  it("lets ambient greys trigger a mine, shatters one intact plate, and downs a plateless bot", async () => {
    const plated = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ bays: [mineItem, null, null, null] }),
        enemySpawn({ controller: "frozen", position: { x: 100, y: 180 }, maxShields: 3, shields: 3 }),
      ]),
      config: testConfig,
    });
    plated.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: 0 });
    plated.step();
    const platedEnemy = plated.getSnapshot().bots.find((bot) => bot.id === "enemy")!;
    expect(platedEnemy).toMatchObject({ state: "alive", shields: 2 });
    expect(platedEnemy.shieldSegments.filter((plate) => plate === 1)).toHaveLength(2);
    expect(plated.getSnapshot().noises).toContainEqual(expect.objectContaining({ kind: "mineDetonation", loudness: 1 }));
    plated.dispose();

    const plateless = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ bays: [mineItem, null, null, null] }),
        enemySpawn({ controller: "frozen", position: { x: 100, y: 180 }, maxShields: 3, shields: 0 }),
      ]),
      config: testConfig,
    });
    plateless.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: 0 });
    plateless.step();
    expect(plateless.getSnapshot().bots.find((bot) => bot.id === "enemy")?.state).toBe("downed");
    expect(plateless.drainEvents()).toContainEqual(expect.objectContaining({
      type: "downed",
      botId: "enemy",
      byBotId: "player",
      cause: expect.objectContaining({
        kind: "mine",
        tick: 1,
        position: { x: 100, y: 180 },
      }),
    }));
    plateless.dispose();
  });

  it("emits floor-scoped sensor pings only while an intruder is in range and radar reveals only to its firer", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ bays: [mineItem, null, null, null], position: { x: 100, y: 180 } }),
        enemySpawn({ id: "radar-enemy", controller: "human", isAmbient: false, position: { x: 220, y: 180 }, bays: [radarItem, null, null, null] }),
        allySpawn({ id: "ally", controller: "frozen", position: { x: 350, y: 180 } }),
      ]),
      config: { ...testConfig, mineSenseRadius: 160, mineSensePingMs: 50, radarRadius: 200, radarDurationMs: 150 },
    });
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: 0 });
    simulation.step();
    runTicks(simulation, 3);
    expect(simulation.drainEvents()).toContainEqual(expect.objectContaining({ type: "mineSensor", squadId: "alpha", floorId: "outdoor" }));

    simulation.applyInput("radar-enemy", { move: { x: 0, y: 0 }, dash: false, useBay: 0 });
    simulation.step();
    const mine = simulation.getSnapshot().mines[0];
    expect(mine.revealedToBotIds).toEqual(["radar-enemy"]);
    runTicks(simulation, 10);
    expect(simulation.getSnapshot().mines[0].revealedToBotIds).toEqual([]);
    simulation.dispose();
  });


  it("lets a body come to rest against a bare core, not around it", async () => {
    /**
     * "It just seems odd that there's an invisible barrier around the core."
     *
     * Reported from play, and the exact symptom of separating at a fixed radius
     * while the core is drawn at four tenths of one: you stop 48 units from the
     * centre of a bot whose core surface is at 9.6, leaving thirty-odd units of
     * nothing between your edge and the thing you are trying to reach.
     *
     * Bodies settle at the sum of their reaches, so a fully plated bot's hull comes
     * to rest exactly on a stripped bot's core. Asserted against the sum rather
     * than a constant, and separately against the old circle, so neither a retune
     * of the reaches nor a quiet revert to `radius` can pass.
     */
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 200, y: 180 }, maxShields: 3, shields: 3 }),
      enemySpawn({
        position: { x: 232, y: 180 },
        maxShields: 3,
        shields: 0,
        isAmbient: false,
        controller: "frozen",
      }),
    ]);
    // Walk into them and hold, so separation has something to resolve every tick.
    for (let tick = 0; tick < 90; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
      simulation.step();
    }
    const bots = simulation.getSnapshot().bots;
    const a = bots.find((bot) => bot.id === "player")!;
    const b = bots.find((bot) => bot.id === "enemy")!;
    const gap = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
    simulation.dispose();

    const toward = Math.atan2(b.position.y - a.position.y, b.position.x - a.position.x);
    const expected = contactReach(a.radius, a.facing, a.shieldSegments, toward)
      + contactReach(b.radius, b.facing, b.shieldSegments, toward + Math.PI);
    expect(gap).toBeLessThan(expected + 2);
    // And decisively inside the circle two bodies used to hold each other at.
    expect(gap).toBeLessThan(a.radius + b.radius - 8);
  });

  it("does not let a squad walking in file rest inside itself", async () => {
    /**
     * The welding, as one number.
     *
     * Bodies were held apart by `contactReach(a, u) + contactReach(b, -u)`, which
     * samples ONE ray of a body that is a core disc with plate sectors bolted on.
     * That predicate is necessary and NOT sufficient, and this is the pose where
     * that bites hardest — the commonest clump in the game, two bots walking one
     * behind the other:
     *
     *   follower, plates up, reads its own +x  -> plate 0            -> 24.0
     *   leader,   one plate gone, reads its -x -> EXACTLY ANTIPODAL
     *
     * Exactly antipodal is a three-way tie in `coveringPlate`: for a 3-plate bot
     * the reverse direction is 60 degrees from two plate centres at once, and which
     * one wins is decided by comparing two floating-point numbers that are
     * mathematically equal. It lands on the broken plate, so the leader reports 9.6
     * and the pair settles at 33.6 — with 14.4 units of the follower's hull inside
     * the leader's live plating, at ZERO push, forever. Not a fight the solver was
     * losing; a fight it had finished in the wrong place.
     *
     * The real contact distance is 48.0, which `contactDistance` gets right because
     * a closed union of plate sectors has nothing to tie-break: the seam belongs to
     * the plate either way.
     *
     * Both bots are human-controlled and driven by input, so there is no AI, no
     * pathing and no wander that could supply motion and hide a stalled solver. The
     * leader walks into the east wall and stops; the follower closes on its back.
     */
    const simulation = await makeSimulation([
      playerSpawn({ id: "follower", name: "Follower", position: { x: 400, y: 180 }, maxShields: 3, shields: 3 }),
      playerSpawn({ id: "leader", name: "Leader", squadId: "alpha", position: { x: 440, y: 180 }, maxShields: 3, shields: 2 }),
    ]);
    for (let tick = 0; tick < 120; tick += 1) {
      simulation.applyInput("follower", { move: { x: 1, y: 0 }, dash: false });
      simulation.applyInput("leader", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
    }
    const bots = simulation.getSnapshot().bots;
    simulation.dispose();
    const follower = bots.find((bot) => bot.id === "follower")!;
    const leader = bots.find((bot) => bot.id === "leader")!;
    // Both ended up facing the way they walked, which is what puts the leader's
    // broken plate exactly astern. If that stops being true the test is measuring
    // something else, so it is asserted rather than assumed.
    expect(follower.facing).toBeCloseTo(0, 6);
    expect(leader.facing).toBeCloseTo(0, 6);
    expect(leader.shieldSegments).toEqual([1, 1, 0]);

    const gap = leader.position.x - follower.position.x;
    // 48.0 is where two 24-radius bodies touch, and a plate IS the body's surface.
    // The ray predicate rests at 33.600 here, so this fails by 14.4 units.
    expect(gap).toBeGreaterThan(47.9);
  });

  it("never leaves a crowd at rest inside itself", async () => {
    /**
     * The same rule as the test above, stated as an invariant over a scrum rather
     * than a hand-built pose, and checked against the exact geometry.
     *
     * Steering is switched off for the second half deliberately. Penetration DURING
     * a scrum is legitimate and transient — a bot that turns can grow 14.4 units
     * into a neighbour in a single tick, and the capped push takes two or three
     * ticks to undo it. What may never happen is penetration that SURVIVES with
     * nobody pushing. So: jam five bodies together, let go, and leave separation as
     * the only thing running.
     *
     * This one is broad rather than sharp. It did NOT fail on the ray predicate at
     * this seed: five bodies settled into poses where the ray sum happened to agree
     * with the truth, which is the trouble with sampling a 31%-of-poses defect
     * five pairs at a time. It is kept because it pins the general property the
     * pose test above pins one instance of — and the pose test is the one that
     * bites.
     */
    const CROWD = [
      { id: "a", position: { x: 250, y: 180 }, shields: 2, drive: { x: 1, y: 0 } },
      { id: "b", position: { x: 268, y: 186 }, shields: 1, drive: { x: -1, y: 0 } },
      { id: "c", position: { x: 258, y: 200 }, shields: 3, drive: { x: 0, y: -1 } },
      { id: "d", position: { x: 236, y: 194 }, shields: 0, drive: { x: 0.7, y: -0.7 } },
      { id: "e", position: { x: 244, y: 166 }, shields: 2, drive: { x: -0.6, y: 0.8 } },
    ];
    const simulation = await makeSimulation(
      CROWD.map((bot) => playerSpawn({
        id: bot.id,
        name: bot.id,
        squadId: "alpha",
        position: bot.position,
        maxShields: 3,
        shields: bot.shields,
      })),
    );
    // Drive them into each other so the facings end up mixed and unaligned — the
    // poses where a ray test and the real geometry disagree are the awkward ones,
    // not the tidy head-on ones a hand-built case would produce.
    for (let tick = 0; tick < 180; tick += 1) {
      for (const bot of CROWD) simulation.applyInput(bot.id, { move: bot.drive, dash: false });
      simulation.step();
    }
    // Then let go. No thrust, no steering, no AI: separation alone.
    for (let tick = 0; tick < 240; tick += 1) {
      for (const bot of CROWD) simulation.applyInput(bot.id, { move: { x: 0, y: 0 }, dash: false });
      simulation.step();
    }
    const bots = simulation.getSnapshot().bots;
    simulation.dispose();

    const shapeOf = (bot: GameSnapshot["bots"][number]) => {
      const shape = makeContactShape(bot.shieldSegments.length);
      buildContactShape(shape, bot.radius, bot.facing, bot.shieldSegments);
      return shape;
    };
    let worst = { pair: "", penetration: 0 };
    for (let i = 0; i < bots.length; i += 1) {
      for (let j = i + 1; j < bots.length; j += 1) {
        const a = bots[i];
        const b = bots[j];
        const dx = b.position.x - a.position.x;
        const dy = b.position.y - a.position.y;
        const dist = Math.hypot(dx, dy);
        const need = contactDistance(shapeOf(a), shapeOf(b), dx / dist, dy / dist);
        if (need - dist > worst.penetration) {
          worst = { pair: `${a.id}|${b.id}`, penetration: need - dist };
        }
      }
    }
    // A tenth of a unit: the solver closes at 10 units a tick, so anything it has
    // actually finished with is exact. This fails by 12.5 units on the ray test.
    expect(worst.penetration, `deepest resting overlap: ${worst.pair}`).toBeLessThan(0.1);
  });

  it("a dash reaches a bare arc closer than it reaches a plate", async () => {
    /**
     * The whole point of the plate rule, as an observable.
     *
     * Bodies separate at their full radius whatever their plates are doing — that
     * is the solver's business and it needs a body that keeps its shape. Only the
     * attack test follows the plates, and this is what that buys: a dash coming in
     * where a plate is missing gets nearer the victim's centre than one that lands
     * on armour, because there is less of the victim there.
     *
     * Sampled on the tick the hit lands, not at rest. Measured at rest it proves
     * nothing at all — separation pushes both cases back out to a full body width
     * within a few ticks, and the test passed with the plate rule deleted.
     */
    const landedAt = async (shields: number): Promise<number> => {
      const simulation = await DotBotSimulation.create({
        map: makeMap([
          playerSpawn({ position: { x: 160, y: 180 } }),
          enemySpawn({ position: { x: 260, y: 180 }, maxShields: 3, shields, controller: "frozen" }),
        ]),
        config: testConfig,
      });
      const before = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")!;
      let landed = Infinity;
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
      for (let tick = 0; tick < 24 && landed === Infinity; tick += 1) {
        simulation.step();
        const bots = simulation.getSnapshot().bots;
        const a = bots.find((bot) => bot.id === "player")!;
        const b = bots.find((bot) => bot.id === "enemy")!;
        const hit = b.state !== before.state
          || b.shieldSegments.join("") !== before.shieldSegments.join("");
        if (hit) landed = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
      }
      simulation.dispose();
      return landed;
    };

    const ontoPlate = await landedAt(3);
    const intoTheGap = await landedAt(0);
    expect(ontoPlate).toBeLessThan(Infinity);
    expect(intoTheGap).toBeLessThan(Infinity);
    expect(intoTheGap).toBeLessThan(ontoPlate - 8);
  });

  it("uses exactly three overcharged dashes through an existing cooldown", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap([playerSpawn({ bays: [overchargeItem, null, null, null] })]),
      config: { ...testConfig, dashCooldownMs: 2000 },
    });
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    runTicks(simulation, 10);
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false, useBay: 0 });
    simulation.step();
    for (let use = 0; use < 3; use += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
      simulation.step();
      expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.dashActiveMs).toBeGreaterThan(0);
      runTicks(simulation, 10);
    }
    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(player.dashOverchargeCharges).toBe(0);
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.dashActiveMs).toBe(0);
    simulation.dispose();
  });

  it("suppresses both firing and dash noise under incognito", async () => {
    const simulation = await makeSimulation([playerSpawn({ bays: [incognitoItem] })]);
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true, useBay: 0 });
    simulation.step();
    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")?.incognitoMs).toBeGreaterThan(0);
    expect(snapshot.noises).toEqual([]);
    simulation.dispose();
  });

  it("never banks useBay when the selected bay is empty", async () => {
    const simulation = await makeSimulation(
      [playerSpawn({ position: { x: 100, y: 100 } })],
      [{ id: "health", item: healthItem, position: { x: 100, y: 100 } }],
    );
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, useBay: 0 });
    simulation.step();
    runTicks(simulation, 18);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.bays[0]).toEqual(healthItem);
    simulation.dispose();
  });

  it("runs a stationary noisy hold-to-bay swap channel", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap([playerSpawn({ bays: [healthItem], hold: [radarItem] })]),
      config: { ...testConfig, swapDurationMs: 800 },
    });
    const start = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false, swapBay: { bayIndex: 0, holdIndex: 0 } });
    runTicks(simulation, 45);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.position).toEqual(start);
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 5);
    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(player.bays[0]).toEqual(radarItem);
    expect(player.hold).toEqual([healthItem]);
    expect(simulation.getSnapshot().noises.some((noise) => noise.kind === "channel")).toBe(true);
    simulation.dispose();
  });

  it("ignores a swap into a bay the bot does not have", async () => {
    /**
     * The bay index arrives from a client and is untrusted. It used to be typed as
     * a literal union, which checks nothing across a JSON boundary, and the only
     * guard was `bayIndex < bays.length` — so a negative index passed. Downstream,
     * `bays[-1] = held` sets a stray string key rather than a slot, and
     * `hold.splice(-1, 1)` removes the *last* hold item, so a client could destroy
     * one of its own items and put it nowhere.
     */
    const simulation = await DotBotSimulation.create({
      map: makeMap([playerSpawn({ bays: [healthItem], hold: [radarItem, incognitoItem] })]),
      config: { ...testConfig, swapDurationMs: 800 },
    });
    for (const bayIndex of [-1, 99, 1.5]) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, swapBay: { bayIndex, holdIndex: 0 } });
      runTicks(simulation, 50);
    }
    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(player.bays[0]).toEqual(healthItem);
    expect(player.hold).toEqual([radarItem, incognitoItem]);
    simulation.dispose();
  });

  it("holds AI bots steady while they cover Dots", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap(
        [enemySpawn({ isAmbient: false, position: { x: 120, y: 180 } })],
        [{ id: "dot", item: healthItem, position: { x: 100, y: 180 } }],
      ),
      config: {
        ...testConfig,
        dotCaptureDurationMs: 3000,
      },
    });

    runTicks(simulation, 110);
    const firstHold = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.position;
    runTicks(simulation, 30);
    const secondHold = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.position;

    expect(firstHold).toBeDefined();
    expect(secondHold).toBeDefined();
    expect(Math.hypot((secondHold!.x - firstHold!.x), (secondHold!.y - firstHold!.y))).toBeLessThan(1);
    expect(simulation.getSnapshot().dots.find((dot) => dot.id === "dot")?.active).toBe(true);
    simulation.dispose();
  });

  it("never sends an escort to loot, reachable or otherwise", async () => {
    const baseMap = makeMap(
      [enemySpawn({ isAmbient: false, position: { x: 50, y: 300 } })],
      [
        { id: "blocked-a", item: healthItem, position: { x: 100, y: 210 } },
        { id: "blocked-b", item: healthItem, position: { x: 112, y: 210 } },
        { id: "reachable", item: healthItem, position: { x: 400, y: 300 } },
      ],
    );
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        outdoor: {
          ...baseMap.outdoor,
          walls: [
            ...baseMap.outdoor.walls,
            { id: "block-a", x: 60, y: 170, w: 80, h: 80 },
          ],
        },
      },
      config: testConfig,
    });

    runTicks(simulation, 300);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.dots.find((dot) => dot.id === "blocked-a")?.active).toBe(true);
    expect(snapshot.dots.find((dot) => dot.id === "blocked-b")?.active).toBe(true);
    expect(snapshot.dots.find((dot) => dot.id === "reachable")?.active).toBe(true);
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.carriedCount).toBe(0);
    simulation.dispose();
  });

  it("lets AI bots initiate Dash attacks against visible rivals", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 240, y: 180 }, maxShields: 1, shields: 1 }),
      enemySpawn({ position: { x: 120, y: 180 } }),
    ]);

    let sawDash = false;
    let playerWasDowned = false;
    // Stop-at-contact makes each dash exactly one hit, so downing a target
    // through its rear (half-crack) arc takes multiple dash cycles.
    for (let tick = 0; tick < 240; tick += 1) {
      simulation.step();
      const snapshot = simulation.getSnapshot();
      sawDash ||= snapshot.noises.some((noise) => noise.kind === "dash");
      playerWasDowned ||= snapshot.bots.find((bot) => bot.id === "player")?.state === "downed";
      if (playerWasDowned) {
        break;
      }
    }

    expect(sawDash).toBe(true);
    expect(playerWasDowned).toBe(true);
    simulation.dispose();
  });

  it("drops a dash pressed during cooldown instead of banking it", async () => {
    const simulation = await makeSimulation([playerSpawn({ position: { x: 100, y: 180 } })]);

    // First dash fires normally.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    expect(simulation.getSnapshot().bots[0]?.dashActiveMs).toBeGreaterThan(0);

    // Press again mid-cooldown: the press must be consumed and discarded,
    // never banked to auto-fire when the cooldown expires.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();

    // Ride out the first dash (~9 ticks), then watch well past cooldown
    // expiry (testConfig cooldown = 300ms = 18 ticks): no second dash.
    let redashed = false;
    for (let tick = 0; tick < 40; tick += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
      if (tick > 10 && (simulation.getSnapshot().bots[0]?.dashActiveMs ?? 0) > 0) {
        redashed = true;
      }
    }

    expect(redashed).toBe(false);
    simulation.dispose();
  });

  it("never lets ambient AI acquire an extraction channel", async () => {
    const baseMap = makeMap([enemySpawn({ position: { x: 100, y: 100 }, bays: testBays(3), hold: [] })]);
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        extractionPoints: [{ id: "rival-pad", name: "RIVAL PAD", rect: { x: 60, y: 60, w: 80, h: 80 } }],
      },
      config: testConfig,
    });

    let sawExtraction = false;
    for (let tick = 0; tick < 60; tick += 1) {
      simulation.step();
      sawExtraction ||= simulation.getSnapshot().coverages.some((coverage) => coverage.kind === "extract");
    }

    const snapshot = simulation.getSnapshot();
    expect(sawExtraction).toBe(false);
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.bays.filter(Boolean).length).toBe(0);
    simulation.dispose();
  });

  it("never lets an ambient grey capture a dot", async () => {
    const simulation = await makeSimulation(
      [enemySpawn({ controller: "frozen", position: { x: 100, y: 100 } })],
      [{ id: "loot", item: radarItem, position: { x: 100, y: 100 } }],
    );
    runTicks(simulation, 30);
    expect(simulation.getSnapshot().dots.find((dot) => dot.id === "loot")?.active).toBe(true);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.bays.every((item) => item === null)).toBe(true);
    simulation.dispose();
  });

  it("never lets a frozen bot open a channel on a body it is standing on", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 100 }, state: "downed", shields: 0 }),
      enemySpawn({ controller: "frozen", position: { x: 100, y: 100 } }),
    ]);
    runTicks(simulation, 30);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.state).toBe("downed");
    expect(simulation.getSnapshot().coverages.some((coverage) => coverage.kind === "loot")).toBe(false);
    simulation.dispose();
  });

  it("lets a coverer walk off a body mid-channel instead of pinning it", async () => {
    /**
     * Standing on a downed bot used to zero the coverer's movement until the
     * channel finished, which from the keyboard reads as the character being stuck.
     * The range check is the only mechanism the channel needs: stay to continue,
     * walk away to cancel.
     */
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ position: { x: 100, y: 180 } }),
        enemySpawn({
          id: "victim", isAmbient: false, controller: "frozen", squadId: "rival-1",
          position: { x: 100, y: 180 }, state: "downed", shields: 0, bays: [healthItem], hold: [],
        }),
      ]),
      config: { ...testConfig, lootDurationMs: 4000 },
    });
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 4);
    expect(simulation.getSnapshot().coverages.some((entry) => entry.kind === "loot")).toBe(true);

    const before = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;
    for (let tick = 0; tick < 40; tick += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false, downedVerb: "loot" });
      simulation.step();
    }
    const after = simulation.getSnapshot();
    const player = after.bots.find((bot) => bot.id === "player")!;
    expect(player.position.x).toBeGreaterThan(before.x + 20);
    // Walked out of range, so the channel is gone and the body keeps its cargo.
    expect(after.coverages.some((entry) => entry.kind === "loot")).toBe(false);
    expect(after.bots.find((bot) => bot.id === "victim")?.bays.filter(Boolean)).toEqual([healthItem]);
    simulation.dispose();
  });

  it("keeps a downed bot indefinitely without a bleed-out timer", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ state: "downed", shields: 0, controller: "frozen" }),
    ]);
    runTicks(simulation, 1200);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.state).toBe("downed");
    simulation.dispose();
  });

  it("breaks a plate with the first dash and the core with the second", async () => {
    // One plate covers every angle, so this is the shortest possible fight: the
    // dash that lands on the plate breaks it and leaves the bot up, and only the
    // hit that finds the arc where the plate used to be puts it down.
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 156, y: 180 }, maxShields: 1, shields: 1, controller: "frozen" }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 18);

    const stripped = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy");
    // Naked, and still standing. That is the whole point of the change.
    expect(stripped?.shields).toBe(0);
    expect(stripped?.state).toBe("alive");

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    runTicks(simulation, 20);

    const enemy = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy");
    expect(enemy?.state).toBe("downed");
    simulation.dispose();
  });

  it("turns a dash out of a sustained clinch into a no-damage bump", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 148, y: 180 }, controller: "frozen" }),
    ]);

    // Contact has to PERSIST to disarm, so hold the clinch first. One tick of it is
    // an accident; `DASH_CLINCH_TICKS` of it is standing on someone.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    for (let tick = 0; tick < 12; tick += 1) simulation.step();
    simulation.drainEvents();

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();

    const snapshot = simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player")!;
    const enemy = snapshot.bots.find((bot) => bot.id === "enemy")!;
    expect(enemy.shieldSegments).toEqual([1, 1, 1]);
    expect(player.dashActiveMs).toBe(0);
    expect(player.dashCooldownMs).toBeGreaterThan(0);
    expect(simulation.drainEvents()).toContainEqual(expect.objectContaining({
      type: "dashContact",
      result: "bump",
      botId: "enemy",
      byBotId: "player",
    }));
    simulation.dispose();
  });

  it("treats visible daylight as run-up instead of a point-blank bump", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 151, y: 180 }, controller: "frozen" }),
    ]);

    // Three pixels outside the real 48 px contact span. This is inside the
    // four-pixel HIT forgiveness ring, but it is not physical starting contact.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();

    const events = simulation.drainEvents();
    expect(events).toContainEqual(expect.objectContaining({
      type: "hit",
      botId: "enemy",
      byBotId: "player",
      result: "plateBreak",
    }));
    expect(events.some((event) => event.type === "dashContact" && event.result === "bump")).toBe(false);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")!.shields).toBe(2);
    simulation.dispose();
  });

  it("lets a bot dash away from contact without creating a bump", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 148, y: 180 }, controller: "frozen" }),
    ]);

    simulation.applyInput("player", { move: { x: -1, y: 0 }, dash: true });
    simulation.step();

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")!.position.x).toBeLessThan(100);
    expect(snapshot.bots.find((bot) => bot.id === "player")!.dashActiveMs).toBeGreaterThan(0);
    expect(snapshot.bots.find((bot) => bot.id === "enemy")!.shieldSegments).toEqual([1, 1, 1]);
    expect(simulation.drainEvents().some((event) => event.type === "dashContact")).toBe(false);
    simulation.dispose();
  });

  /**
   * The half of the run-up rule that play reported as broken.
   *
   * Disarming on a snapshot — touching on the tick you pressed, full stop — reads as
   * arbitrary, because one tick of contact is not something a player can see or
   * avoid. A body closing under dash covers 10.7 px in a tick, which is most of the
   * daylight a hunter holds, and the separation solver then parks the pair at a gap
   * of exactly zero. Reported as bumps "even when we didn't start as touching".
   *
   * So a brush does not disarm and a clinch does. This is the discriminating case:
   * it passes only because contact now has to persist.
   */
  it("does not disarm a dash for a moment of incidental contact", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 148, y: 180 }, controller: "frozen" }),
    ]);

    // Spawned touching, so one tick of dwell is on the books — and one tick is a
    // brush. Under the old snapshot rule this dash was a bump.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    simulation.step();
    simulation.drainEvents();

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    const events = [];
    for (let tick = 0; tick < 4; tick += 1) {
      simulation.step();
      events.push(...simulation.drainEvents());
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "hit",
      botId: "enemy",
      byBotId: "player",
      result: "plateBreak",
    }));
    expect(events.some((event) => event.type === "dashContact" && event.result === "bump")).toBe(false);
    simulation.dispose();
  });

  it("re-arms a dash as soon as the clinch is broken", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 148, y: 180 }, controller: "frozen" }),
    ]);

    // Long enough in contact to be disarmed.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    for (let tick = 0; tick < 12; tick += 1) simulation.step();

    // Then break off. Daylight resets the dwell, because breaking off is the
    // counterplay and it should work the instant you do it.
    simulation.applyInput("player", { move: { x: -1, y: 0 }, dash: false });
    for (let tick = 0; tick < 4; tick += 1) simulation.step();
    simulation.drainEvents();

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    const events = [];
    for (let tick = 0; tick < 8; tick += 1) {
      simulation.step();
      events.push(...simulation.drainEvents());
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "hit",
      botId: "enemy",
      byBotId: "player",
      result: "plateBreak",
    }));
    expect(events.some((event) => event.type === "dashContact" && event.result === "bump")).toBe(false);
    simulation.dispose();
  });

  it("never wounds a body with a dash that is travelling away from it", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 148, y: 180 }, controller: "frozen" }),
    ]);

    // Held in contact past the disarm threshold, then dashing OUT of it. The swept
    // segment still starts within reach of the body, so the direction is the only
    // thing keeping this from registering as a hit.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    for (let tick = 0; tick < 12; tick += 1) simulation.step();
    simulation.drainEvents();

    simulation.applyInput("player", { move: { x: -1, y: 0 }, dash: true });
    const events = [];
    for (let tick = 0; tick < 4; tick += 1) {
      simulation.step();
      events.push(...simulation.drainEvents());
    }

    expect(events.some((event) => event.type === "hit")).toBe(false);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")!.shieldSegments)
      .toEqual([1, 1, 1]);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position.x)
      .toBeLessThan(100);
    simulation.dispose();
  });

  it.each([
    {
      name: "one target behind the other",
      targets: [{ x: 156, y: 180 }, { x: 204, y: 180 }],
    },
    {
      name: "both targets abreast of the attacker",
      targets: [{ x: 156, y: 156 }, { x: 156, y: 204 }],
    },
  ])("lets a third player damage a touching hostile pair: $name", async ({ targets }) => {
    for (const attackerFirst of [false, true]) {
      const targetSpawns = targets.map((position, index) => enemySpawn({
        id: `target-${index}`,
        position,
        controller: "human",
        isAmbient: false,
      }));
      const attacker = playerSpawn({ position: { x: 100, y: 180 } });
      const simulation = await makeSimulation(
        attackerFirst ? [attacker, ...targetSpawns] : [...targetSpawns, attacker],
      );

      // The targets begin in body contact with one another. That relationship
      // must not be mistaken for point-blank contact between the attacker and
      // whichever target its dash reaches first.
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
      simulation.step();

      const events = simulation.drainEvents();
      expect(events).toContainEqual(expect.objectContaining({
        type: "hit",
        byBotId: "player",
        result: "plateBreak",
      }));
      expect(
        simulation.getSnapshot().bots
          .filter((bot) => bot.id === "target-0" || bot.id === "target-1")
          .some((bot) => bot.shields < bot.maxShields),
      ).toBe(true);
      simulation.dispose();
    }
  });

  it("does not let a touching bystander suppress a third player's otherwise valid hit", async () => {
    const angles = Array.from({ length: 4 }, (_, index) => (index * Math.PI) / 2);
    for (const approachAngle of angles) {
      for (const pairAngle of angles) {
        const target = { x: 250, y: 180 };
        const pair = {
          x: target.x + Math.cos(pairAngle) * 48,
          y: target.y + Math.sin(pairAngle) * 48,
        };
        const attacker = {
          x: target.x - Math.cos(approachAngle) * 112,
          y: target.y - Math.sin(approachAngle) * 112,
        };
        const move = { x: Math.cos(approachAngle), y: Math.sin(approachAngle) };
        const simulation = await makeSimulation([
          enemySpawn({ id: "target", position: target, controller: "human", isAmbient: false }),
          enemySpawn({ id: "bystander", position: pair, controller: "human", isAmbient: false }),
          playerSpawn({ position: attacker }),
        ]);

        simulation.applyInput("player", { move, dash: true });
        for (let tick = 0; tick < 12; tick += 1) simulation.step();
        const events = simulation.drainEvents();
        const hit = events.some(
          (event) => event.type === "hit" && event.byBotId === "player",
        );
        expect(
          hit,
          `approach ${approachAngle.toFixed(2)}, pair ${pairAngle.toFixed(2)}; `
            + `events=${JSON.stringify(events)} snapshot=${JSON.stringify(simulation.getSnapshot().bots)}`,
        ).toBe(true);
        simulation.dispose();
      }
    }
  });

  it.each([
    { name: "player against rival player", leftAmbient: false, rightAmbient: false, shouldClash: true },
    { name: "player against ambient AI", leftAmbient: false, rightAmbient: true, shouldClash: true },
    { name: "ambient AI against ambient AI", leftAmbient: true, rightAmbient: true, shouldClash: false },
  ])("clashes plated hostile dashes but not ambient faction-mates: $name", async ({ leftAmbient, rightAmbient, shouldClash }) => {
    const leftId = leftAmbient ? "ambient-left" : "player";
    const rightId = rightAmbient ? "ambient-right" : "enemy";
    const left = leftAmbient
      ? enemySpawn({
        id: leftId,
        squadId: "rival-left",
        position: { x: 100, y: 180 },
        controller: "human",
        isAmbient: true,
      })
      : playerSpawn({ position: { x: 100, y: 180 } });
    const right = enemySpawn({
      id: rightId,
      squadId: "rival-right",
      position: { x: 196, y: 180 },
      controller: "human",
      isAmbient: rightAmbient,
    });
    const simulation = await makeSimulation([left, right]);

    simulation.applyInput(leftId, { move: { x: 1, y: 0 }, dash: true });
    simulation.applyInput(rightId, { move: { x: -1, y: 0 }, dash: true });
    let clash = false;
    for (let tick = 0; tick < 12 && !clash; tick += 1) {
      simulation.step();
      clash = simulation.drainEvents().some(
        (event) => event.type === "dashContact" && event.result === "clash",
      );
    }

    const snapshot = simulation.getSnapshot();
    expect(clash).toBe(shouldClash);
    expect(snapshot.bots.find((bot) => bot.id === leftId)!.shieldSegments).toEqual([1, 1, 1]);
    expect(snapshot.bots.find((bot) => bot.id === rightId)!.shieldSegments).toEqual([1, 1, 1]);
    if (shouldClash) {
      expect(snapshot.bots.find((bot) => bot.id === leftId)!.dashActiveMs).toBe(0);
      expect(snapshot.bots.find((bot) => bot.id === rightId)!.dashActiveMs).toBe(0);
    }
    simulation.dispose();
  });

  /**
   * Two bodies charging each other parry, and that must not depend on them pressing
   * on the same tick.
   *
   * A dash is 145 ms and ends the instant it connects, so whoever committed first has
   * usually spent theirs by the time the two actually meet — which made the parry a
   * coincidence rather than a read, and play reported it as almost never happening.
   * The grace is what makes "we both went for it" resolve the way it looks.
   */
  it("clashes charges that began several ticks apart", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({
        id: "enemy",
        squadId: "rival-1",
        position: { x: 320, y: 180 },
        controller: "human",
        isAmbient: false,
      }),
    ]);

    // The player commits first and is already most of the way through the lunge
    // before the enemy answers it.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    for (let tick = 0; tick < 7; tick += 1) simulation.step();
    simulation.applyInput("enemy", { move: { x: -1, y: 0 }, dash: true });

    const events = [];
    for (let tick = 0; tick < 12; tick += 1) {
      simulation.step();
      events.push(...simulation.drainEvents());
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "dashContact",
      result: "clash",
    }));
    expect(events.some((event) => event.type === "hit")).toBe(false);
    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")!.shieldSegments).toEqual([1, 1, 1]);
    expect(snapshot.bots.find((bot) => bot.id === "enemy")!.shieldSegments).toEqual([1, 1, 1]);
    simulation.dispose();
  });

  /**
   * A parry means nobody was hurt, so an exchange that already drew blood cannot
   * become one.
   *
   * The grace that lets staggered charges meet also let a charge that had ALREADY
   * landed stay "committed" while the victim swung back — so the pair recoiled with a
   * parry cue a beat after a plate had broken. Reported from play as parrying and
   * still losing a shield. A dash that resolved into damage is spent.
   */
  it("does not parry an exchange that has already landed a hit", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({
        id: "enemy",
        squadId: "rival-1",
        position: { x: 200, y: 180 },
        controller: "human",
        isAmbient: false,
      }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    const events = [];
    for (let tick = 0; tick < 6; tick += 1) {
      simulation.step();
      events.push(...simulation.drainEvents());
    }
    expect(events.some((event) => event.type === "hit")).toBe(true);

    // The victim answers well inside the parry grace.
    simulation.applyInput("enemy", { move: { x: -1, y: 0 }, dash: true });
    for (let tick = 0; tick < 8; tick += 1) {
      simulation.step();
      events.push(...simulation.drainEvents());
    }

    expect(events.some((event) => event.type === "dashContact" && event.result === "clash"))
      .toBe(false);
    simulation.dispose();
  });

  it("clashes opposing active dashes when only the first lag-compensated sweep connects", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({
        position: { x: 180, y: 180 },
        controller: "human",
        isAmbient: false,
      }),
    ]);
    runTicks(simulation, 3);
    // The enemy sees the player two ticks behind. On the collision tick the
    // player's sweep reaches the enemy, while the enemy's own directed sweep
    // is still short of that older perceived position.
    simulation.setViewDelayTicks("enemy", 2);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.applyInput("enemy", { move: { x: 0, y: 0 }, dash: false });
    simulation.step();
    simulation.drainEvents();

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    simulation.applyInput("enemy", { move: { x: -1, y: 0 }, dash: true });
    simulation.step();

    expect(simulation.drainEvents()).toContainEqual(expect.objectContaining({
      type: "dashContact",
      result: "clash",
    }));
    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")!.shieldSegments).toEqual([1, 1, 1]);
    expect(snapshot.bots.find((bot) => bot.id === "enemy")!.shieldSegments).toEqual([1, 1, 1]);
    simulation.dispose();
  });

  it("does not clash with an active dash moving away from the impact", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 380, y: 180 } }),
      enemySpawn({
        position: { x: 452, y: 180 },
        controller: "human",
        isAmbient: false,
      }),
    ]);

    // The enemy dashes east into the wall while the player catches it from the
    // west. Both dash windows are active, but they are not opposing attacks.
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.applyInput("enemy", { move: { x: 1, y: 0 }, dash: true });
    for (let tick = 0; tick < 12; tick += 1) simulation.step();

    const events = simulation.drainEvents();
    expect(events.some((event) => event.type === "dashContact" && event.result === "clash")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "hit",
      botId: "enemy",
      byBotId: "player",
      result: "plateBreak",
    }));
    simulation.dispose();
  });

  it("does not let a dash clash rescue an exposed core", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({
        position: { x: 196, y: 180 },
        controller: "human",
        isAmbient: false,
        shields: 0,
      }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.applyInput("enemy", { move: { x: -1, y: 0 }, dash: true });
    for (let tick = 0; tick < 12; tick += 1) simulation.step();

    const events = simulation.drainEvents();
    expect(events.some((event) => event.type === "dashContact" && event.result === "clash")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "hit",
      botId: "enemy",
      byBotId: "player",
      result: "downed",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "downed",
      botId: "enemy",
      byBotId: "player",
      cause: expect.objectContaining({ kind: "dash" }),
    }));
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")!.state).toBe("downed");
    simulation.dispose();
  });

  it("resolves dash damage through directional plates in half-shield steps", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 156, y: 180 }, controller: "frozen" }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 18);

    const enemy = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy");
    expect(enemy?.shields).toBeLessThan(3);
    // Damage only ever lands as whole plates. There is no fractional plate any more: a hit
    // takes an arc or reaches the core, so 0.5 had one producer (revive) and no rule.
    expect((enemy!.shields * 2) % 1).toBe(0);
    // The visible plates always account exactly for the shield total.
    expect(enemy!.shieldSegments.reduce((total, plate) => total + plate, 0)).toBe(enemy!.shields);
    expect(enemy!.shieldSegments.every((plate) => [0, 1].includes(plate))).toBe(true);
    simulation.dispose();
  });

  it("never applies friendly fire: a Dash through a squadmate leaves them unhurt", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      allySpawn({ position: { x: 156, y: 180 }, maxShields: 1, shields: 1 }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 18);

    const ally = simulation.getSnapshot().bots.find((bot) => bot.id === "ally");
    expect(ally?.state).toBe("alive");
    expect(ally?.shields).toBe(1);
    simulation.dispose();
  });

  it("never damages two same-squad AI bots during a Dash collision", async () => {
    const simulation = await makeSimulation([
      allySpawn({ id: "alpha-ai-1", position: { x: 100, y: 180 }, maxShields: 1, shields: 1 }),
      allySpawn({ id: "alpha-ai-2", position: { x: 145, y: 180 }, maxShields: 1, shields: 1 }),
      enemySpawn({ id: "rival-target", position: { x: 260, y: 180 }, maxShields: 1, shields: 1 }),
    ]);
    simulation.setController("rival-target", "frozen");

    runTicks(simulation, 30);

    const squad = simulation.getSnapshot().bots.filter((bot) => bot.squadId === "alpha");
    expect(squad.every((bot) => bot.state === "alive" && bot.shields === 1)).toBe(true);
    simulation.dispose();
  });

  it("never lets legacy ambient squad ids create ambient-on-ambient combat", async () => {
    const simulation = await makeSimulation([
      enemySpawn({ id: "ambient-a", squadId: "rival-a", position: { x: 100, y: 180 }, maxShields: 1, shields: 1 }),
      enemySpawn({ id: "ambient-b", squadId: "rival-b", position: { x: 220, y: 180 }, maxShields: 1, shields: 1 }),
    ]);

    const combatEvents = [];
    for (let tick = 0; tick < 180; tick += 1) {
      simulation.step();
      combatEvents.push(...simulation.drainEvents().filter(
        (event) => event.type === "hit" || event.type === "dashContact",
      ));
    }

    const bots = simulation.getSnapshot().bots;
    expect(combatEvents).toEqual([]);
    expect(bots.every((bot) => bot.state === "alive" && bot.shields === 1)).toBe(true);
    simulation.dispose();
  });

  it("opens a downed hostile bot without moving anything the player did not pick", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({
        isAmbient: false,
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        bays: [healthItem, radarItem, null], hold: [],
      }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 12);

    const opened = simulation.getSnapshot();
    const body = opened.bots.find((bot) => bot.id === "enemy")!;
    // Open, still lying there, and still holding everything: the channel bought
    // sight of the body, not its contents.
    expect(body.state).toBe("downed");
    expect(body.searched).toBe(true);
    expect(body.bays.filter(Boolean)).toEqual([healthItem, radarItem]);
    expect(opened.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean)).toEqual([]);
    expect(simulation.drainEvents()).toContainEqual({ type: "searched", botId: "enemy", byBotId: "player" });

    // Take the second item only. The first stays where it is.
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, take: { fromBotId: "enemy", index: 1 } });
    simulation.step();

    const after = simulation.getSnapshot();
    expect(after.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean)).toEqual([radarItem]);
    expect(after.bots.find((bot) => bot.id === "enemy")?.bays.filter(Boolean)).toEqual([healthItem]);
    expect(simulation.drainEvents()).toContainEqual({
      type: "looted", botId: "enemy", byBotId: "player", items: [radarItem],
    });
    simulation.dispose();
  });

  it("leaves what the taker cannot carry on the body instead of on the floor", async () => {
    // Overflow used to spill onto the ground as dots, which let the looter's own
    // full inventory throw away items it had never seen. Take-all now stops at the
    // last slot that fits and the rest stays on the body, for the next player.
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ position: { x: 100, y: 180 }, bays: [healthItem], hold: [] }),
        enemySpawn({
          isAmbient: false,
          position: { x: 100, y: 180 },
          state: "downed",
          shields: 0,
          bays: [overchargeItem],
          hold: [incognitoItem],
        }),
      ]),
      config: { ...testConfig, baySlots: 1, holdSlots: 1 },
    });
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 12);
    simulation.drainEvents();
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, take: { fromBotId: "enemy", index: "all" } });
    simulation.step();

    const snapshot = simulation.getSnapshot();
    expect(snapshot.dots.filter((dot) => dot.active)).toEqual([]);
    // One bay, one hold slot, one item already carried: exactly one more fits.
    expect(snapshot.bots.find((bot) => bot.id === "player")?.hold).toEqual([overchargeItem]);
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.hold).toEqual([incognitoItem]);
    expect(simulation.drainEvents()).toContainEqual({
      type: "looted",
      botId: "enemy",
      byBotId: "player",
      items: [overchargeItem],
    });
    simulation.dispose();
  });

  it("refuses a take before the channel that paid for it, and after walking off the body", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ isAmbient: false, position: { x: 100, y: 180 }, state: "downed", shields: 0, bays: [healthItem, null, null], hold: [] }),
    ]);

    // Underfoot but unsearched: the channel is the price of the picker.
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, take: { fromBotId: "enemy", index: 0 } });
    simulation.step();
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.bays.filter(Boolean)).toEqual([]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 12);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.searched).toBe(true);

    // Walk clear of the body. An open body stays open, but your hands still have
    // to be on it — a stale picker cannot reach across the room.
    for (let tick = 0; tick < 40; tick += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
    }
    const walked = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
    expect(walked.position.x - 100).toBeGreaterThan(defaultGameConfig.botRadius * 2);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, take: { fromBotId: "enemy", index: 0 } });
    simulation.step();
    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean)).toEqual([]);
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.bays.filter(Boolean)).toEqual([healthItem]);
    simulation.dispose();
  });

  it("does not re-open a body the player is still standing on with LOOT held", async () => {
    // A verb is standing state — it persists until the player picks the other one.
    // Without a guard the channel restarts the tick after it finishes and the same
    // body is searched again every three seconds, noise and all, forever.
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ isAmbient: false, controller: "frozen", position: { x: 100, y: 180 }, state: "downed", shields: 0, bays: [healthItem, null, null], hold: [] }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 12);
    expect(simulation.drainEvents().filter((event) => event.type === "searched")).toHaveLength(1);

    runTicks(simulation, 60);
    expect(simulation.drainEvents().filter((event) => event.type === "searched")).toEqual([]);
    expect(simulation.getSnapshot().coverages.filter((entry) => entry.kind === "loot")).toEqual([]);
    simulation.dispose();
  });

  it("grows a squad to four by picking up a rival that asked, and no further", async () => {
    /**
     * The only way a squad ever grows, and the only way a bot ever changes side.
     * Three load in; four is the cap.
     *
     * Gated on the plea, because a squad you did not ask to join is a capture rather
     * than a rescue. A downed AI asks on its own — otherwise the whole rule would be
     * dead in solo, where every rival is one — so the plea here needs no input, just a
     * tick on the floor.
     */
    const revive = Math.ceil((testConfig.coverDurationMs ?? 0) / (1000 / defaultGameConfig.tickHz)) + 2;
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ id: "recruit", squadId: "rival-1", isAmbient: false, controller: "frozen", position: { x: 100, y: 180 }, state: "downed", shields: 0 }),
    ]);
    // One tick on the floor is the plea.
    simulation.step();
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "recruit")!.pleaded).toBe(true);

    for (let tick = 0; tick < revive; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "revive" });
      simulation.step();
    }
    const recruit = simulation.getSnapshot().bots.find((bot) => bot.id === "recruit")!;
    simulation.dispose();

    expect(recruit.state).toBe("alive");
    // Changed side. `areFriendly` is squad equality, so this one field carries
    // friend-or-foe, no-friendly-fire, revive-versus-strip and squad vision with it.
    expect(recruit.squadId).toBe("alpha");
    // And the plea is spent: the next time it goes down it has to ask again.
    expect(recruit.pleaded).toBe(false);
  });

  it("will not pick up a rival that never asked", async () => {
    // An ambient bot never pleas — nothing is coming for it and it knows. So it is the
    // one body that stays un-recruitable, which makes it the clean negative case.
    const revive = Math.ceil((testConfig.coverDurationMs ?? 0) / (1000 / defaultGameConfig.tickHz)) + 2;
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ id: "stray", squadId: "rival-1", isAmbient: true, controller: "frozen", position: { x: 100, y: 180 }, state: "downed", shields: 0 }),
    ]);
    for (let tick = 0; tick < revive; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "revive" });
      simulation.step();
    }
    const stray = simulation.getSnapshot().bots.find((bot) => bot.id === "stray")!;
    // No channel was ever allowed to run, so there is nothing to show for it either.
    const coverages = simulation.getSnapshot().coverages;
    simulation.dispose();

    expect(stray.pleaded).toBe(false);
    expect(stray.state).toBe("downed");
    expect(stray.squadId).toBe("rival-1");
    expect(coverages.filter((coverage) => coverage.targetId === "stray")).toEqual([]);
  });

  it("closes a searched body back up when it is revived", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ isAmbient: false, controller: "frozen", position: { x: 100, y: 180 }, state: "downed", shields: 0, bays: [healthItem, null, null], hold: [] }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 12);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.searched).toBe(true);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "revive" });
    runTicks(simulation, Math.ceil((testConfig.coverDurationMs ?? 0) / (1000 / defaultGameConfig.tickHz)) + 2);

    const revived = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")!;
    expect(revived.state).toBe("alive");
    // On its feet and no longer an open container, with what nobody took.
    expect(revived.searched).toBe(false);
    expect(revived.bays.filter(Boolean)).toEqual([healthItem]);
    simulation.dispose();
  });

  it("uses the configured hostile channel durations and applies each verb outcome", async () => {
    const cases = [
      { verb: "loot" as const, durationMs: testConfig.lootDurationMs, finalState: "downed" as const },
      { verb: "revive" as const, durationMs: testConfig.coverDurationMs, finalState: "alive" as const },
    ] as const;

    for (const { verb, durationMs, finalState } of cases) {
      const simulation = await makeSimulation([
        playerSpawn({ position: { x: 100, y: 180 } }),
        enemySpawn({
          isAmbient: false,
          controller: "frozen",
          position: { x: 100, y: 180 },
          state: "downed",
          shields: 0,
          bays: [healthItem, radarItem],
          hold: [],
        }),
      ]);
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: verb });
      simulation.step();
      expect(simulation.getSnapshot().coverages).toContainEqual(expect.objectContaining({
        kind: verb,
        actorId: "player",
        targetId: "enemy",
        durationMs,
      }));
      runTicks(simulation, Math.ceil((durationMs ?? 0) / (1000 / defaultGameConfig.tickHz)) + 1);

      const snapshot = simulation.getSnapshot();
      const actor = snapshot.bots.find((bot) => bot.id === "player")!;
      const target = snapshot.bots.find((bot) => bot.id === "enemy")!;
      expect(target.state).toBe(finalState);
      if (verb === "revive") {
        // Revived on half a plate, and keeps everything it was carrying.
        expect(target.shieldSegments).toEqual([1, 0, 0]);
        expect(target.bays.filter(Boolean)).toEqual([healthItem, radarItem]);
        expect(actor.bays.filter(Boolean)).toEqual([]);
      } else {
        // Looting opens the body and leaves it down, holding what it held.
        expect(target.searched).toBe(true);
        expect(target.bays.filter(Boolean)).toEqual([healthItem, radarItem]);
        expect(actor.bays.filter(Boolean)).toEqual([]);
      }
      simulation.dispose();
    }
  });

  it("rate-limits player pleas and never lets an ambient grey plea", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ state: "downed", shields: 0 }),
      playerSpawn({ id: "grey", squadId: "grey", isAmbient: true, state: "downed", shields: 0 }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, plea: true });
    simulation.applyInput("grey", { move: { x: 0, y: 0 }, dash: false, plea: true });
    simulation.step();
    expect(simulation.drainEvents()).toEqual([
      expect.objectContaining({ type: "plea", botId: "player", squadId: "alpha" }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, plea: true });
    simulation.step();
    expect(simulation.drainEvents()).toEqual([]);

    runTicks(simulation, 10);
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, plea: true });
    simulation.step();
    expect(simulation.drainEvents()).toEqual([
      expect.objectContaining({ type: "plea", botId: "player" }),
    ]);
    simulation.dispose();
  });

  it("opens a downed hostile bot when standing over its footprint", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 122, y: 180 } }),
      enemySpawn({
        isAmbient: false,
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        bays: testBays(1), hold: [],
      }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("downed");
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.searched).toBe(true);
    simulation.dispose();
  });

  it("opens a downed hostile bot from a forgiving hover overlap", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 135, y: 180 } }),
      enemySpawn({
        isAmbient: false,
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        bays: testBays(1), hold: [],
      }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("downed");
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.searched).toBe(true);
    simulation.dispose();
  });

  it("does not loot a downed hostile bot from merely nearby", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 146, y: 180 } }),
      enemySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        bays: testBays(1), hold: [],
      }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("downed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean).length).toBe(0);
    simulation.dispose();
  });

  it("lets alive bots pass over downed bots without being blocked", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 80, y: 180 } }),
      enemySpawn({
        position: { x: 128, y: 180 },
        state: "downed",
        shields: 0,
        bays: testBays(0), hold: [],
      }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 32);

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.position.x).toBeGreaterThan(128);
    simulation.dispose();
  });

  it("revives a downed friendly bot for free, with one whole plate back", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 }, bays: testBays(0), hold: [] }),
      allySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
      }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.state).toBe("alive");
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.shields).toBe(1);
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.shieldSegments).toEqual([1, 0, 0]);
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean).length).toBe(0);
    simulation.dispose();
  });

  it("revives a downed friendly bot when standing over its footprint", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 122, y: 180 }, bays: testBays(1), hold: [] }),
      allySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
      }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.state).toBe("alive");
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.shields).toBe(1);
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean).length).toBe(1);
    simulation.dispose();
  });

  it("changes floors by walking across the stair break line, both directions", async () => {
    // Vertical run, bottom at the south end: walking north climbs to F2.
    const stairRect = { x: 250, y: 80, w: 60, h: 160 };
    const baseMap = makeMap([playerSpawn({ position: { x: 280, y: 210 } })]);
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        buildings: [
          {
            id: "tower",
            kind: "office",
            name: "TOWER",
            footprint: { x: 200, y: 60, w: 220, h: 240 },
            floors: [
              {
                id: "tower:GROUND",
                label: "GROUND",
                walls: [],
                doorways: [],
                objects: [],
                stairs: [
                  { id: "tower-up", rect: stairRect, direction: "up", toFloorId: "tower:F2", bottom: "S" },
                ],
                dotSpawns: [],
              },
              {
                id: "tower:F2",
                label: "F2",
                walls: [],
                doorways: [],
                objects: [],
                stairs: [
                  { id: "tower-down", rect: stairRect, direction: "down", toFloorId: "outdoor", bottom: "S" },
                ],
                dotSpawns: [],
              },
            ],
          },
        ],
      },
      config: testConfig,
    });

    // Standing still in the entry half does nothing.
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 20);
    let player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.floorId).toBe("outdoor");

    // Walk north through the run: crossing the midline swaps to F2 mid-stride.
    simulation.applyInput("player", { move: { x: 0, y: -1 }, dash: false });
    runTicks(simulation, 30);

    const snapshot = simulation.getSnapshot();
    player = snapshot.bots.find((bot) => bot.id === "player");
    expect(player?.floorId).toBe("tower:F2");

    // Taking the stairs announces itself on both connected floors.
    const stairNoises = snapshot.noises.filter((noise) => noise.kind === "stairs");
    expect(stairNoises.map((noise) => noise.floorId).sort()).toEqual(["outdoor", "tower:F2"]);

    // Walking back south through the run descends again.
    simulation.applyInput("player", { move: { x: 0, y: 1 }, dash: false });
    runTicks(simulation, 30);
    player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.floorId).toBe("outdoor");
    simulation.dispose();
  });

  it("lets ambient AI climb stairs after a valid player noise on another floor", async () => {
    const stairRect = { x: 250, y: 80, w: 60, h: 160 };
    const baseMap = makeMap([
      playerSpawn({ position: { x: 360, y: 180 }, floorId: "tower:F2" }),
      enemySpawn({ position: { x: 280, y: 210 } }),
    ]);
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        buildings: [
          {
            id: "tower",
            kind: "office",
            name: "TOWER",
            footprint: { x: 200, y: 60, w: 220, h: 240 },
            floors: [
              {
                id: "tower:GROUND",
                label: "GROUND",
                walls: [],
                doorways: [],
                objects: [],
                stairs: [{ id: "tower-ai-up", rect: stairRect, direction: "up", toFloorId: "tower:F2", bottom: "S" }],
                dotSpawns: [],
              },
              {
                id: "tower:F2",
                label: "F2",
                walls: [],
                doorways: [],
                objects: [],
                stairs: [{ id: "tower-ai-down", rect: stairRect, direction: "down", toFloorId: "outdoor", bottom: "S" }],
                dotSpawns: [],
              },
            ],
          },
        ],
      },
      config: testConfig,
    });

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    runTicks(simulation, 90);

    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.floorId).toBe("tower:F2");
    simulation.dispose();
  });

  it("emits extracted and removes the bot after an extraction channel", async () => {
    const baseMap = makeMap([playerSpawn({ position: { x: 100, y: 100 }, bays: testBays(2), hold: [] })]);
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        extractionPoints: [{ id: "pad", name: "PAD", rect: { x: 60, y: 60, w: 80, h: 80 } }],
      },
      config: testConfig,
    });

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 8);

    let snapshot = simulation.getSnapshot();
    expect(snapshot.coverages.some((coverage) => coverage.kind === "extract")).toBe(true);

    runTicks(simulation, 10);
    snapshot = simulation.getSnapshot();
    expect(snapshot.bots.some((bot) => bot.id === "player")).toBe(false);
    expect(simulation.drainEvents()).toContainEqual({ type: "extracted", botId: "player", squadId: "alpha", items: [healthItem, healthItem] });
    simulation.dispose();
  });

  it("emits a dash noise on the player's floor", async () => {
    const simulation = await makeSimulation([playerSpawn()]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();

    const noises = simulation.getSnapshot().noises;
    expect(noises.some((noise) => noise.kind === "dash" && noise.floorId === "outdoor")).toBe(true);
    simulation.dispose();
  });

  it("emits capture channel pings while covering a dot", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap(
        [playerSpawn({ position: { x: 100, y: 100 } })],
        [{ id: "dot", item: healthItem, position: { x: 100, y: 100 } }],
      ),
      config: { ...testConfig, dotCaptureDurationMs: 3000 },
    });

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 48); // ~800ms > one 700ms ping interval

    const noises = simulation.getSnapshot().noises;
    expect(noises.some((noise) => noise.kind === "channel")).toBe(true);
    simulation.dispose();
  });

  it("blocks line of sight through walls", () => {
    const baseMap = makeMap([]);
    const map: MapDocument = {
      ...baseMap,
      outdoor: {
        ...baseMap.outdoor,
        walls: [...baseMap.outdoor.walls, { id: "divider", x: 240, y: 80, w: 12, h: 220 }],
      },
    };

    expect(hasLineOfSight(map, "outdoor:street", { x: 100, y: 180 }, { x: 400, y: 180 })).toBe(false);
    expect(hasLineOfSight(map, "outdoor:street", { x: 100, y: 180 }, { x: 100, y: 320 })).toBe(true);
  });

  describe("AI canopy acquisition", () => {
    type CanopyBot = {
      id: string;
      position: Vec2;
      state: string;
      aiHuntTargetId?: string | null;
    };
    type CanopyInternals = {
      bots: Map<string, CanopyBot>;
      pickBotTarget: (bot: CanopyBot) => { intent: string; targetId?: string };
      squadMarks: Array<{
        squadId: string;
        kind: "enemy";
        position: Vec2;
        floorId: string;
        atMs: number;
      }>;
    };
    const tree = (id: string, x: number, y: number, size = 100) => ({
      id,
      kind: "tree" as const,
      x,
      y,
      w: size,
      h: size,
    });
    const makeCanopySimulation = async (
      playerAt: Vec2,
      watcherAt: Vec2,
      trees = [tree("canopy", 100, 130)],
      watcherAmbient = true,
    ) => {
      const smallMap = makeMap([
        playerSpawn({ position: playerAt }),
        enemySpawn({ id: "watcher", isAmbient: watcherAmbient, position: watcherAt }),
      ]);
      const baseMap = {
        ...smallMap,
        width: 1600,
        outdoor: { ...smallMap.outdoor, walls: bounds(1600, smallMap.height) },
      };
      return DotBotSimulation.create({
        map: {
          ...baseMap,
          outdoor: { ...baseMap.outdoor, objects: trees },
        },
        config: testConfig,
      });
    };
    const internals = (simulation: DotBotSimulation) => simulation as unknown as CanopyInternals;
    const objective = (simulation: DotBotSimulation) => {
      const sim = internals(simulation);
      const watcher = sim.bots.get("watcher")!;
      return sim.pickBotTarget.call(sim, watcher);
    };

    it("blocks a new target whose center is under an authored canopy", async () => {
      const strategic = await makeCanopySimulation({ x: 150, y: 180 }, { x: 320, y: 180 });
      const ambient = await makeCanopySimulation(
        { x: 150, y: 180 },
        { x: 320, y: 180 },
        [tree("canopy", 100, 130)],
        true,
      );

      expect(objective(strategic)).not.toMatchObject({ intent: "hunt", targetId: "player" });
      expect(objective(ambient)).not.toMatchObject({ intent: "hunt", targetId: "player" });
      strategic.dispose();
      ambient.dispose();
    });

    it("does not let an enemy mark bypass canopy acquisition", async () => {
      const simulation = await makeCanopySimulation({ x: 150, y: 180 }, { x: 320, y: 180 });
      internals(simulation).squadMarks = [{
        squadId: "rival-1",
        kind: "enemy",
        position: { x: 150, y: 180 },
        floorId: "outdoor",
        atMs: 0,
      }];

      expect(objective(simulation)).not.toMatchObject({ intent: "hunt", targetId: "player" });
      simulation.dispose();
    });

    it("retains a target acquired before it entered the canopy", async () => {
      const simulation = await makeCanopySimulation({ x: 150, y: 280 }, { x: 320, y: 180 });
      simulation.step();
      expect(internals(simulation).bots.get("watcher")?.aiHuntTargetId).toBe("player");

      internals(simulation).bots.get("player")!.position = { x: 150, y: 180 };

      expect(objective(simulation)).toMatchObject({ intent: "hunt", targetId: "player" });
      simulation.dispose();
    });

    it("distinguishes otherwise identical new acquisition from retained pursuit", async () => {
      const retained = await makeCanopySimulation({ x: 150, y: 280 }, { x: 320, y: 180 });
      retained.step();
      internals(retained).bots.get("player")!.position = { x: 150, y: 180 };

      const fresh = await makeCanopySimulation({ x: 150, y: 180 }, { x: 320, y: 180 });

      expect(objective(retained)).toMatchObject({ intent: "hunt", targetId: "player" });
      expect(objective(fresh)).not.toMatchObject({ intent: "hunt", targetId: "player" });
      retained.dispose();
      fresh.dispose();
    });

    it("allows acquisition when the observer shares the target canopy or the target is outside", async () => {
      const shared = await makeCanopySimulation({ x: 150, y: 180 }, { x: 175, y: 180 });
      const outside = await makeCanopySimulation({ x: 150, y: 280 }, { x: 320, y: 180 });

      expect(objective(shared)).toMatchObject({ intent: "hunt", targetId: "player" });
      expect(objective(outside)).toMatchObject({ intent: "hunt", targetId: "player" });
      shared.dispose();
      outside.dispose();
    });

    it("counts the authored boundary as cover and allows a shared overlapping canopy", async () => {
      const boundary = await makeCanopySimulation({ x: 200, y: 180 }, { x: 320, y: 180 });
      const beyond = await makeCanopySimulation({ x: 200.01, y: 180 }, { x: 320, y: 180 });
      const overlapTrees = [tree("west", 100, 130), tree("east", 170, 130)];
      const sharedOverlap = await makeCanopySimulation({ x: 190, y: 180 }, { x: 150, y: 180 }, overlapTrees);
      const outsideOverlap = await makeCanopySimulation({ x: 190, y: 180 }, { x: 320, y: 180 }, overlapTrees);

      expect(objective(boundary)).not.toMatchObject({ intent: "hunt", targetId: "player" });
      expect(objective(beyond)).toMatchObject({ intent: "hunt", targetId: "player" });
      expect(objective(sharedOverlap)).toMatchObject({ intent: "hunt", targetId: "player" });
      expect(objective(outsideOverlap)).not.toMatchObject({ intent: "hunt", targetId: "player" });
      boundary.dispose();
      beyond.dispose();
      sharedOverlap.dispose();
      outsideOverlap.dispose();
    });

    it("clears retention when ordinary target-validity or range rules end pursuit", async () => {
      const invalid = await makeCanopySimulation({ x: 150, y: 280 }, { x: 320, y: 180 });
      invalid.step();
      const invalidPlayer = internals(invalid).bots.get("player")!;
      expect(internals(invalid).bots.get("watcher")?.aiHuntTargetId).toBe("player");

      invalidPlayer.state = "downed";
      invalid.step();
      expect(internals(invalid).bots.get("watcher")?.aiHuntTargetId).toBeNull();

      invalidPlayer.state = "alive";
      invalidPlayer.position = { x: 150, y: 180 };
      expect(objective(invalid)).not.toMatchObject({ intent: "hunt", targetId: "player" });

      const distant = await makeCanopySimulation({ x: 150, y: 280 }, { x: 320, y: 180 });
      distant.step();
      const distantPlayer = internals(distant).bots.get("player")!;
      distantPlayer.position = { x: 1400, y: 180 };
      distant.step();
      expect(internals(distant).bots.get("watcher")?.aiHuntTargetId).toBeNull();

      distantPlayer.position = { x: 150, y: 180 };
      expect(objective(distant)).not.toMatchObject({ intent: "hunt", targetId: "player" });
      invalid.dispose();
      distant.dispose();
    });
  });

  it("classifies noise audibility across rooms and floors", () => {
    const street = { x: 500, y: 620 };
    const clinicLobby = { x: 500, y: 500 };
    const clinicWardF1 = { x: 400, y: 250 };
    const depotB1 = { x: 500, y: 1200 };

    // Same arena: a nearby quiet sound is audible and clear.
    expect(classifyNoise(downtownMap, "outdoor", street, "outdoor", { x: 650, y: 620 }, 0.3)).toEqual({
      muffled: false,
      vertical: 0,
    });

    // Even the loudest sound does not broadcast across the whole outdoor plan.
    expect(classifyNoise(downtownMap, "outdoor", street, "outdoor", { x: 1200, y: 700 }, 1)).toBeNull();

    // Street to inside a ground floor: loud only, muffled, no chevron.
    expect(classifyNoise(downtownMap, "outdoor", street, "outdoor", clinicLobby, 0.8)).toEqual({
      muffled: true,
      vertical: 0,
    });
    expect(classifyNoise(downtownMap, "outdoor", street, "outdoor", clinicLobby, 0.5)).toBeNull();

    // Clinic ground floor listener, noise on F1 above: muffled with up chevron.
    expect(classifyNoise(downtownMap, "outdoor", clinicLobby, "mercy:F1", clinicWardF1, 0.8)).toEqual({
      muffled: true,
      vertical: 1,
    });

    // And the reverse leaks downward.
    expect(classifyNoise(downtownMap, "mercy:F1", clinicWardF1, "outdoor", clinicLobby, 0.8)).toEqual({
      muffled: true,
      vertical: -1,
    });

    // Unrelated building/floor: inaudible no matter how loud.
    expect(classifyNoise(downtownMap, "mercy:F1", clinicWardF1, "lot6:B1", depotB1, 1)).toBeNull();
  });

  it("never takes a downed player out of the run, whatever stands over it", async () => {
    const simulation = await makeSimulation([
      playerSpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
      }),
      enemySpawn({ isAmbient: false, position: { x: 100, y: 180 } }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 24);

    // An AI standing on a body loots it. There is no verb that ends a run, so the
    // player is still downed and still there — free to wait, plea, or leave.
    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.state).toBe("downed");
    expect(player?.shields).toBe(0);
    expect(player?.bays.filter(Boolean).length).toBe(0);
    simulation.dispose();
  });

  it("moves two human-controlled bots independently", async () => {
    const simulation = await makeSimulation([playerSpawn({ position: { x: 100, y: 120 } })]);
    const secondId = simulation.spawnBot(
      allySpawn({ id: "second-human", name: "Second Human", position: { x: 360, y: 240 } }),
      "human",
    );

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    simulation.applyInput(secondId, { move: { x: -1, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player");
    const second = snapshot.bots.find((bot) => bot.id === secondId);
    expect(player?.position.x).toBeGreaterThan(100);
    expect(second?.position.x).toBeLessThan(360);
    expect(player?.position.y).toBeCloseTo(120, 1);
    expect(second?.position.y).toBeCloseTo(240, 1);
    simulation.dispose();
  });

  it("removes a bot mid-run and clears its active references", async () => {
    const simulation = await makeSimulation(
      [playerSpawn({ position: { x: 100, y: 100 } })],
      [{ id: "claimed-dot", item: healthItem, position: { x: 100, y: 100 } }],
    );

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
    simulation.step();
    expect(simulation.getSnapshot().dots.find((dot) => dot.id === "claimed-dot")?.capturedBy).toBe("player");

    simulation.removeBot("player");
    simulation.removeBot("unknown");
    runTicks(simulation, 4);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.some((bot) => bot.id === "player")).toBe(false);
    expect(snapshot.dots.find((dot) => dot.id === "claimed-dot")?.capturedBy).toBeUndefined();
    expect(snapshot.coverages.some((coverage) => coverage.actorId === "player" || coverage.targetId === "player")).toBe(false);
    simulation.dispose();
  });

  it("freezes a bot's movement while keeping its body solid", async () => {
    const simulation = await makeSimulation([playerSpawn({ position: { x: 250, y: 180 } })]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 8);
    simulation.setController("player", "frozen");
    const frozenAt = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;
    runTicks(simulation, 8);
    const stillFrozen = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;
    expect(stillFrozen.x).toBeCloseTo(frozenAt.x, 1);
    expect(stillFrozen.y).toBeCloseTo(frozenAt.y, 1);

    const moverId = simulation.spawnBot(
      allySpawn({ id: "mover", name: "Mover", position: { x: stillFrozen.x - 100, y: stillFrozen.y } }),
      "human",
    );
    simulation.applyInput(moverId, { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 60);

    const snapshot = simulation.getSnapshot();
    const frozen = snapshot.bots.find((bot) => bot.id === "player")!;
    const mover = snapshot.bots.find((bot) => bot.id === moverId)!;
    expect(mover.position.x).toBeLessThan(frozen.position.x);
    expect(Math.hypot(mover.position.x - frozen.position.x, mover.position.y - frozen.position.y)).toBeGreaterThanOrEqual(
      defaultGameConfig.botRadius * 2 - 1,
    );
    simulation.dispose();
  });

  it("drains downed, revived, and looted events from a scripted fight", async () => {
    // The player dashes WESTWARD into the enemy's one plate: the first dash breaks
    // it and the next reaches the core underneath. Losing the plate is not the
    // down — being hit where it used to be is.
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 156, y: 180 }, bays: testBays(1), hold: [] }),
      enemySpawn({ position: { x: 100, y: 180 }, maxShields: 1, shields: 1, bays: testBays(2), hold: [] }),
    ]);
    simulation.setController("enemy", "frozen");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      simulation.applyInput("player", { move: { x: -1, y: 0 }, dash: true });
      for (let tick = 0; tick < 24; tick += 1) {
        simulation.step();
        if (simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.state === "downed") break;
      }
      if (simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.state === "downed") break;
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
      runTicks(simulation, 18);
    }
    simulation.removeBot("enemy");
    const playerPosition = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;
    simulation.spawnBot(
      enemySpawn({ id: "lootable", isAmbient: false, position: playerPosition, state: "downed", shields: 0, bays: testBays(2), hold: [] }),
      "frozen",
    );
    for (let tick = 0; tick < 12; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
      simulation.step();
    }
    simulation.applyInput("player", {
      move: { x: 0, y: 0 },
      dash: false,
      take: { fromBotId: "lootable", index: "all" },
    });
    simulation.step();
    simulation.spawnBot(allySpawn({ id: "downed-ally", position: playerPosition, state: "downed", shields: 0 }), "frozen");
    runTicks(simulation, 12);

    expect(simulation.drainEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "downed", botId: "enemy", byBotId: "player" }),
        { type: "looted", botId: "lootable", byBotId: "player", items: [healthItem, healthItem] },
        { type: "revived", botId: "downed-ally", byBotId: "player" },
      ]),
    );
    expect(simulation.drainEvents()).toEqual([]);
    simulation.dispose();
  });

  it(
    "exercises quiet ambient patrol without friendly combat or looting through a two-minute neighborhood soak",
    async () => {
      const simulation = await DotBotSimulation.create({ map: downtownMap });
      const spawnById = new Map(
        downtownMap.botSpawns.map((spawn) => [
          spawn.id,
          {
            position: spawn.position,
            floorId: physicsFloorId(downtownMap, spawn.floorId ?? "outdoor"),
            controller: spawn.controller,
          },
        ]),
      );
      const milestones = {
        movement: false,
        combat: false,
        floorChange: false,
      };
      const ambientById = new Map(downtownMap.botSpawns.map((spawn) => [spawn.id, spawn.isAmbient ?? false]));
      const ambientCaptors: string[] = [];

      for (let tick = 0; tick < 7_200; tick += 1) {
        simulation.step();
        // Ambient patrol never completes a Dot capture.
        for (const event of simulation.drainEvents()) {
          if (event.type === "dotCaptured" && ambientById.get(event.botId)) {
            ambientCaptors.push(event.botId);
          }
        }

        if (tick % 30 === 0) {
          const snapshot = simulation.getSnapshot();
          milestones.movement ||= snapshot.bots.some((bot) => {
            const spawn = spawnById.get(bot.id);
            return spawn !== undefined && spawn.controller !== "human" && Math.hypot(bot.position.x - spawn.position.x, bot.position.y - spawn.position.y) > 48;
          });
          milestones.combat ||= snapshot.bots.some((bot) => bot.shields < bot.maxShields || bot.state !== "alive");
          milestones.floorChange ||= snapshot.bots.some((bot) => {
            const spawn = spawnById.get(bot.id);
            return spawn !== undefined && spawn.controller !== "human" && bot.floorId !== spawn.floorId;
          });
        }
      }

      const snapshot = simulation.getSnapshot();
      expect(snapshot.timeMs).toBeGreaterThanOrEqual(119_000);
      expect(ambientCaptors).toEqual([]);
      expect(milestones).toEqual({
        movement: true,
        combat: false,
        floorChange: false,
      });
      for (const bot of snapshot.bots) {
        expect(Number.isFinite(bot.position.x), `${bot.id} x position`).toBe(true);
        expect(Number.isFinite(bot.position.y), `${bot.id} y position`).toBe(true);
      }
      simulation.dispose();
    },
    // The soak takes ~17s of pure CPU on an idle machine — a 20s ceiling
    // false-fails under any background load (parallel agents, dev servers).
    // Generous headroom: this test guards correctness, not wall-clock speed.
    90_000,
  );

  it(
    "replays the same autonomous neighborhood state deterministically",
    async () => {
      const first = await DotBotSimulation.create({ map: downtownMap });
      const second = await DotBotSimulation.create({ map: downtownMap });

      for (let tick = 0; tick < 120; tick += 1) {
        first.step();
        second.step();
      }

      expect(snapshotDigest(first.getSnapshot())).toBe(snapshotDigest(second.getSnapshot()));
      first.dispose();
      second.dispose();
    },
    10_000,
  );
});

describe("kinematic bot physics (solver-free)", () => {
  it("keeps a downed body immovable while an enemy presses into it", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ id: "victim", isAmbient: false, controller: "frozen", squadId: "rival-1", position: { x: 160, y: 180 }, state: "downed" }),
    ]);
    const downedAt = { x: 160, y: 180 };

    for (let tick = 0; tick < 180; tick += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
    }

    const victim = simulation.getSnapshot().bots.find((bot) => bot.id === "victim")!;
    expect(victim.state).toBe("downed");
    expect(Math.hypot(victim.position.x - downedAt.x, victim.position.y - downedAt.y)).toBeLessThan(0.01);
    simulation.dispose();
  });

  it("lets the looter stand ON the body: hostile channels run from zero distance", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ id: "victim", isAmbient: false, controller: "frozen", squadId: "rival-1", position: { x: 160, y: 180 }, state: "downed", bays: [{ kind: "powerup", type: "health" }] }),
    ]);

    // Walk THROUGH the corpse onto its center, then channel.
    for (let tick = 0; tick < 120; tick += 1) {
      const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
      const dx = 160 - player.position.x;
      const done = Math.abs(dx) < 2;
      simulation.applyInput("player", { move: { x: done ? 0 : 1, y: 0 }, dash: false, downedVerb: "loot" });
      simulation.step();
    }

    const snapshot = simulation.getSnapshot();
    const victim = snapshot.bots.find((bot) => bot.id === "victim")!;
    const player = snapshot.bots.find((bot) => bot.id === "player")!;
    // Opened from zero distance, and still lying there.
    expect(victim.state).toBe("downed");
    expect(victim.searched).toBe(true);
    // And the take that the open body allows lands from the same zero distance.
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, take: { fromBotId: "victim", index: "all" } });
    simulation.step();
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.bays.filter(Boolean).length).toBeGreaterThan(0);
    simulation.dispose();
  });

  it("caps overlap between alive bots pressing into each other", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 140, y: 180 } }),
      playerSpawn({ id: "buddy", squadId: "alpha", position: { x: 220, y: 180 } }),
    ]);
    simulation.setController("buddy", "human");

    for (let tick = 0; tick < 240; tick += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
      simulation.applyInput("buddy", { move: { x: -1, y: 0 }, dash: false });
      simulation.step();
    }

    const snapshot = simulation.getSnapshot();
    const a = snapshot.bots.find((bot) => bot.id === "player")!;
    const b = snapshot.bots.find((bot) => bot.id === "buddy")!;
    const gap = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) - a.radius - b.radius;
    // Head-on pressure reaches a bounded equilibrium: bodies may kiss but
    // shields can never sit over an enemy core (that needs ~-24px overlap).
    expect(gap).toBeGreaterThan(-14);
    simulation.dispose();
  });

  it("bounds knockback: one qualifying hit displaces a standing target under 70px", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ id: "victim", isAmbient: false, controller: "frozen", squadId: "rival-1", position: { x: 200, y: 180 } }),
    ]);

    let dashed = false;
    for (let tick = 0; tick < 60; tick += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: !dashed });
      simulation.step();
      dashed = true;
      const victim = simulation.getSnapshot().bots.find((bot) => bot.id === "victim")!;
      if (victim.shieldSegments.some((plate) => plate < 1)) break;
    }
    // Let the knockback fully decay, holding the attacker still.
    for (let tick = 0; tick < 30; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
      simulation.step();
    }

    const victim = simulation.getSnapshot().bots.find((bot) => bot.id === "victim")!;
    expect(victim.shieldSegments.some((plate) => plate < 1)).toBe(true);
    expect(victim.position.x - 200).toBeLessThan(70);
    simulation.dispose();
  });
});

describe("combat lag compensation", () => {
  /**
   * The canonical whiff: a runner crosses left-to-right while the attacker
   * dashes perpendicular through where the runner APPEARS on a delayed
   * screen — 15 ticks (~250ms of interpolation + RTT) behind the true body,
   * ~57px back along the trail. The dash crosses the trail there and never
   * comes within contact range (52px) of the runner's true position, so the
   * hit can only land if the server rewinds the victim to the attacker's
   * perceived time.
   */
  async function crossingDashAtPerceivedPosition(viewDelayTicks: number): Promise<boolean> {
    const simulation = await makeSimulation([
      // x = where the runner's 15-tick-old ghost sits when the dash crosses
      // the lane (runner position at tick ~21).
      playerSpawn({ position: { x: 180.5, y: 270 } }),
      enemySpawn({ id: "runner", isAmbient: false, controller: "human", squadId: "rival-1", position: { x: 100, y: 180 } }),
    ]);
    simulation.setController("runner", "human");
    simulation.setViewDelayTicks("player", viewDelayTicks);

    let hit = false;
    for (let tick = 1; tick <= 55 && !hit; tick += 1) {
      simulation.applyInput("player", tick < 30
        ? { move: { x: 0, y: 0 }, dash: false }
        : { move: { x: 0, y: -1 }, dash: tick === 30 });
      simulation.applyInput("runner", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
      hit = simulation.getSnapshot().bots.find((bot) => bot.id === "runner")!
        .shieldSegments.some((plate) => plate < 1);
    }
    simulation.dispose();
    return hit;
  }

  it("a dash through the on-screen (rewound) enemy position lands", async () => {
    expect(await crossingDashAtPerceivedPosition(15)).toBe(true);
  });

  it("without rewind the identical dash whiffs — the regression rewind exists to fix", async () => {
    expect(await crossingDashAtPerceivedPosition(0)).toBe(false);
  });

  it("a connecting dash stops at its target instead of passing through", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ id: "victim", isAmbient: false, controller: "frozen", squadId: "rival-1", position: { x: 260, y: 180 } }),
    ]);

    let dashed = false;
    let crossed = false;
    let gapAtImpact: number | null = null;
    for (let tick = 0; tick < 90; tick += 1) {
      const snapshot = simulation.getSnapshot();
      const player = snapshot.bots.find((bot) => bot.id === "player")!;
      const victim = snapshot.bots.find((bot) => bot.id === "victim")!;
      const dash: boolean = !dashed && victim.position.x - player.position.x < 90;
      dashed ||= dash;
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash });
      simulation.step();
      const after = simulation.getSnapshot();
      const playerAfter = after.bots.find((bot) => bot.id === "player")!;
      const victimAfter = after.bots.find((bot) => bot.id === "victim")!;
      if (playerAfter.position.x > victimAfter.position.x) crossed = true;
      if (gapAtImpact === null && victimAfter.shieldSegments.some((plate) => plate < 1)) {
        gapAtImpact = Math.hypot(playerAfter.position.x - victimAfter.position.x, playerAfter.position.y - victimAfter.position.y)
          - playerAfter.radius - victimAfter.radius;
      }
    }

    const finalSnapshot = simulation.getSnapshot();
    const victim = finalSnapshot.bots.find((bot) => bot.id === "victim")!;
    expect(victim.shieldSegments.some((plate) => plate < 1)).toBe(true);
    // The attacker approached from the west and must never end up east of
    // the body it struck — the dash ends at contact.
    expect(crossed).toBe(false);
    // Hit magnetism: on the impact tick the bodies are TOUCHING — no
    // daylight, no interpenetration (knockback opens the gap afterwards).
    expect(gapAtImpact).not.toBeNull();
    expect(Math.abs(gapAtImpact!)).toBeLessThanOrEqual(0.75);
    expect(simulation.drainEvents()).toContainEqual(expect.objectContaining({
      type: "hit",
      botId: "victim",
      byBotId: "player",
      result: "plateBreak",
      tick: expect.any(Number),
      position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      direction: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    }));
    simulation.dispose();
  });

  it("a standing bot is an anchor: pressure from a walker cannot displace it", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 260, y: 180 } }),
      enemySpawn({ id: "presser", isAmbient: false, controller: "human", squadId: "rival-1", position: { x: 180, y: 180 } }),
    ]);
    simulation.setController("presser", "human");

    for (let tick = 0; tick < 180; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
      simulation.applyInput("presser", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
    }

    const snapshot = simulation.getSnapshot();
    const anchored = snapshot.bots.find((bot) => bot.id === "player")!;
    const presser = snapshot.bots.find((bot) => bot.id === "presser")!;
    expect(Math.hypot(anchored.position.x - 260, anchored.position.y - 180)).toBeLessThan(1);
    // Firm body: the walker reaches at most a shallow kiss, never a grind-through.
    const gap = Math.hypot(anchored.position.x - presser.position.x, anchored.position.y - presser.position.y)
      - anchored.radius - presser.radius;
    expect(gap).toBeGreaterThan(-4);
    simulation.dispose();
  });

  it("a human coverer outranks an AI squadmate hovering the same body", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 135, y: 180 } }),
      // Sorts before "player" alphabetically, so only human priority — not
      // id order — can hand the human the coverage slot.
      enemySpawn({ id: "aide", isAmbient: false, controller: "frozen", squadId: "rival-1", position: { x: 185, y: 180 } }),
      enemySpawn({ id: "victim", isAmbient: false, controller: "frozen", squadId: "rival-1", position: { x: 160, y: 180 }, state: "downed" }),
    ]);

    for (let tick = 0; tick < 5; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
      simulation.step();
    }

    const coverage = simulation.getSnapshot().coverages.find((entry) => entry.targetId === "victim");
    expect(coverage?.actorId).toBe("player");
    expect(coverage?.kind).toBe("loot");
    simulation.dispose();
  });
});

/**
 * The AI's commands and the separation solver have to agree about where a body
 * can be. When they do not, nothing looks broken from the outside — a bot
 * pinned against something it is being commanded into is indistinguishable in a
 * snapshot from one that has arrived — so these checks read the commanded
 * steering as well as the resulting positions.
 */
describe("AI commands and the separation solver agree", () => {
  /** `desiredMove` is the steering the AI produced this tick; no snapshot
   * carries it, and "did the bot stop asking" is the whole question here. */
  type AiInternals = { desiredMove: Vec2; velocity: Vec2; dashCooldownMs: number };
  const aiInternals = (simulation: DotBotSimulation): Map<string, AiInternals> =>
    (simulation as unknown as { bots: Map<string, AiInternals> }).bots;

  /** Dashes off the table: `dashCooldownMs` only ever decrements, so one large
   * write disables `tryAiDash` for a whole run and leaves pure locomotion. */
  const disableDashes = (simulation: DotBotSimulation): void => {
    for (const bot of aiInternals(simulation).values()) bot.dashCooldownMs = 1e9;
  };

  const requiredGap = (a: GameSnapshot["bots"][number], b: GameSnapshot["bots"][number]): number => {
    const toB = Math.atan2(b.position.y - a.position.y, b.position.x - a.position.x);
    return contactReach(a.radius, a.facing, a.shieldSegments, toB)
      + contactReach(b.radius, b.facing, b.shieldSegments, toB + Math.PI);
  };

  it("parks a hunter outside contact instead of grinding against its target forever", async () => {
    /**
     * `huntStopDistance` was `min(radius * 1.85, gap)` = min(44.40, gap), and the
     * clamp bit exactly when two live plates faced each other at 48 — the ordinary
     * case. The hunter was told to stand 3.6 units inside the distance the solver
     * holds, so it crept in 0.1585 px/tick and was shoved back out 0.1585 px/tick,
     * for 815 of 900 measured ticks.
     *
     * The tell is not the position, which oscillates around a fixed point and
     * therefore looks settled. It is the SPEED: 0.1585 px/tick is 9.5 px/s, over
     * the 5 px/s threshold the anchor rule uses, so a hunter parked on a target
     * read as permanently MOVING, yielded 1.0 to every other body and could never
     * anchor. Asserted against that same threshold, not against a magic number.
     */
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 250, y: 180 } }),
      enemySpawn({ id: "hunter", position: { x: 430, y: 180 }, maxShields: 3, shields: 3 }),
    ]);
    disableDashes(simulation);

    let worstCommandedSpeed = 0;
    let worstPenetration = 0;
    for (let tick = 0; tick < 600; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
      simulation.step();
      const bots = simulation.getSnapshot().bots;
      const hunter = bots.find((bot) => bot.id === "hunter")!;
      const target = bots.find((bot) => bot.id === "player")!;
      if (tick > 300) {
        const gap = Math.hypot(hunter.position.x - target.position.x, hunter.position.y - target.position.y);
        worstPenetration = Math.max(worstPenetration, requiredGap(hunter, target) - gap);
        // The COMMANDED velocity, not the position delta. The creep in and the
        // shove back out happen inside a single tick, so end-of-tick positions
        // sit at a rock-steady fixed point and hide the grind completely — the
        // first version of this check passed with the bug fully restored.
        const velocity = aiInternals(simulation).get("hunter")!.velocity;
        worstCommandedSpeed = Math.max(worstCommandedSpeed, Math.hypot(velocity.x, velocity.y));
      }
    }
    simulation.dispose();

    // It arrived: no part of the run has it inside the distance the solver holds.
    expect(worstPenetration).toBeLessThan(0.01);
    // And it is STILL, by the same 5 px/s rule the anchor split uses — a hunter
    // parked on a target has to be able to become an anchor.
    expect(worstCommandedSpeed).toBeLessThan(5);
  });

  it("lets a hunter parked at its stop distance still land a dash", async () => {
    /**
     * The other half of the same agreement. Stop distance and dash gate have to
     * read the same geometry: the gate was a flat `radius * 1.9` = 45.6, so a
     * hunter holding station 35.6 from a stripped 9.6-unit core (contact 33.6)
     * was permanently under the gate and never swung — and it bailed outright
     * when the steering vector went to zero, which is exactly what arriving
     * means.
     *
     * Spawned already at its stop distance, so the dash it throws is the parked
     * one and not an opportunist on the way in.
     */
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 250, y: 180 }, maxShields: 3, shields: 0 }),
      enemySpawn({ id: "hunter", position: { x: 286, y: 180 }, maxShields: 3, shields: 3 }),
    ]);

    let downedBy: string | undefined;
    for (let tick = 0; tick < 90 && !downedBy; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false });
      simulation.step();
      const downed = simulation.drainEvents().find((event) => event.type === "downed" && event.botId === "player");
      downedBy = downed?.type === "downed" ? downed.byBotId : undefined;
    }
    simulation.dispose();

    expect(downedBy).toBe("hunter");
  });

  it("stands looters on a ring two bodies can share, and inside cover range", async () => {
    /**
     * Revive and strip commanded `radius * 0.42` = 10.08. Two looters that close
     * to the same corpse would be 20.16 apart, and the smallest centre distance
     * any two bodies can reach is 19.20 — 48 when both show a live plate. So
     * `steerToward` never returned zero: measured over 1800 ticks, two looters
     * settled 24.00 from the body and were still commanded inward at 37.8 px/s,
     * forever.
     *
     * Pinned from both sides on purpose. Too close and the steering never stops;
     * too far and `withinDownedCoverRange` refuses the channel the standing was
     * for. Measured alone, so the claim rule below cannot be what stops the
     * pressing.
     */
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        allySpawn({ id: "body", controller: "frozen", position: { x: 250, y: 180 }, state: "downed" }),
        allySpawn({ id: "looter", position: { x: 100, y: 180 } }),
      ]),
      config: { ...testConfig, coverDurationMs: 1e9 },
    });
    disableDashes(simulation);
    runTicks(simulation, 1200);

    const bots = simulation.getSnapshot().bots;
    const body = bots.find((bot) => bot.id === "body")!;
    const looter = bots.find((bot) => bot.id === "looter")!;
    const steering = aiInternals(simulation).get("looter")!.desiredMove;
    // Steering is a unit-ish vector; scale it to px/s so the number the old rule
    // produced (37.8 px/s, forever) is what this compares against.
    expect(Math.hypot(steering.x, steering.y) * defaultGameConfig.botSpeed).toBeLessThan(0.01);
    expect(withinDownedCoverRange(looter.position, looter.radius, body.position, body.radius, defaultGameConfig.coverCenterTolerance)).toBe(true);
    simulation.dispose();
  });

  it("does not let the body you knocked back kill the body that hit it", async () => {
    /**
     * Reported twice from play: "this bot was just a core and he hit me, broke my
     * shield, but died himself without me dashing at all." It did, and its own hit
     * killed it one tick later.
     *
     * Found by instrumenting every hit on the shipped map with a human who keeps
     * walking:
     *
     *   t1713  RAM player -> enemy-4  |vel| 550  knockMs 123  closing -550
     *          targetPlates 000  << TARGET DIED
     *
     * The chain: the stripped attacker's dash connects and breaks a plate. The victim
     * is knocked back at `knockbackSpeed` 320, and `bot.velocity` is movement PLUS
     * knockback — so the victim carries 230 + 320 = 550 with neither body dashing,
     * still inside the four-unit contact band, and the ram rule hands the faster body
     * the hit. Against an attacker with nothing left, one hit anywhere is fatal.
     *
     * Two details of the scenario are load-bearing, and getting either wrong is how a
     * first attempt at this test passed with the bug still in.
     *
     * The victim has to be WALKING. A body standing still cannot reach 360 on
     * knockback alone — 320 is under the threshold on purpose. Only a walker can add
     * its own 230 to the shove.
     *
     * And a wall has to take the displacement. At 550 px/s the victim would otherwise
     * clear the contact band in a single tick and the ram would never fire. Pressed
     * into a wall, its velocity stays 550 while its position does not move at all,
     * which is exactly the cornered fight where play met this.
     */
    const simulation = await makeSimulation([
      // Hard against the east wall, holding into it, and never dashing.
      playerSpawn({ id: "victim", position: { x: 452, y: 180 }, maxShields: 3, shields: 3 }),
      enemySpawn({ id: "attacker", squadId: "rival-1", position: { x: 380, y: 180 }, maxShields: 3, shields: 0 }),
    ]);
    let attackerDied = false;
    let victimWasHit = false;
    for (let tick = 0; tick < 600; tick += 1) {
      simulation.applyInput("victim", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
      const bots = simulation.getSnapshot().bots;
      if (bots.find((bot) => bot.id === "attacker")!.state !== "alive") attackerDied = true;
      if (bots.find((bot) => bot.id === "victim")!.shields < 3) victimWasHit = true;
    }
    simulation.dispose();

    // The attack has to have happened, or this passes on two bots that never met.
    expect(victimWasHit).toBe(true);
    expect(attackerDied, "the attacker died to the knockback it caused").toBe(false);
  });

  it("does not make being hit a way to kill whoever is behind you", async () => {
    /**
     * The other half of the same rule, and the reason ram speed is the body's own
     * movement rather than everything acting on it.
     *
     * A shove points away from whoever landed the hit, which means straight into
     * whatever is on your other side — and in a clump there always is something. If
     * knockback counted toward the ram, getting hit from the front would let you kill
     * the bot behind you, at up to 320 px/s you never asked for. Direction alone does
     * not cover this one: you really are closing on the body behind you.
     *
     * Three bodies in a line, the middle one walking west toward a stripped bot while
     * a live one dashes it from the east.
     */
    const simulation = await makeSimulation([
      enemySpawn({ id: "behind", squadId: "rival-1", controller: "frozen", position: { x: 200, y: 180 }, maxShields: 3, shields: 0 }),
      playerSpawn({ id: "victim", position: { x: 248, y: 180 }, maxShields: 3, shields: 3 }),
      enemySpawn({ id: "ahead", squadId: "rival-2", position: { x: 340, y: 180 }, maxShields: 3, shields: 3 }),
    ]);
    let behindDied = false;
    let victimWasHit = false;
    for (let tick = 0; tick < 600; tick += 1) {
      simulation.applyInput("victim", { move: { x: -1, y: 0 }, dash: false });
      simulation.step();
      const bots = simulation.getSnapshot().bots;
      if (bots.find((bot) => bot.id === "behind")!.state !== "alive") behindDied = true;
      if (bots.find((bot) => bot.id === "victim")!.shields < 3) victimWasHit = true;
    }
    simulation.dispose();

    expect(victimWasHit).toBe(true);
    expect(behindDied, "the bot behind died to a shove the victim did not choose").toBe(false);
  });

  it("walks a wedged bot back out instead of leaving it there", async () => {
    /**
     * Reported from play: "this team AI bot still just sits here at the start of the
     * game and does nothing." It had moved 0 units in thirty seconds and blacklisted
     * sixteen objectives, the player among them.
     *
     * `findNavigationPath` tests the START point for clearance, so a bot standing
     * closer to scenery than its own radius gets an empty path to EVERYWHERE — and
     * nothing downstream could tell that apart from "this objective is unreachable".
     * It worked through its whole objective list getting the same empty answer and
     * then stood still. Three authored spawns were inside their own clearance (22.00,
     * 20.00 and 10.00 against a radius of 24); `mapValidation.test.ts` fails on that
     * now.
     *
     * This is the runtime half, and it needs to exist even with the map correct,
     * because authoring is not the only way in: knockback, `placeBot`'s clamp against
     * the sheet edge, revive placement and a separation shove into a corner can all
     * leave a body somewhere it could never have walked to.
     *
     * The bot starts 20 units from a block — four short of the clearance the planner
     * demands — with an objective clear across the map.
     */
    const simulation = await DotBotSimulation.create({
      map: {
        ...makeMap([
          enemySpawn({ id: "wedged", position: { x: 120, y: 180 } }),
          playerSpawn({ id: "far", squadId: "alpha", controller: "frozen", position: { x: 430, y: 180 } }),
        ]),
        outdoor: {
          roads: [], parks: [], objects: [], dotSpawns: [],
          // A block whose east face is at x=100, so a bot centred at 120 has 20.
          walls: [...bounds(500, 360), { id: "block", x: 40, y: 140, w: 60, h: 80 }],
        },
      },
      config: testConfig,
    });
    const start = { x: 120, y: 180 };
    let freed = 0;
    for (let tick = 0; tick < 300; tick += 1) {
      simulation.step();
      const bot = simulation.getSnapshot().bots.find((entry) => entry.id === "wedged")!;
      if (Math.hypot(bot.position.x - start.x, bot.position.y - start.y) > 12) freed = tick;
    }
    const bot = simulation.getSnapshot().bots.find((entry) => entry.id === "wedged")!;
    const travelled = Math.hypot(bot.position.x - start.x, bot.position.y - start.y);
    simulation.dispose();

    // It has to get out, and it has to get out promptly rather than after a stall
    // window: the escape steers every tick the planner comes back empty.
    expect(travelled, "distance from the wedge after five seconds").toBeGreaterThan(24);
    expect(freed).toBeGreaterThan(0);
  });

  it("channels one body at a time, however many you are standing on", async () => {
    /**
     * Reported from play: "when I press F over top of these two downed bots, the
     * search bar appears then disappears."
     *
     * Three things compounding, and the root one is here. Coverage was decided body
     * by body — every downed body looked for anyone standing on it — so a player
     * straddling two bodies opened a channel on BOTH from one press. Measured: two
     * coverages, same actor, both counting.
     *
     * The overlay then showed whichever coverage happened to sit first in the array,
     * which was not the body the player had chosen from. And the overlay clears the
     * verb whenever the body it is prompting for changes — which is correct, because
     * otherwise one press of F latches and every body walked over afterwards searches
     * itself — so the mismatch cancelled the channel one frame after it started.
     *
     * Fixing the overlay would have hidden it. A pair of hands works one body.
     */
    // A search window longer than the run, so finishing one body and correctly
    // moving to the next cannot be mistaken for the cancel this is looking for.
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ id: "looter", position: { x: 250, y: 180 } }),
        enemySpawn({ id: "body-near", squadId: "rival-1", isAmbient: false, controller: "frozen", position: { x: 246, y: 178 }, state: "downed" }),
        enemySpawn({ id: "body-far", squadId: "rival-1", isAmbient: false, controller: "frozen", position: { x: 256, y: 184 }, state: "downed" }),
      ]),
      config: { ...testConfig, lootDurationMs: 3000 },
    });
    let seenAtOnce = 0;
    let progress = 0;
    let reset = false;
    for (let tick = 0; tick < 30; tick += 1) {
      simulation.applyInput("looter", { move: { x: 0, y: 0 }, dash: false, downedVerb: "loot" });
      simulation.step();
      const mine = simulation.getSnapshot().coverages.filter((coverage) => coverage.actorId === "looter");
      seenAtOnce = Math.max(seenAtOnce, mine.length);
      expect(mine[0]?.targetId, "the channel jumped to the other body mid-search").toBe("body-near");
      // The channel has to keep counting: a cancel shows up as progress going
      // backwards, which is exactly what play saw.
      const now = mine[0]?.progressMs ?? 0;
      if (now < progress) reset = true;
      progress = now;
    }
    simulation.dispose();

    expect(seenAtOnce, "channels running at once for one actor").toBe(1);
    expect(reset, "the channel restarted instead of counting through").toBe(false);
    expect(progress).toBeGreaterThan(0);
  });

  it("clears the plate bank when a body goes down, however it went down", async () => {
    /**
     * Reported from play: "when I'm downed, the legend at the top still shows that I
     * have one shield, despite the downed status."
     *
     * There were two ways down and they disagreed. A mine cleared the plate array; a
     * dash left it exactly as it was. Nothing in the simulation reads a downed bot's
     * plates — combat, separation and contact all skip anything not alive, and
     * `reviveBot` writes a fresh array — so the difference stayed invisible right up
     * to the HUD, which renders `shieldSegments` straight.
     *
     * Going down with good plating still on you is the point of the core rule: one
     * hit through the arc where a plate used to be, however many are left elsewhere.
     * The plates just stop mattering the moment you are on the floor, and a bank
     * still showing them promises protection that does not exist.
     *
     * The victim has to go down WITH plates still on it, or the test proves nothing:
     * a bot whose plating is already gone reads [0,0,0] either way, which is how a
     * first version of this passed with the fix reverted. So the victim is frozen
     * facing +x with two plates, and the dash comes in on the bare arc astern — plate
     * 2, at facing + 240 degrees — which reaches the core past intact plating.
     */
    const simulation = await makeSimulation([
      // On the bare arc's bearing, 240 degrees from a victim facing +x.
      playerSpawn({ id: "attacker", position: { x: 190, y: 76 } }),
      enemySpawn({
        id: "victim", squadId: "rival-1", isAmbient: false, controller: "frozen",
        position: { x: 250, y: 180 }, maxShields: 3, shields: 2,
      }),
    ]);
    let downedWith: number[] | null = null;
    let facedWith: number | null = null;
    for (let tick = 0; tick < 200 && downedWith === null; tick += 1) {
      simulation.applyInput("attacker", { move: { x: 0.5, y: 0.866 }, dash: true });
      simulation.step();
      const victim = simulation.getSnapshot().bots.find((bot) => bot.id === "victim")!;
      if (victim.state === "downed") downedWith = [...victim.shieldSegments];
      else facedWith = victim.shieldSegments.reduce((total, plate) => total + plate, 0);
    }
    simulation.dispose();

    expect(downedWith, "the victim never went down, so this proves nothing").not.toBeNull();
    // It was still plated on the tick before it dropped — that is the case that
    // distinguishes the fix, and a stripped victim would read [0,0,0] regardless.
    expect(facedWith, "the victim was already stripped before it went down").toBeGreaterThan(0);
    expect(downedWith).toEqual([0, 0, 0]);
  });

  it("spreads a pack of hunters around a target instead of stacking them on one side", async () => {
    /**
     * The pile-up, from every screenshot play has sent: three or four bots crowded
     * onto one face of a target, grinding.
     *
     * There is no bot-vs-bot avoidance anywhere in this game — the navigator plans on
     * static geometry only and `steerToward` is a raw vector at the goal — so N
     * hunters on one target were all commanded at the SAME world point every tick and
     * the separation pass was the only thing that knew two bodies cannot share space.
     *
     * Measured, five hunters on a stationary target over 900 ticks:
     *
     *                      bearings around the target        outliers   tail contact
     *   no slots           -174 -116 -59 -27 -1 (173 deg)    one at 87   n/a
     *   slots              -113 -46 26 110 176 (full ring)   none        0/300 ticks
     *
     * Two properties are asserted and they are different in kind. The SPREAD is the
     * feature: a pack must occupy the whole ring, not one face of it. The quiet TAIL
     * is the proof it is stable rather than merely spread on the tick it was sampled
     * — assignments are sticky (measured: zero reassignments in 900 ticks), so once
     * the ring forms nobody is touching anybody.
     */
    const HUNTERS = 5;
    const simulation = await DotBotSimulation.create({
      map: {
        ...makeMap([
          playerSpawn({ id: "quarry", position: { x: 250, y: 180 } }),
          ...Array.from({ length: HUNTERS }, (_, index) => enemySpawn({
            id: `hunter-${index}`,
            squadId: "rival-1",
            isAmbient: true,
            position: { x: 120 + index * 30, y: 60 },
          })),
        ]),
        width: 500,
        height: 360,
      },
      // Dashes off: this is about where they stand, and a dash landing would down
      // the quarry and end the measurement.
      config: { ...testConfig, dashCooldownMs: 1e9 },
    });
    let tailContactTicks = 0;
    for (let tick = 0; tick < 900; tick += 1) {
      simulation.applyInput("quarry", { move: { x: 0, y: 0 }, dash: false });
      simulation.step();
      if (tick < 600) continue;
      const alive = simulation.getSnapshot().bots.filter((bot) => bot.state === "alive");
      let touching = false;
      for (let i = 0; i < alive.length; i += 1) {
        for (let j = i + 1; j < alive.length; j += 1) {
          const dx = alive[j].position.x - alive[i].position.x;
          const dy = alive[j].position.y - alive[i].position.y;
          const away = Math.hypot(dx, dy);
          if (away >= alive[i].radius + alive[j].radius) continue;
          const shapeOf = (bot: GameSnapshot["bots"][number]) => {
            const shape = makeContactShape(bot.shieldSegments.length);
            buildContactShape(shape, bot.radius, bot.facing, bot.shieldSegments);
            return shape;
          };
          if (contactDistance(shapeOf(alive[i]), shapeOf(alive[j]), dx / away, dy / away) - away > 0.01) touching = true;
        }
      }
      if (touching) tailContactTicks += 1;
    }
    const bots = simulation.getSnapshot().bots;
    const quarry = bots.find((bot) => bot.id === "quarry")!;
    const bearings = bots
      .filter((bot) => bot.id !== "quarry" && bot.state === "alive")
      .map((bot) => Math.atan2(bot.position.y - quarry.position.y, bot.position.x - quarry.position.x))
      .sort((left, right) => left - right);
    simulation.dispose();

    expect(bearings.length).toBe(HUNTERS);
    /**
     * Widest gap between neighbours around the ring, wrapping. Evenly spread over
     * five slots is 72 degrees each; one-sided stacking leaves a gap of nearly 190.
     * Anything under 180 means no hemisphere is empty.
     */
    let widestGap = bearings[0] + Math.PI * 2 - bearings[bearings.length - 1];
    for (let index = 1; index < bearings.length; index += 1) {
      widestGap = Math.max(widestGap, bearings[index] - bearings[index - 1]);
    }
    expect(widestGap * (180 / Math.PI), "widest empty arc around the target").toBeLessThan(150);
    expect(tailContactTicks, "ticks in the last 300 with any pair in contact").toBeLessThan(15);
  });

  it("makes an acquired ambient hunter that has closed on a player actually fight", async () => {
    /**
     * Reported from play as "AI bots are just stopping together like this a lot
     * without doing anything", with a screenshot of two bodies nose to nose.
     *
     * Both halves of the lock-up were mine. Making the steer's "arrived" agree with
     * the solver's "apart" removed a permanent 3.6-unit push-war — and that
     * push-war had been the only thing keeping `desiredMove` non-zero, which was
     * incidentally the only thing keeping the dash firing. Then the dash gate was
     * moved onto `< contactGap`, which is the SAME NUMBER separation rests the pair
     * at, and separation converges on it from below. Measured on the real map: two
     * hostiles at rest 48.0 apart, contact gap 48.0, `d - gap` = -7.105e-15. The
     * gate fired on a rounding error, on every pair that ever reached contact,
     * forever. Nine of ten AI bots idle after ten seconds.
     *
     * Run on the shipped map, not a two-bot box. A hand-built pair kept landing
     * hits on the way IN and knocking each other apart again, so "did anyone get
     * hit" passed with the bug still in — the standoff only settles once a pair has
     * actually come to rest. The real map produces that within seconds.
     *
     * What is counted is the declined swing: a hunting AI within the hit test's own
     * forgiveness of contact, dash off cooldown, not dashing. That is the bug
     * stated directly, and it cannot be satisfied by anything incidental.
     */
    const simulation = await makeSimulation([
      playerSpawn({ id: "quarry", position: { x: 250, y: 180 } }),
      enemySpawn({ id: "hunter", position: { x: 430, y: 180 } }),
    ]);
    const sim = simulation as unknown as {
      bots: Map<string, { id: string; state: string; floorId: string; position: Vec2; dashCooldownMs: number; dashActiveMs: number }>;
      controllers: Map<string, string>;
      pickBotTarget: (bot: unknown) => { intent: string; targetId?: string };
      contactGap: (a: unknown, b: unknown, at: Vec2) => number;
    };
    let declinedTicks = 0;
    let longestRun = 0;
    let run = 0;
    let everInRange = false;
    for (let tick = 0; tick < 900; tick += 1) {
      simulation.step();
      let declined = 0;
      for (const bot of sim.bots.values()) {
        if (bot.state !== "alive" || sim.controllers.get(bot.id) !== "ai") continue;
        const objective = sim.pickBotTarget.call(sim, bot);
        if (objective.intent !== "hunt" || !objective.targetId) continue;
        const hostile = sim.bots.get(objective.targetId);
        if (!hostile || hostile.floorId !== bot.floorId) continue;
        const away = Math.hypot(hostile.position.x - bot.position.x, hostile.position.y - bot.position.y)
          - sim.contactGap.call(sim, bot, hostile, hostile.position);
        if (away > 4) continue;
        // Measured before the dash state, or the fix hides its own evidence: with
        // the gate working, a bot in range is always already dashing or cooling.
        everInRange = true;
        if (bot.dashCooldownMs <= 0 && bot.dashActiveMs <= 0) declined += 1;
      }
      if (declined > 0) { declinedTicks += 1; run += 1; longestRun = Math.max(longestRun, run); } else run = 0;
    }
    simulation.dispose();

    // Somebody has to have got into range, or this passes on a map where nobody met.
    expect(everInRange).toBe(true);
    /**
     * Measured 0 and 0 with the gate reading the hit test's forgiveness, against
     * 1434 declined ticks and an unbroken run of 1265 out of 1800 with the gate at
     * bare `contactGap`. A handful of ticks is the tick-order slack between deciding
     * and swinging; a run of hundreds is the standoff.
     */
    expect(declinedTicks).toBeLessThan(30);
    expect(longestRun).toBeLessThan(10);
  });

  it("leaves a jam it cannot get through instead of pressing into it forever", async () => {
    /**
     * The freeze, as an assertion, and it is not a physics bug.
     *
     * Nothing in the AI knows another bot exists — the navigator plans on static
     * geometry, steering is a raw vector at the goal with no repulsion term — so N
     * bots after one objective are commanded at one identical point every tick.
     * Measured in a corner: three bots asking for 27, 178 and 400 units of travel
     * and receiving 0.0000 for 299 consecutive ticks, while the solver held every
     * pair correctly at its own rest distance. It reproduces identically with plain
     * circular bodies and a LARGER unmet demand, so it is a queueing problem, not a
     * shape problem, and reverting the body would not touch it.
     *
     * Built as a corridor here rather than a corner, because a corridor is the
     * honest version: the blocker genuinely cannot be walked around, so the only
     * way out is for the blocked bot to want something else. A frozen ally plugs a
     * 56-unit doorway, which admits exactly one 48-wide body, and a second ally is
     * left on the wrong side of it with a hostile beyond.
     */
    const DOOR = 56;
    const simulation = await DotBotSimulation.create({
      map: {
        ...makeMap([
          allySpawn({ id: "plug", controller: "frozen", position: { x: 250, y: 180 } }),
          allySpawn({ id: "blocked", position: { x: 180, y: 180 } }),
          enemySpawn({ id: "bait", isAmbient: false, controller: "frozen", position: { x: 340, y: 180 } }),
        ]),
        outdoor: {
          roads: [], parks: [], objects: [], dotSpawns: [],
          walls: [
            ...bounds(500, 360),
            { id: "wall-north", x: 240, y: 20, w: 20, h: 180 - DOOR / 2 - 20 },
            { id: "wall-south", x: 240, y: 180 + DOOR / 2, w: 20, h: 340 - (180 + DOOR / 2) },
          ],
        },
      },
      config: testConfig,
    });
    disableDashes(simulation);

    // Long enough to cross the 90-tick stall window twice over.
    let stuckTicks = 0;
    let longestLean = 0;
    let run = 0;
    let previous = { x: 180, y: 180 };
    for (let tick = 0; tick < 400; tick += 1) {
      simulation.step();
      const blocked = simulation.getSnapshot().bots.find((bot) => bot.id === "blocked")!;
      const steer = aiInternals(simulation).get("blocked")!.desiredMove;
      const moved = Math.hypot(blocked.position.x - previous.x, blocked.position.y - previous.y);
      // Leaning: asking to travel, and not travelling.
      if (Math.hypot(steer.x, steer.y) > 0.2 && moved < 0.05) {
        run += 1;
        longestLean = Math.max(longestLean, run);
        stuckTicks += 1;
      } else {
        run = 0;
      }
      previous = { ...blocked.position };
    }
    simulation.dispose();

    /**
     * The sharp assertion. Without the stall rule the bot leans for all 400 ticks
     * of the run in one unbroken stretch — it would lean for the rest of the match.
     * With it, the longest single lean measures 88, which is the 90-tick window
     * minus the two ticks it takes to notice, and the assertion is that window plus
     * slack rather than the measurement, so retuning the window does not silently
     * void the test.
     */
    expect(longestLean).toBeLessThan(AI_STALL_TICKS_BOUND);
    /**
     * And the softer one. The bot does come back — the plug is the only route to
     * the only hostile on the map, so after the avoid timer runs out it tries again,
     * which is what a bot with nothing better to do should do. Measured 162 of 400.
     * What matters is that it is now punctuated instead of permanent.
     */
    expect(stuckTicks).toBeLessThan(250);
  });

  it("sends one bot to a body, not the whole squad", async () => {
    /**
     * A downed body is a channel and a channel is for one bot, so the standing
     * distance only ever has to seat one.
     *
     * It could not seat more. Four plated bodies need 33.94 units of spacing around
     * a corpse and `withinDownedCoverRange` tops out at 37.2; six cannot be seated
     * at any distance at all. Sending the squad meant they pressed inward on a ring
     * none of them could share — measured over 1800 ticks, two looters settled 24.0
     * from the body still commanded at 37.8 px/s, three at 27.9 and 48.5, four at
     * 33.9 and 64.8, never settling. That is the pile-and-grind from play, and no
     * amount of retuning the distance fixes it, because the problem is the number
     * of claimants.
     *
     * Nearest wins and the id breaks a tie, so every bot reaches the same answer
     * from the same snapshot with nothing written down. Spawned equidistant here
     * precisely so the tie-break is what decides it.
     */
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        allySpawn({ id: "body", controller: "frozen", position: { x: 250, y: 180 }, state: "downed" }),
        allySpawn({ id: "loot-west", position: { x: 100, y: 180 } }),
        allySpawn({ id: "loot-east", position: { x: 400, y: 180 } }),
      ]),
      config: { ...testConfig, coverDurationMs: 1e9 },
    });
    disableDashes(simulation);
    runTicks(simulation, 1200);

    const bots = simulation.getSnapshot().bots;
    const body = bots.find((bot) => bot.id === "body")!;
    const claimants = ["loot-west", "loot-east"].filter((id) => {
      const looter = bots.find((bot) => bot.id === id)!;
      return withinDownedCoverRange(looter.position, looter.radius, body.position, body.radius, defaultGameConfig.coverCenterTolerance);
    });
    expect(claimants).toHaveLength(1);
    // And the one that got there is standing, not still pressing inward.
    const steering = aiInternals(simulation).get(claimants[0])!.desiredMove;
    expect(Math.hypot(steering.x, steering.y) * defaultGameConfig.botSpeed).toBeLessThan(0.01);
    simulation.dispose();
  });

  it("separates two bodies that share a centre instead of walking them off together", async () => {
    /**
     * `separationPush` runs twice per pair with the arguments swapped, and its
     * fallback direction at distance zero was a fixed `(1, 0)` for BOTH calls: the
     * pair welded and translated at the full 5 px/tick cap — 200 px in 40 ticks,
     * measured — instead of separating. Reachable from spawn, from `placeBot`'s
     * independent x/y clamps, from revive placement and from knockback.
     *
     * Two assertions, because the bug satisfies neither: they have to come apart,
     * and their midpoint has to stay put while they do.
     */
    const simulation = await makeSimulation([
      playerSpawn({ id: "stack-a", controller: "frozen", position: { x: 250, y: 180 } }),
      playerSpawn({ id: "stack-b", controller: "frozen", position: { x: 250, y: 180 } }),
    ]);
    runTicks(simulation, 20);

    const bots = simulation.getSnapshot().bots;
    const a = bots.find((bot) => bot.id === "stack-a")!;
    const b = bots.find((bot) => bot.id === "stack-b")!;
    simulation.dispose();

    expect(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)).toBeGreaterThan(requiredGap(a, b) - 0.01);
    expect(Math.hypot((a.position.x + b.position.x) / 2 - 250, (a.position.y + b.position.y) / 2 - 180)).toBeLessThan(0.01);
  });

  it("hands a wall-blocked yielder's undelivered push to the other body", async () => {
    /**
     * The mover yields and the stander anchors, which is right until the mover has
     * nowhere to go: pinned against a wall with the centre line along the wall
     * normal, `resolveAgainstSolids` cancelled 100% of its push and the anchor's
     * yield of 0 meant nobody else tried. Measured 32.0 px of permanent
     * interpenetration here, and 31.03 px in a dead-end pocket, unchanged after 30
     * ticks.
     */
    const simulation = await makeSimulation([
      playerSpawn({ id: "pinned", position: { x: 44, y: 180 } }),
      playerSpawn({ id: "stander", position: { x: 60, y: 180 } }),
    ]);
    simulation.setController("stander", "human");

    for (let tick = 0; tick < 30; tick += 1) {
      simulation.applyInput("pinned", { move: { x: -1, y: 0 }, dash: false });
      simulation.applyInput("stander", { move: { x: 0, y: 0 }, dash: false });
      simulation.step();
    }

    const bots = simulation.getSnapshot().bots;
    const pinned = bots.find((bot) => bot.id === "pinned")!;
    const stander = bots.find((bot) => bot.id === "stander")!;
    simulation.dispose();

    // The pinned body really is still against the wall — otherwise this proves
    // nothing about an undelivered push.
    expect(pinned.position.x).toBeLessThan(45);
    expect(Math.hypot(pinned.position.x - stander.position.x, pinned.position.y - stander.position.y))
      .toBeGreaterThan(requiredGap(pinned, stander) - 0.01);
  });
});

describe("waypointRetired", () => {
  /**
   * Retiring on proximity alone used `radius * 0.8` = 19.20, which is exactly the
   * smallest centre distance two bodies can reach — and 19.20 is not < 19.20. A
   * bot could therefore NEVER retire a waypoint another body was standing on, and
   * `findNavigationPath` plans on static geometry, so the repath returned the
   * identical blocked waypoint.
   */
  const RETIRE = defaultGameConfig.botRadius * 0.8;

  it("retires a waypoint the bot is past, however far to the side it stopped", () => {
    // Walked east along y = 100; stopped 48 px north of the waypoint but beyond it.
    expect(waypointRetired({ x: 320, y: 52 }, { x: 100, y: 100 }, { x: 300, y: 100 }, RETIRE)).toBe(true);
    // Exactly on the perpendicular counts: the leg is done.
    expect(waypointRetired({ x: 300, y: 40 }, { x: 100, y: 100 }, { x: 300, y: 100 }, RETIRE)).toBe(true);
  });

  it("keeps a waypoint the bot has not reached yet, however close to the line it is", () => {
    // Dead on the leg, still 60 px short.
    expect(waypointRetired({ x: 240, y: 100 }, { x: 100, y: 100 }, { x: 300, y: 100 }, RETIRE)).toBe(false);
    // Stalled 24.000 px short against a parked body — the measured case. Outside
    // the retire radius and no progress made, so the leg stays open: retirement
    // is not a licence to give up on a waypoint the bot is genuinely short of.
    expect(waypointRetired({ x: 276, y: 100 }, { x: 100, y: 100 }, { x: 300, y: 100 }, RETIRE)).toBe(false);
  });

  it("still retires on proximity, for the last leg and for corners cut early", () => {
    expect(waypointRetired({ x: 296, y: 104 }, { x: 100, y: 100 }, { x: 300, y: 100 }, RETIRE)).toBe(true);
    // A zero-length leg has nothing left to progress along.
    expect(waypointRetired({ x: 900, y: 900 }, { x: 300, y: 100 }, { x: 300, y: 100 }, RETIRE)).toBe(true);
  });
});
