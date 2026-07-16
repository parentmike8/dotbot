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

  it("drops acknowledged inputs and replays each remainder for two ticks", () => {
    const authoritative = makeBot();
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, authoritative);
    const result = replayPendingInputs(
      predictor,
      authoritative,
      [
        { seq: 4, input: moveRight, predictionTick: 98 },
        { seq: 5, input: moveRight, predictionTick: 100 },
        { seq: 6, input: moveRight, predictionTick: 101 },
      ],
      5,
      100,
      102,
    );

    expect(result.pending.map(({ seq }) => seq)).toEqual([6]);
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

  it("matches the real simulation's per-tick input-latching semantics", async () => {
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
    const frames = [
      { seq: 1, predictionTick: 1, input: { move: { x: 1, y: 0 }, dash: false } },
      { seq: 2, predictionTick: 4, input: { move: { x: 0, y: 1 }, dash: false } },
      { seq: 3, predictionTick: 8, input: { move: { x: -1, y: 0 }, dash: true } },
    ] satisfies Array<{ seq: number; predictionTick: number; input: InputCommand }>;

    let latched: InputCommand = { move: { x: 0, y: 0 }, dash: false };
    for (let tick = 1; tick <= 12; tick += 1) {
      const newest = frames.filter((frame) => frame.predictionTick === tick).at(-1);
      if (newest) latched = newest.input;
      simulation.applyInput("viewer", latched);
      latched = { move: latched.move, dash: false, downedVerb: latched.downedVerb };
      simulation.step();
    }

    const replay = replayPendingInputs(predictor, initial, frames, 0, 0, 12);
    const authoritative = simulation.getSnapshot().bots.find(({ id }) => id === "viewer")!;
    expect(replay.corrected.position.x).toBeCloseTo(authoritative.position.x, 4);
    expect(replay.corrected.position.y).toBeCloseTo(authoritative.position.y, 4);
    expect(replay.corrected.facing).toBeCloseTo(authoritative.facing, 5);
    expect(replay.corrected.dashActiveMs).toBeCloseTo(authoritative.dashActiveMs, 4);
    expect(replay.corrected.dashCooldownMs).toBeCloseTo(authoritative.dashCooldownMs, 4);
    simulation.dispose();
  });
});
