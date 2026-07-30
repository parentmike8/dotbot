import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { DotBotSimulation } from "./simulation";
import type { BotSpawn, GameConfig, MapDocument, Vec2, WallSegment } from "./types";

const bounds = (width: number, height: number): WallSegment[] => [
  { id: "north", x: 0, y: 0, w: width, h: 20 },
  { id: "south", x: 0, y: height - 20, w: width, h: 20 },
  { id: "west", x: 0, y: 0, w: 20, h: height },
  { id: "east", x: width - 20, y: 0, w: 20, h: height },
];

const patrol = (points: Vec2[]) => ({
  id: "test-patrol",
  purpose: "Guard the open test yard while keeping its centre clear.",
  waypoints: points.map((position) => ({ position })),
});

type AuthoredBotSpawn = BotSpawn & { patrol?: ReturnType<typeof patrol> };

function ambient(id: string, position: Vec2, overrides: Partial<AuthoredBotSpawn> = {}): AuthoredBotSpawn {
  return {
    id,
    name: id,
    squadId: `legacy-${id}`,
    isAmbient: true,
    color: "#777",
    position,
    ...overrides,
    patrol: overrides.patrol ?? patrol([
      position,
      { x: position.x + 100, y: position.y },
      { x: position.x + 100, y: position.y + 100 },
      { x: position.x, y: position.y + 100 },
    ]),
  };
}

function player(id: string, squadId: string, position: Vec2, controller: BotSpawn["controller"] = "human"): BotSpawn {
  return {
    id,
    name: id,
    squadId,
    controller,
    color: "#f36",
    position,
    bays: [null, null, null, null],
    hold: [],
  };
}

function mapWith(botSpawns: BotSpawn[], extraWalls: WallSegment[] = []): MapDocument {
  return {
    id: "ai-contract",
    name: "AI Contract",
    width: 900,
    height: 700,
    outdoor: {
      roads: [],
      parks: [],
      walls: [...bounds(900, 700), ...extraWalls],
      objects: [],
      dotSpawns: [],
    },
    buildings: [],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns,
  };
}

const config: Partial<GameConfig> = {
  dashCooldownMs: 300,
  shieldInvulnerabilityMs: 120,
  dotCaptureDurationMs: 120,
};

async function simulation(botSpawns: BotSpawn[], extraWalls: WallSegment[] = []) {
  return DotBotSimulation.create({ map: mapWith(botSpawns, extraWalls), config });
}

function run(sim: DotBotSimulation, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) sim.step();
}

type AiObjective = { intent: string; targetId?: string; position: Vec2 };
type AiInternals = {
  bots: Map<string, {
    id: string;
    position: Vec2;
    floorId: string;
    desiredMove: Vec2;
    dashActiveMs: number;
    aiMode?: string;
    aiAlert?: { targetId: string };
  }>;
  pickBotTarget(bot: unknown): AiObjective;
};

function internals(sim: DotBotSimulation): AiInternals {
  return sim as unknown as AiInternals;
}

function objective(sim: DotBotSimulation, botId: string): AiObjective {
  const state = internals(sim);
  return state.pickBotTarget.call(state, state.bots.get(botId));
}

describe("ambient AI faction and sensory contract", () => {
  it("treats every ambient bot as one friendly faction despite legacy squad ids", async () => {
    const sim = await simulation([
      ambient("ambient-a", { x: 300, y: 300 }),
      ambient("ambient-b", { x: 420, y: 300 }),
    ]);

    run(sim, 360);
    const events = sim.drainEvents();
    const bots = sim.getSnapshot().bots;

    expect(events.some((event) => event.type === "hit" || event.type === "dashContact")).toBe(false);
    expect(bots.every((bot) => bot.shields === defaultGameConfig.maxShields && bot.state === "alive")).toBe(true);
    sim.dispose();
  });

  it("rejects ambient friendly fire even when an ambient controller is forced to attack", async () => {
    const sim = await simulation([
      ambient("ambient-a", { x: 300, y: 300 }, { controller: "human" }),
      ambient("ambient-b", { x: 370, y: 300 }, { controller: "frozen" }),
    ]);

    sim.applyInput("ambient-a", { move: { x: 1, y: 0 }, dash: true });
    run(sim, 30);

    expect(sim.getSnapshot().bots.find((bot) => bot.id === "ambient-b")?.shields).toBe(defaultGameConfig.maxShields);
    expect(sim.drainEvents().some((event) => event.type === "hit")).toBe(false);
    sim.dispose();
  });

  it("does not acquire a quiet player through collision or strategic distance", async () => {
    const wall = { id: "screen", x: 440, y: 20, w: 20, h: 660 };
    const sim = await simulation([
      player("player", "alpha", { x: 620, y: 300 }),
      ambient("guard", { x: 300, y: 300 }),
    ], [wall]);

    run(sim, 180);

    expect(objective(sim, "guard").intent).toBe("patrol");
    expect(internals(sim).bots.get("guard")?.aiAlert).toBeUndefined();
    sim.dispose();
  });

  it("acquires a non-ambient target immediately on valid sight", async () => {
    const sim = await simulation([
      player("player", "alpha", { x: 430, y: 300 }),
      ambient("guard", { x: 300, y: 300 }),
    ]);

    sim.step();

    expect(objective(sim, "guard")).toMatchObject({ intent: "hunt", targetId: "player" });
    expect(internals(sim).bots.get("guard")?.aiAlert).toMatchObject({ targetId: "player" });
    sim.dispose();
  });

  it("acquires only source-attributed hostile noise through a wall", async () => {
    const wall = { id: "screen", x: 440, y: 20, w: 20, h: 660 };
    const sim = await simulation([
      player("player", "alpha", { x: 500, y: 300 }),
      ambient("guard", { x: 390, y: 300 }),
    ], [wall]);

    sim.applyInput("player", { move: { x: 0, y: 1 }, dash: true });
    sim.step();

    expect(internals(sim).bots.get("guard")?.aiAlert).toMatchObject({ targetId: "player" });
    expect(objective(sim, "guard").intent).toBe("investigate");
    sim.dispose();
  });

  it("searches the last-known area without omniscient pursuit, then returns to patrol", async () => {
    const sim = await simulation([
      player("player", "alpha", { x: 430, y: 300 }),
      ambient("guard", { x: 300, y: 300 }),
    ]);

    sim.step();
    const state = internals(sim);
    const hidden = state.bots.get("player")!;
    hidden.position = { x: 820, y: 620 };
    hidden.floorId = "hidden";
    run(sim, 30);

    const searchObjective = objective(sim, "guard");
    expect(["investigate", "search"]).toContain(searchObjective.intent);
    expect(searchObjective.position).not.toEqual(hidden.position);

    run(sim, 720);
    expect(objective(sim, "guard").intent).toBe("patrol");
    expect(state.bots.get("guard")?.aiAlert).toBeUndefined();
    sim.dispose();
  });
});

describe("escort hostility, orders, and inventory contract", () => {
  it("does not let an escort aggro a neutral ambient bot", async () => {
    const wall = { id: "screen", x: 440, y: 20, w: 20, h: 660 };
    const sim = await simulation([
      player("player", "alpha", { x: 250, y: 300 }),
      player("escort", "alpha", { x: 330, y: 300 }, "ai"),
      ambient("guard", { x: 520, y: 300 }),
    ], [wall]);

    run(sim, 90);

    expect(objective(sim, "escort")).toMatchObject({ intent: "escort", targetId: "player" });
    sim.dispose();
  });

  it("lets an escort defend once an ambient bot is aggressive toward its squad", async () => {
    const sim = await simulation([
      player("player", "alpha", { x: 430, y: 300 }),
      player("escort", "alpha", { x: 360, y: 360 }, "ai"),
      ambient("guard", { x: 300, y: 300 }),
    ]);

    sim.step();

    expect(objective(sim, "escort")).toMatchObject({ intent: "hunt", targetId: "guard" });
    sim.dispose();
  });

  it("requires a rival human hostile action; visibility alone is insufficient", async () => {
    const sim = await simulation([
      player("player", "alpha", { x: 300, y: 300 }),
      player("escort", "alpha", { x: 260, y: 360 }, "ai"),
      player("rival", "bravo", { x: 390, y: 300 }),
    ]);

    run(sim, 30);
    expect(objective(sim, "escort")).toMatchObject({ intent: "escort", targetId: "player" });

    sim.applyInput("rival", { move: { x: -1, y: 0 }, dash: true });
    run(sim, 20);
    expect(objective(sim, "escort")).toMatchObject({ intent: "hunt", targetId: "rival" });
    sim.dispose();
  });

  it("scopes human hostility to the attacked squad and expires it only after the quiet timeout", async () => {
    const sim = await simulation([
      player("alpha-player", "alpha", { x: 300, y: 300 }),
      player("alpha-escort", "alpha", { x: 250, y: 360 }, "ai"),
      player("beta-player", "beta", { x: 300, y: 500 }),
      player("beta-escort", "beta", { x: 250, y: 540 }, "ai"),
      player("rival", "bravo", { x: 390, y: 300 }),
    ]);

    sim.applyInput("rival", { move: { x: -1, y: 0 }, dash: true });
    run(sim, 20);

    expect(objective(sim, "alpha-escort")).toMatchObject({ intent: "hunt", targetId: "rival" });
    expect(objective(sim, "beta-escort")).toMatchObject({ intent: "escort", targetId: "beta-player" });

    run(sim, 960);
    expect(objective(sim, "alpha-escort")).toMatchObject({ intent: "escort", targetId: "alpha-player" });
    sim.dispose();
  });

  it("keeps ping movement but never lets escorts capture loot", async () => {
    const testMap = mapWith([
      player("player", "alpha", { x: 200, y: 300 }),
      player("escort", "alpha", { x: 260, y: 300 }, "ai"),
    ]);
    testMap.outdoor.dotSpawns = [{
      id: "loot",
      position: { x: 600, y: 300 },
      item: { kind: "powerup", type: "health" },
    }];
    const sim = await DotBotSimulation.create({ map: testMap, config });

    sim.applyInput("player", {
      move: { x: 0, y: 0 },
      dash: false,
      ping: { kind: "loot", position: { x: 600, y: 300 } },
    });
    sim.step();
    expect(objective(sim, "escort").position).toEqual({ x: 600, y: 300 });

    run(sim, 360);
    const snapshot = sim.getSnapshot();
    expect(snapshot.dots.find((dot) => dot.id === "loot")?.active).toBe(true);
    expect(snapshot.bots.find((bot) => bot.id === "escort")?.carriedCount).toBe(0);
    sim.dispose();
  });

  it("is deterministic for patrol, acquisition, search, and hostility expiry", async () => {
    const spawns = [
      player("player", "alpha", { x: 430, y: 300 }),
      player("escort", "alpha", { x: 360, y: 360 }, "ai"),
      ambient("guard", { x: 300, y: 300 }),
    ];
    const first = await simulation(spawns);
    const second = await simulation(spawns);

    run(first, 900);
    run(second, 900);

    const digest = (sim: DotBotSimulation) => sim.getSnapshot().bots.map((bot) => ({
      id: bot.id,
      position: bot.position,
      state: bot.state,
      shields: bot.shields,
    }));
    expect(digest(first)).toEqual(digest(second));
    first.dispose();
    second.dispose();
  });
});
