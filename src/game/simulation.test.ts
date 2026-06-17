import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { DotBotSimulation } from "./simulation";
import type { BotSpawn, DotSpawn, GameConfig, MapDefinition, Wall } from "./types";

const testConfig: Partial<GameConfig> = {
  dotCaptureDurationMs: 120,
  coverDurationMs: 150,
  respawnDelayMs: 120,
  dashCooldownMs: 300,
  shieldInvulnerabilityMs: 120,
};

function bounds(width: number, height: number): Wall[] {
  return [
    { id: "north", x: 0, y: 0, w: width, h: 20 },
    { id: "south", x: 0, y: height - 20, w: width, h: 20 },
    { id: "west", x: 0, y: 0, w: 20, h: height },
    { id: "east", x: width - 20, y: 0, w: 20, h: height },
  ];
}

function makeMap(botSpawns: BotSpawn[], dotSpawns: DotSpawn[] = []): MapDefinition {
  return {
    id: "test-map",
    name: "Test Map",
    width: 500,
    height: 360,
    zones: [],
    walls: bounds(500, 360),
    botSpawns,
    dotSpawns,
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
    const simulation = await DotBotSimulation.create({
      map: {
        ...makeMap([playerSpawn({ position: { x: 160, y: 180 } })]),
        walls: [...bounds(500, 360), { id: "thin-wall", x: wallX, y: 80, w: 12, h: 220 }],
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
