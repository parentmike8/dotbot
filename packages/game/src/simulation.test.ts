import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { classifyNoise, physicsFloorId } from "./mapModel";
import { carriedCount } from "./inventory";
import { DotBotSimulation } from "./simulation";
import { hasLineOfSight } from "./visibility";
import type { BotSpawn, DotSpawn, GameConfig, GameSnapshot, MapDocument, WallSegment } from "./types";

const healthItem = { kind: "powerup", type: "health" } as const;
const radarItem = { kind: "powerup", type: "radar" } as const;
const overchargeItem = { kind: "powerup", type: "dashOvercharge" } as const;
const incognitoItem = { kind: "powerup", type: "incognito" } as const;
const testBays = (count: number) => Array.from({ length: 4 }, (_, index) => index < count ? healthItem : null);

const testConfig: Partial<GameConfig> = {
  dotCaptureDurationMs: 120,
  coverDurationMs: 150,
  consumeDurationMs: 150,
  reviveCleanDurationMs: 120,
  lootThenReviveDurationMs: 210,
  pleaCooldownMs: 150,
  respawnDelayMs: 120,
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
    const simulation = await makeSimulation([playerSpawn({ bays: [incognitoItem, null, null, null] })]);
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
      map: makeMap([playerSpawn({ bays: [healthItem, null, null, null], hold: [radarItem] })]),
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
    for (let tick = 0; tick < 90; tick += 1) {
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

  it("never lets an ambient grey consume a downed bot", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 100 }, state: "downed", shields: 0 }),
      enemySpawn({ controller: "frozen", position: { x: 100, y: 100 } }),
    ]);
    runTicks(simulation, 30);
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")?.state).toBe("downed");
    expect(simulation.getSnapshot().coverages.some((coverage) => coverage.kind === "consume")).toBe(false);
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

  it("consumes a downed hostile bot after coverage", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({
        isAmbient: false,
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        bays: testBays(2), hold: [],
      }),
    ]);

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "consume" });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("consumed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean).length).toBe(2);
    simulation.dispose();
  });

  it("spills consume overflow back onto the ground as typed dots", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap([
        playerSpawn({ position: { x: 100, y: 180 }, bays: [healthItem], hold: [radarItem] }),
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
    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "consume" });
    runTicks(simulation, 12);
    const spills = simulation.getSnapshot().dots.filter((dot) => dot.id.startsWith("spill-") && dot.active);
    expect(spills.map((dot) => dot.item)).toEqual(expect.arrayContaining([overchargeItem, incognitoItem]));
    expect(simulation.drainEvents()).toContainEqual({
      type: "consumed",
      botId: "enemy",
      byBotId: "player",
      lostItems: [overchargeItem, incognitoItem],
    });
    simulation.dispose();
  });

  it("uses the configured hostile channel durations and applies each verb outcome", async () => {
    const cases = [
      { verb: "consume" as const, durationMs: testConfig.consumeDurationMs, finalState: "consumed" as const },
      { verb: "reviveClean" as const, durationMs: testConfig.reviveCleanDurationMs, finalState: "alive" as const },
      { verb: "lootThenRevive" as const, durationMs: testConfig.lootThenReviveDurationMs, finalState: "alive" as const },
    ];

    for (const { verb, durationMs, finalState } of cases) {
      const simulation = await makeSimulation([
        playerSpawn({ position: { x: 100, y: 180 } }),
        enemySpawn({
          isAmbient: false,
          controller: "frozen",
          position: { x: 100, y: 180 },
          state: "downed",
          shields: 0,
          bays: [healthItem, radarItem, null, null],
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
      if (verb === "reviveClean") {
        expect(target.shieldSegments).toEqual([0.5, 0, 0]);
        expect(target.bays.filter(Boolean)).toEqual([healthItem, radarItem]);
        expect(actor.bays.filter(Boolean)).toEqual([]);
      } else if (verb === "lootThenRevive") {
        expect(target.shieldSegments).toEqual([0.5, 0, 0]);
        expect(target.bays.filter(Boolean)).toEqual([]);
        expect(target.hold).toEqual([]);
        expect(actor.bays.filter(Boolean)).toEqual([healthItem, radarItem]);
      } else {
        expect(actor.bays.filter(Boolean)).toEqual([healthItem, radarItem]);
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

  it("consumes a downed hostile bot when standing over its footprint", async () => {
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

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "consume" });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("consumed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean).length).toBe(1);
    simulation.dispose();
  });

  it("consumes a downed hostile bot from a forgiving hover overlap", async () => {
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

    simulation.applyInput("player", { move: { x: 0, y: 0 }, dash: false, downedVerb: "consume" });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("consumed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.bays.filter(Boolean).length).toBe(1);
    simulation.dispose();
  });

  it("does not consume a downed hostile bot from merely nearby", async () => {
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

  it("does not respawn a non-ambient player after being consumed", async () => {
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

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.state).toBe("consumed");
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

  it("drains downed, revived, and consumed events from a scripted fight", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 }, bays: testBays(1), hold: [] }),
      enemySpawn({ position: { x: 156, y: 180 }, maxShields: 1, shields: 1, bays: testBays(2), hold: [] }),
    ]);
    simulation.setController("enemy", "frozen");

    simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: true });
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
      enemySpawn({ id: "consumable", isAmbient: false, position: playerPosition, state: "downed", shields: 0, bays: testBays(2), hold: [] }),
      "frozen",
    );
    runTicks(simulation, 12);
    simulation.spawnBot(allySpawn({ id: "downed-ally", position: playerPosition, state: "downed", shields: 0 }), "frozen");
    runTicks(simulation, 12);

    expect(simulation.drainEvents()).toEqual(
      expect.arrayContaining([
        { type: "downed", botId: "enemy", byBotId: "player" },
        { type: "consumed", botId: "consumable", byBotId: "player", lostItems: [healthItem, healthItem] },
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
      const initialActiveDots = simulation.getSnapshot().debug.activeDots;
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
        capture: false,
        combat: false,
        floorChange: false,
      };

      for (let tick = 0; tick < 7_200; tick += 1) {
        simulation.step();

        if (tick % 30 === 0) {
          const snapshot = simulation.getSnapshot();
          milestones.movement ||= snapshot.bots.some((bot) => {
            const spawn = spawnById.get(bot.id);
            return spawn !== undefined && spawn.controller !== "human" && Math.hypot(bot.position.x - spawn.position.x, bot.position.y - spawn.position.y) > 48;
          });
          milestones.capture ||= snapshot.debug.activeDots < initialActiveDots;
          milestones.combat ||= snapshot.bots.some((bot) => bot.shields < bot.maxShields || bot.state !== "alive");
          milestones.floorChange ||= snapshot.bots.some((bot) => {
            const spawn = spawnById.get(bot.id);
            return spawn !== undefined && spawn.controller !== "human" && bot.floorId !== spawn.floorId;
          });
        }
      }

      const snapshot = simulation.getSnapshot();
      expect(snapshot.timeMs).toBeGreaterThanOrEqual(119_000);
      expect(milestones).toEqual({
        movement: true,
        capture: false,
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
