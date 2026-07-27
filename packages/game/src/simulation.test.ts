import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { interactionDotReach } from "./interactions";
import { classifyNoise, physicsFloorId, planningTableSurfaceRect } from "./mapModel";
import { carriedCount } from "./inventory";
import { DotBotSimulation } from "./simulation";
import { hasLineOfSight } from "./visibility";
import type { BotSpawn, DotSpawn, GameConfig, GameSnapshot, MapDocument, WallSegment } from "./types";

const healthItem = { kind: "powerup", type: "health" } as const;
const radarItem = { kind: "powerup", type: "radar" } as const;
const overchargeItem = { kind: "powerup", type: "dashOvercharge" } as const;
const incognitoItem = { kind: "powerup", type: "incognito" } as const;
const mineItem = { kind: "mine" } as const;
/** `count` health items, then empties out to however many bays the game has. */
const testBays = (count: number) =>
  Array.from({ length: defaultGameConfig.baySlots }, (_, index) => index < count ? healthItem : null);
const emptyBays = () => testBays(0);

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
  it("keeps the player inside map bounds", async () => {
    const simulation = await makeSimulation([playerSpawn({ position: { x: 70, y: 180 } })]);

    simulation.applyInput("player", { move: { x: -1, y: 0 }, dash: false });
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

  it("blacklists multiple unreachable objectives and continues to reachable loot", async () => {
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
    expect(snapshot.dots.find((dot) => dot.id === "reachable")?.active).toBe(false);
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

  it("turns a bot downed after a damaging Dash collision", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 156, y: 180 }, maxShields: 1, shields: 1 }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 18);

    const enemy = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy");
    expect(enemy?.state).toBe("downed");
    expect(enemy?.shields).toBe(0);
    simulation.dispose();
  });

  it("resolves dash damage through directional plates in half-shield steps", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 156, y: 180 } }),
    ]);

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 18);

    const enemy = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy");
    expect(enemy?.shields).toBeLessThan(3);
    // Damage only ever lands as full plates (1) or cracks (0.5).
    expect((enemy!.shields * 2) % 1).toBe(0);
    // The visible plates always account exactly for the shield total.
    expect(enemy!.shieldSegments.reduce((total, plate) => total + plate, 0)).toBe(enemy!.shields);
    expect(enemy!.shieldSegments.every((plate) => [0, 0.5, 1].includes(plate))).toBe(true);
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

  it("lets different-squad ambient AI bots damage each other", async () => {
    const simulation = await makeSimulation([
      enemySpawn({ id: "ambient-a", squadId: "rival-a", position: { x: 100, y: 180 }, maxShields: 1, shields: 1 }),
      enemySpawn({ id: "ambient-b", squadId: "rival-b", position: { x: 220, y: 180 }, maxShields: 1, shields: 1 }),
    ]);

    runTicks(simulation, 90);

    const bots = simulation.getSnapshot().bots;
    expect(bots.some((bot) => bot.state !== "alive" || bot.shields < 1)).toBe(true);
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
        expect(target.shieldSegments).toEqual([0.5, 0, 0]);
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

  it("revives a downed friendly bot for free with one cracked plate", async () => {
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
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.shields).toBe(0.5);
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.shieldSegments).toEqual([0.5, 0, 0]);
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
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.shields).toBe(0.5);
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

  it("lets AI rivals climb stairs to pursue a player on another floor", async () => {
    const stairRect = { x: 250, y: 80, w: 60, h: 160 };
    const baseMap = makeMap([
      playerSpawn({ position: { x: 360, y: 180 }, floorId: "tower:F2" }),
      enemySpawn({ isAmbient: false, position: { x: 280, y: 210 } }),
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

  it("classifies noise audibility across rooms and floors", () => {
    const street = { x: 1000, y: 660 };
    const clinicLobby = { x: 500, y: 500 };
    const clinicWardF1 = { x: 400, y: 250 };
    const depotB1 = { x: 500, y: 1200 };

    // Same arena: always audible, clear ring.
    expect(classifyNoise(downtownMap, "outdoor", street, "outdoor", { x: 1200, y: 700 }, 0.3)).toEqual({
      muffled: false,
      vertical: 0,
    });

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
    // The player dashes WESTWARD into the enemy's forward plate (bots face
    // east by default): one dash, one full shatter, one down — a rear
    // approach would half-crack and need a second dash cycle.
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 156, y: 180 }, bays: testBays(1), hold: [] }),
      enemySpawn({ position: { x: 100, y: 180 }, maxShields: 1, shields: 1, bays: testBays(2), hold: [] }),
    ]);
    simulation.setController("enemy", "frozen");

    simulation.applyInput("player", { move: { x: -1, y: 0 }, dash: true });
    for (let tick = 0; tick < 18; tick += 1) {
      simulation.step();
      if (simulation.getSnapshot().bots.find((bot) => bot.id === "enemy")?.state === "downed") {
        break;
      }
    }
    simulation.removeBot("enemy");
    simulation.setController("player", "frozen");
    const playerPosition = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;
    simulation.spawnBot(
      enemySpawn({ id: "lootable", isAmbient: false, position: playerPosition, state: "downed", shields: 0, bays: testBays(2), hold: [] }),
      "frozen",
    );
    runTicks(simulation, 12);
    simulation.spawnBot(allySpawn({ id: "downed-ally", position: playerPosition, state: "downed", shields: 0 }), "frozen");
    runTicks(simulation, 12);

    expect(simulation.drainEvents()).toEqual(
      expect.arrayContaining([
        { type: "downed", botId: "enemy", byBotId: "player" },
        { type: "looted", botId: "lootable", byBotId: "player", items: [healthItem, healthItem] },
        { type: "revived", botId: "downed-ally", byBotId: "player" },
      ]),
    );
    expect(simulation.drainEvents()).toEqual([]);
    simulation.dispose();
  });

  it(
    "exercises ambient movement, combat, and stairs without looting through a two-minute neighborhood soak",
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
        // Greys are dumb obstacles by design: they must never complete a dot
        // capture. Non-ambient AI rivals looting is legitimate behavior.
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
        combat: true,
        floorChange: true,
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
      result: "bodyHit",
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
