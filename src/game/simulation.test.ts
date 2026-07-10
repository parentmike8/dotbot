import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { classifyNoise } from "./mapModel";
import { DotBotSimulation } from "./simulation";
import { hasLineOfSight } from "./visibility";
import type { BotSpawn, DotSpawn, GameConfig, MapDocument, WallSegment } from "./types";

const testConfig: Partial<GameConfig> = {
  dotCaptureDurationMs: 120,
  coverDurationMs: 150,
  respawnDelayMs: 120,
  dashCooldownMs: 300,
  shieldInvulnerabilityMs: 120,
  stairHoldMs: 100,
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
    team: "player",
    color: "#ff3b6b",
    position: { x: 100, y: 180 },
    inventoryDots: 0,
    ...overrides,
  };
}

function enemySpawn(overrides: Partial<BotSpawn> = {}): BotSpawn {
  return {
    id: "enemy",
    name: "Enemy",
    team: "enemy",
    color: "#f2994a",
    position: { x: 220, y: 180 },
    inventoryDots: 0,
    ...overrides,
  };
}

function allySpawn(overrides: Partial<BotSpawn> = {}): BotSpawn {
  return {
    id: "ally",
    name: "Ally",
    team: "ally",
    color: "#2f80ed",
    position: { x: 100, y: 180 },
    inventoryDots: 0,
    ...overrides,
  };
}

function runTicks(simulation: DotBotSimulation, count: number): void {
  for (let i = 0; i < count; i += 1) {
    simulation.step();
  }
}

describe("DotBotSimulation", () => {
  it("keeps the player inside map bounds", async () => {
    const simulation = await makeSimulation([playerSpawn({ position: { x: 70, y: 180 } })]);

    simulation.applyInput({ move: { x: -1, y: 0 }, dash: false });
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

    simulation.applyInput({ move: { x: 1, y: 0 }, dash: true });
    runTicks(simulation, 90);

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.position.x).toBeLessThanOrEqual(wallX - defaultGameConfig.botRadius + 1);
    simulation.dispose();
  });

  it("captures a covered Dot and adds it to inventory", async () => {
    const simulation = await makeSimulation(
      [playerSpawn({ position: { x: 100, y: 100 } })],
      [{ id: "dot", color: "#f2c94c", position: { x: 100, y: 100 } }],
    );

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.dots.find((dot) => dot.id === "dot")?.active).toBe(false);
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(1);
    simulation.dispose();
  });

  it("holds AI bots steady while they cover Dots", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap(
        [enemySpawn({ position: { x: 120, y: 180 } })],
        [{ id: "dot", color: "#f2c94c", position: { x: 100, y: 180 } }],
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

  it("turns a bot downed after a damaging Dash collision", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({ position: { x: 156, y: 180 }, maxShields: 1, shields: 1 }),
    ]);

    simulation.applyInput({ move: { x: 1, y: 0 }, dash: true });
    simulation.step();
    simulation.applyInput({ move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 18);

    const enemy = simulation.getSnapshot().bots.find((bot) => bot.id === "enemy");
    expect(enemy?.state).toBe("downed");
    expect(enemy?.shields).toBe(0);
    simulation.dispose();
  });

  it("consumes a downed hostile bot after coverage", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 } }),
      enemySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        inventoryDots: 2,
      }),
    ]);

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("consumed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(2);
    simulation.dispose();
  });

  it("consumes a downed hostile bot when standing over its footprint", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 122, y: 180 } }),
      enemySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        inventoryDots: 1,
      }),
    ]);

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("consumed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(1);
    simulation.dispose();
  });

  it("consumes a downed hostile bot from a forgiving hover overlap", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 135, y: 180 } }),
      enemySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        inventoryDots: 1,
      }),
    ]);

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("consumed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(1);
    simulation.dispose();
  });

  it("does not consume a downed hostile bot from merely nearby", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 146, y: 180 } }),
      enemySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
        inventoryDots: 1,
      }),
    ]);

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "enemy")?.state).toBe("downed");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(0);
    simulation.dispose();
  });

  it("lets alive bots pass over downed bots without being blocked", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 80, y: 180 } }),
      enemySpawn({
        position: { x: 128, y: 180 },
        state: "downed",
        shields: 0,
        inventoryDots: 0,
      }),
    ]);

    simulation.applyInput({ move: { x: 1, y: 0 }, dash: false });
    runTicks(simulation, 32);

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.position.x).toBeGreaterThan(128);
    simulation.dispose();
  });

  it("revives a downed friendly bot and spends one Dot", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 100, y: 180 }, inventoryDots: 1 }),
      allySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
      }),
    ]);

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.state).toBe("alive");
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.shields).toBe(1);
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(0);
    simulation.dispose();
  });

  it("revives a downed friendly bot when standing over its footprint", async () => {
    const simulation = await makeSimulation([
      playerSpawn({ position: { x: 122, y: 180 }, inventoryDots: 1 }),
      allySpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
      }),
    ]);

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    expect(snapshot.bots.find((bot) => bot.id === "ally")?.state).toBe("alive");
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(0);
    simulation.dispose();
  });

  it("moves the player between floors via stairs and locks until they step off", async () => {
    const baseMap = makeMap([playerSpawn({ position: { x: 270, y: 130 } })]);
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        buildings: [
          {
            id: "tower",
            kind: "office",
            name: "TOWER",
            footprint: { x: 200, y: 60, w: 220, h: 220 },
            floors: [
              {
                id: "tower:GROUND",
                label: "GROUND",
                walls: [],
                doorways: [],
                objects: [],
                stairs: [
                  {
                    id: "tower-up",
                    rect: { x: 240, y: 100, w: 60, h: 60 },
                    direction: "up",
                    toFloorId: "tower:F2",
                    landing: { x: 270, y: 130 },
                  },
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
                  {
                    id: "tower-down",
                    rect: { x: 240, y: 100, w: 60, h: 60 },
                    direction: "down",
                    toFloorId: "outdoor",
                    landing: { x: 270, y: 130 },
                  },
                ],
                dotSpawns: [],
              },
            ],
          },
        ],
      },
      config: testConfig,
    });

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 12);

    const snapshot = simulation.getSnapshot();
    let player = snapshot.bots.find((bot) => bot.id === "player");
    expect(player?.floorId).toBe("tower:F2");

    // Taking the stairs announces itself on both connected floors.
    const stairNoises = snapshot.noises.filter((noise) => noise.kind === "stairs");
    expect(stairNoises.map((noise) => noise.floorId).sort()).toEqual(["outdoor", "tower:F2"]);

    // Standing still on the landing must not bounce back down.
    runTicks(simulation, 30);
    player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.floorId).toBe("tower:F2");
    simulation.dispose();
  });

  it("banks inventory dots at an extraction point", async () => {
    const baseMap = makeMap([playerSpawn({ position: { x: 100, y: 100 }, inventoryDots: 2 })]);
    const simulation = await DotBotSimulation.create({
      map: {
        ...baseMap,
        extractionPoints: [{ id: "pad", name: "PAD", rect: { x: 60, y: 60, w: 80, h: 80 } }],
      },
      config: testConfig,
    });

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 8);

    let snapshot = simulation.getSnapshot();
    expect(snapshot.coverages.some((coverage) => coverage.kind === "extract")).toBe(true);

    runTicks(simulation, 10);
    snapshot = simulation.getSnapshot();
    expect(snapshot.bankedDots).toBe(2);
    expect(snapshot.bots.find((bot) => bot.id === "player")?.inventoryDots).toBe(0);
    simulation.dispose();
  });

  it("emits a dash noise on the player's floor", async () => {
    const simulation = await makeSimulation([playerSpawn()]);

    simulation.applyInput({ move: { x: 1, y: 0 }, dash: true });
    simulation.step();

    const noises = simulation.getSnapshot().noises;
    expect(noises.some((noise) => noise.kind === "dash" && noise.floorId === "outdoor")).toBe(true);
    simulation.dispose();
  });

  it("emits capture channel pings while covering a dot", async () => {
    const simulation = await DotBotSimulation.create({
      map: makeMap(
        [playerSpawn({ position: { x: 100, y: 100 } })],
        [{ id: "dot", color: "#f2c94c", position: { x: 100, y: 100 } }],
      ),
      config: { ...testConfig, dotCaptureDurationMs: 3000 },
    });

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
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
    const clinicWardF2 = { x: 400, y: 250 };
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

    // Clinic ground floor listener, noise on F2 above: muffled with up chevron.
    expect(classifyNoise(downtownMap, "outdoor", clinicLobby, "mercy:F2", clinicWardF2, 0.8)).toEqual({
      muffled: true,
      vertical: 1,
    });

    // And the reverse leaks downward.
    expect(classifyNoise(downtownMap, "mercy:F2", clinicWardF2, "outdoor", clinicLobby, 0.8)).toEqual({
      muffled: true,
      vertical: -1,
    });

    // Unrelated building/floor: inaudible no matter how loud.
    expect(classifyNoise(downtownMap, "mercy:F2", clinicWardF2, "lot6:B1", depotB1, 1)).toBeNull();
  });

  it("quickly respawns the player after being consumed", async () => {
    const simulation = await makeSimulation([
      playerSpawn({
        position: { x: 100, y: 180 },
        state: "downed",
        shields: 0,
      }),
      enemySpawn({ position: { x: 100, y: 180 } }),
    ]);

    simulation.applyInput({ move: { x: 0, y: 0 }, dash: false });
    runTicks(simulation, 24);

    const player = simulation.getSnapshot().bots.find((bot) => bot.id === "player");
    expect(player?.state).toBe("alive");
    expect(player?.shields).toBe(defaultGameConfig.maxShields);
    expect(player?.inventoryDots).toBe(1);
    simulation.dispose();
  });
});
