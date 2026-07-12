import { defaultGameConfig, downtownMap, type DotBotEntity, type InputCommand } from "@dotbot/game";
import { describe, expect, it } from "vitest";
import { LitePredictor } from "./LitePredictor";
import { blendOffset, classifyCorrection, replayPendingInputs } from "./reconciliation";

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
        { seq: 4, input: moveRight },
        { seq: 5, input: moveRight },
        { seq: 6, input: moveRight },
      ],
      5,
    );

    expect(result.pending.map(({ seq }) => seq)).toEqual([6]);
    expect(result.corrected.position.x).toBeCloseTo(
      authoritative.position.x + (defaultGameConfig.playerSpeed * 2) / defaultGameConfig.tickHz,
      5,
    );
  });

  it("classifies adopt, blend, and snap thresholds and decays blend offset", () => {
    const radius = 24;
    expect(classifyCorrection(radius * 0.49, radius)).toBe("adopt");
    expect(classifyCorrection(radius * 0.5, radius)).toBe("blend");
    expect(classifyCorrection(radius * 3, radius)).toBe("blend");
    expect(classifyCorrection(radius * 3.01, radius)).toBe("snap");
    expect(blendOffset({ x: 20, y: -10 }, 50)).toEqual({ x: 10, y: -5 });
    expect(blendOffset({ x: 20, y: -10 }, 100)).toEqual({ x: 0, y: 0 });
  });
});
