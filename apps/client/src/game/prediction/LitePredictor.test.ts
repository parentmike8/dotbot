import { defaultGameConfig, downtownMap, type DotBotEntity, type InputCommand } from "@dotbot/game";
import { DotBotSimulation } from "@dotbot/game/simulation";
import type { MapDocument } from "@dotbot/game/types";
import { describe, expect, it } from "vitest";
import { LitePredictor } from "./LitePredictor";
import { classifyCorrection, decayCorrectionOffset, preventBackwardMotion, replayPendingInputs } from "./reconciliation";

const makeBot = (overrides: Partial<DotBotEntity> = {}): DotBotEntity => ({
  id: "viewer",
  name: "Viewer",
  squadId: "squad-a",
  isAmbient: false,
  color: "#fff",
  state: "alive",
  position: { x: 1200, y: 850 },
  radius: defaultGameConfig.botRadius,
  floorId: "outdoor",
  facing: 0,
  maxShields: 3,
  shields: 3,
  shieldSegments: [1, 1, 1],
  bays: [null, null, null, null],
  hold: [],
  carriedCount: 0,
  radarActiveMs: 0,
  radarPings: [],
  dashOverchargeCharges: 0,
  incognitoMs: 0,
  dashCooldownMs: 0,
  dashActiveMs: 0,
  invulnerabilityMs: 0,
  ...overrides,
});

const moveRight: InputCommand = { move: { x: 1, y: 0 }, dash: false };

describe("LitePredictor", () => {
  it("moves a straight-line run by the configured speed and tick rate", () => {
    const bot = makeBot();
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, bot);
    const ticks = 24;

    for (let tick = 0; tick < ticks; tick += 1) {
      predictor.step(moveRight);
    }

    expect(predictor.current.position.x).toBeCloseTo(
      bot.position.x + (defaultGameConfig.playerSpeed * ticks) / defaultGameConfig.tickHz,
      5,
    );
    expect(predictor.current.position.y).toBeCloseTo(bot.position.y, 5);
  });

  it("previews partial ticks smoothly without mutating fixed-step state", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    const quarterTick = predictor.tickMs / 4;
    const positions = [0, 1, 2, 3, 4].map((part) =>
      predictor.preview(moveRight, quarterTick * part).position.x,
    );

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions[0]).toBe(1200);
    expect(positions[4]).toBeCloseTo(
      1200 + defaultGameConfig.playerSpeed / defaultGameConfig.tickHz,
      5,
    );
    expect(predictor.current.position.x).toBe(1200);
  });

  it("keeps partial-tick preview monotonic as a dash expires", () => {
    const predictor = new LitePredictor(
      downtownMap,
      defaultGameConfig,
      makeBot({ dashActiveMs: (1000 / defaultGameConfig.tickHz) / 3 }),
    );
    const positions = [0, 0.25, 0.5, 0.75, 1].map((alpha) =>
      predictor.preview(moveRight, predictor.tickMs * alpha).position.x,
    );

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    predictor.step(moveRight);
    expect(positions.at(-1)).toBeCloseTo(predictor.current.position.x, 5);
  });

  it("stops a predicted dash at a hostile body and recoils to touching", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    predictor.setObstacles([{ position: { x: 1260, y: 850 }, radius: 24, hostile: true }]);

    predictor.step({ ...moveRight, dash: true });
    for (let tick = 0; tick < 12; tick += 1) {
      predictor.step(moveRight);
    }

    const state = predictor.current;
    expect(state.dashActiveMs).toBe(0);
    // Never through the body, and magnetized to touching: no daylight.
    expect(state.position.x).toBeLessThan(1260);
    const gap = Math.hypot(state.position.x - 1260, state.position.y - 850) - 48;
    expect(gap).toBeGreaterThanOrEqual(-0.5);
    expect(gap).toBeLessThanOrEqual(1.5);
    expect(predictor.consumeDashContact()).not.toBeNull();
    expect(predictor.consumeDashContact()).toBeNull();
  });

  it("passes a predicted dash through friendly bodies untouched", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    predictor.setObstacles([{ position: { x: 1260, y: 850 }, radius: 24, hostile: false }]);

    predictor.step({ ...moveRight, dash: true });
    for (let tick = 0; tick < 30; tick += 1) {
      predictor.step(moveRight);
    }

    expect(predictor.current.position.x).toBeGreaterThan(1260);
  });

  it("drops a dash press considered during cooldown instead of banking it", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot({ dashCooldownMs: 40 }));

    predictor.step({ ...moveRight, dash: true });
    predictor.step(moveRight);
    predictor.step(moveRight);

    expect(predictor.current.dashActiveMs).toBe(0);
    expect(predictor.current.position.x).toBeCloseTo(
      1200 + (defaultGameConfig.playerSpeed * 3) / defaultGameConfig.tickHz,
      5,
    );
  });

  it("drops acknowledged inputs and replays one tick per remaining frame", () => {
    const authoritative = makeBot();
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, authoritative);
    const result = replayPendingInputs(
      predictor,
      authoritative,
      [
        { seq: 4, input: moveRight },
        { seq: 5, input: moveRight },
        { seq: 6, input: moveRight },
        { seq: 7, input: moveRight },
      ],
      5,
    );

    expect(result.history.map(({ seq }) => seq)).toEqual([6, 7]);
    expect(result.corrected.position.x).toBeCloseTo(
      authoritative.position.x + (defaultGameConfig.playerSpeed * 2) / defaultGameConfig.tickHz,
      5,
    );
  });

  it("classifies adopt, blend, and snap thresholds and decays blend offset", () => {
    expect(classifyCorrection(0.49)).toBe("adopt");
    expect(classifyCorrection(0.5)).toBe("blend");
    expect(classifyCorrection(150)).toBe("blend");
    expect(classifyCorrection(150.01)).toBe("snap");
    expect(decayCorrectionOffset({ x: 20, y: 0 })).toEqual({ x: 14, y: 0 });
    expect(decayCorrectionOffset({ x: 0.001, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("never applies a backwards correction along the current input path", () => {
    expect(preventBackwardMotion({ x: 100, y: 100 }, { x: 96, y: 103 }, { x: 1, y: 0 }))
      .toEqual({ x: 100, y: 103 });
    expect(preventBackwardMotion({ x: 100, y: 100 }, { x: 104, y: 103 }, { x: 1, y: 0 }))
      .toEqual({ x: 104, y: 103 });
  });

  it("replays a tick-exact input stream to the simulation's exact state", async () => {
    const parityMap: MapDocument = {
      id: "prediction-parity",
      name: "Prediction parity",
      width: 600,
      height: 400,
      outdoor: { roads: [], parks: [], walls: [], objects: [], dotSpawns: [] },
      buildings: [],
      extractionPoints: [],
      insertionPoints: [],
      botSpawns: [{
        id: "viewer",
        name: "Viewer",
        squadId: "alpha",
        color: "#15aabf",
        position: { x: 120, y: 120 },
        controller: "human",
      }],
    };
    const simulation = await DotBotSimulation.create({ map: parityMap });
    const initial = simulation.getSnapshot().bots.find(({ id }) => id === "viewer")!;
    const predictor = new LitePredictor(parityMap, defaultGameConfig, initial);
    // Turns, a dash mid-stream, and a stop: the exact frame set the client
    // would cut. The server consumes one frame per tick, so replaying the
    // same frames one step each must land on the simulation's exact state.
    const frames: Array<{ seq: number; input: InputCommand }> = Array.from({ length: 14 }, (_, index) => ({
      seq: index + 1,
      input: {
        move: index < 4 ? { x: 1, y: 0 } : index < 8 ? { x: 0, y: 1 } : index < 12 ? { x: -1, y: 0 } : { x: 0, y: 0 },
        dash: index === 8,
      },
    }));

    for (const frame of frames) {
      simulation.applyInput("viewer", frame.input);
      simulation.step();
    }

    const replay = replayPendingInputs(predictor, initial, frames, 0);
    const authoritative = simulation.getSnapshot().bots.find(({ id }) => id === "viewer")!;
    expect(replay.corrected.position.x).toBeCloseTo(authoritative.position.x, 4);
    expect(replay.corrected.position.y).toBeCloseTo(authoritative.position.y, 4);
    expect(replay.corrected.facing).toBeCloseTo(authoritative.facing, 5);
    expect(replay.corrected.dashActiveMs).toBeCloseTo(authoritative.dashActiveMs, 4);
    expect(replay.corrected.dashCooldownMs).toBeCloseTo(authoritative.dashCooldownMs, 4);
    simulation.dispose();
  });
});
