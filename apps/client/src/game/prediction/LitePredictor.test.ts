import { defaultGameConfig, downtownMap, type DotBotEntity, type InputCommand } from "@dotbot/game";
import { DASH_CLINCH_TICKS } from "@dotbot/game/config";
import { findNavigationPath } from "@dotbot/game/navigation";
import { DotBotSimulation } from "@dotbot/game/simulation";
import type { MapDocument, Vec2 } from "@dotbot/game/types";
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
  moving: false,
  maxShields: 3,
  shields: 3,
  shieldSegments: [1, 1, 1],
  bays: [null, null, null, null],
  hold: [],
  carriedCount: 0,
  searched: false,
  pleaded: false,
  radarActiveMs: 0,
  radarPings: [],
  dashOverchargeMs: 0,
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

  it("preserves analog walking magnitude but keeps predicted dash speed full", () => {
    const partial = { move: { x: 0.25, y: 0 }, dash: false };
    const walking = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    walking.step(partial);
    expect(walking.current.position.x).toBeCloseTo(
      1200 + (defaultGameConfig.playerSpeed * 0.25) / defaultGameConfig.tickHz,
      5,
    );

    const dashing = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    dashing.step({ ...partial, dash: true });
    expect(dashing.current.position.x).toBeCloseTo(
      1200 + defaultGameConfig.dashSpeed / defaultGameConfig.tickHz,
      5,
    );
  });

  it("predicts timed dash overcharge with cooldown held at zero through repeated dashes", () => {
    const config = { ...defaultGameConfig, dashOverchargeDurationMs: 400 };
    const predictor = new LitePredictor(
      downtownMap,
      config,
      makeBot({ dashCooldownMs: 900, dashOverchargeMs: 400 }),
    );

    predictor.step({ move: { x: 1, y: 0 }, dash: true });
    expect(predictor.current.dashActiveMs).toBeGreaterThan(0);
    expect(predictor.current.dashCooldownMs).toBe(0);
    expect(predictor.current.dashOverchargeMs).toBeGreaterThan(0);

    for (let tick = 0; tick < 12; tick += 1) predictor.step(moveRight);
    predictor.step({ move: { x: 1, y: 0 }, dash: true });
    expect(predictor.current.dashActiveMs).toBeGreaterThan(0);
    expect(predictor.current.dashCooldownMs).toBe(0);

    for (let tick = 0; tick < 30; tick += 1) predictor.step(moveRight);
    expect(predictor.current.dashOverchargeMs).toBe(0);
    predictor.step({ move: { x: 1, y: 0 }, dash: true });
    expect(predictor.current.dashCooldownMs).toBeGreaterThan(0);
  });

  it("predicts same-frame authoritative dash-overcharge activation before the dash edge", () => {
    const predictor = new LitePredictor(
      downtownMap,
      defaultGameConfig,
      makeBot({
        bays: [{ kind: "powerup", type: "dashOvercharge" }, null, null],
        dashCooldownMs: 900,
      }),
    );
    predictor.step({ move: { x: 1, y: 0 }, dash: true, useBay: 0 });
    expect(predictor.current).toMatchObject({
      dashActiveMs: expect.any(Number),
      dashCooldownMs: 0,
      bays: [null, null, null],
      inventoryRevision: 1,
    });
    expect(predictor.current.dashActiveMs).toBeGreaterThan(0);
    expect(predictor.current.dashOverchargeMs).toBeGreaterThan(59_000);
  });

  it("gives a valid authoritative drop precedence over same-frame overcharge activation", () => {
    const overcharge = { kind: "powerup", type: "dashOvercharge" } as const;
    const health = { kind: "powerup", type: "health" } as const;
    const predictor = new LitePredictor(
      downtownMap,
      defaultGameConfig,
      makeBot({
        bays: [overcharge, health, null],
        inventoryRevision: 0,
        dashCooldownMs: 900,
      }),
    );

    predictor.step({
      move: { x: 1, y: 0 },
      dash: true,
      useBay: 0,
      drop: { from: "bay", index: 1, revision: 0, expected: health },
    });

    expect(predictor.current).toMatchObject({
      bays: [overcharge, null, null],
      inventoryRevision: 1,
      dashActiveMs: 0,
      dashOverchargeMs: 0,
    });
  });

  it("moves a full-size predicted bot through Mercy's standard ward-to-core doorway", () => {
    const start = { x: 570, y: 300 };
    const goal = { x: 700, y: 440 };
    const floorId = "mercy:F1";
    const path = findNavigationPath(
      downtownMap,
      floorId,
      start,
      goal,
      defaultGameConfig.botRadius,
    );
    expect(path.length).toBeGreaterThan(1);

    const predictor = new LitePredictor(
      downtownMap,
      defaultGameConfig,
      makeBot({ position: start, floorId }),
    );
    let waypoint = 1;
    for (let tick = 0; tick < 600 && waypoint < path.length; tick += 1) {
      const position = predictor.current.position;
      const target = path[waypoint];
      const dx = target.x - position.x;
      const dy = target.y - position.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 5) {
        waypoint += 1;
        continue;
      }
      predictor.step({
        move: { x: dx / distance, y: dy / distance },
        dash: false,
      });
    }

    expect(waypoint).toBe(path.length);
    expect(Math.hypot(
      predictor.current.position.x - goal.x,
      predictor.current.position.y - goal.y,
    )).toBeLessThan(8);
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
    predictor.setObstacles([{ id: "target", position: { x: 1260, y: 850 }, radius: 24, facing: Math.PI, shieldSegments: [1, 1, 1], hostile: true }]);

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
    expect(predictor.consumeDashContact()).toMatchObject({ targetId: "target", kind: "hit" });
    expect(predictor.consumeDashContact()).toBeNull();
  });

  it("predicts a dash out of a sustained clinch as a bump without letting it become a hit", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    const clinched = {
      id: "target",
      position: { x: 1248, y: 850 },
      radius: 24,
      facing: Math.PI,
      shieldSegments: [1, 1, 1],
      hostile: true,
    };
    // Contact has to persist to disarm, and the predictor counts it per snapshot —
    // so the clinch is fed in the same way the session feeds it, one frame at a time.
    for (let frame = 0; frame < DASH_CLINCH_TICKS; frame += 1) predictor.setObstacles([clinched]);

    predictor.step({ ...moveRight, dash: true });

    expect(predictor.current.dashActiveMs).toBe(0);
    expect(predictor.consumeDashContact()).toMatchObject({ targetId: "target", kind: "bump" });
  });

  it("predicts a brush of contact as a hit rather than a bump", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    predictor.setObstacles([{
      id: "target",
      position: { x: 1248, y: 850 },
      radius: 24,
      facing: Math.PI,
      shieldSegments: [1, 1, 1],
      hostile: true,
    }]);

    predictor.step({ ...moveRight, dash: true });

    expect(predictor.consumeDashContact()).toMatchObject({ targetId: "target", kind: "hit" });
  });

  it("predicts a dash from visible daylight as a hit rather than a bump", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    predictor.setObstacles([{
      id: "target",
      position: { x: 1251, y: 850 },
      radius: 24,
      facing: Math.PI,
      shieldSegments: [1, 1, 1],
      hostile: true,
    }]);

    predictor.step({ ...moveRight, dash: true });

    expect(predictor.consumeDashContact()).toMatchObject({ targetId: "target", kind: "hit" });
  });

  it("lets a predicted dash escape away from a body it started touching", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    const clinched = {
      id: "target",
      position: { x: 1248, y: 850 },
      radius: 24,
      facing: Math.PI,
      shieldSegments: [1, 1, 1],
      hostile: true,
    };
    for (let frame = 0; frame < DASH_CLINCH_TICKS; frame += 1) predictor.setObstacles([clinched]);

    predictor.step({ move: { x: -1, y: 0 }, dash: true });

    expect(predictor.current.position.x).toBeLessThan(1200);
    expect(predictor.current.dashActiveMs).toBeGreaterThan(0);
    expect(predictor.consumeDashContact()).toBeNull();
  });

  it("predicts two plated active dashes meeting as a clash", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    predictor.setObstacles([{
      id: "target",
      position: { x: 1260, y: 850 },
      radius: 24,
      facing: Math.PI,
      shieldSegments: [1, 1, 1],
      hostile: true,
      dashActiveMs: 100,
    }]);

    predictor.step({ ...moveRight, dash: true });
    for (let tick = 0; tick < 12 && predictor.current.dashActiveMs > 0; tick += 1) {
      predictor.step(moveRight);
    }

    expect(predictor.consumeDashContact()).toMatchObject({ targetId: "target", kind: "clash" });
  });

  it("does not predict a clash when the other active dash is moving away", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    predictor.setObstacles([{
      id: "target",
      position: { x: 1260, y: 850 },
      radius: 24,
      facing: 0,
      shieldSegments: [1, 1, 1],
      hostile: true,
      dashActiveMs: 100,
    }]);

    predictor.step({ ...moveRight, dash: true });
    for (let tick = 0; tick < 12 && predictor.current.dashActiveMs > 0; tick += 1) {
      predictor.step(moveRight);
    }

    expect(predictor.consumeDashContact()).toMatchObject({ targetId: "target", kind: "hit" });
  });

  it("passes a predicted dash through friendly bodies untouched", () => {
    const predictor = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    predictor.setObstacles([{ id: "friendly", position: { x: 1260, y: 850 }, radius: 24, facing: Math.PI, shieldSegments: [1, 1, 1], hostile: false }]);

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

/**
 * Separation is the one place the predictor runs a rule with two sides to it, and
 * it had the rule wrong on both: an `if (moving)` gate plus a hardcoded
 * `yieldFraction = 1`, where the server uses
 * `aMoving === bMoving ? 0.5 : aMoving ? 1 : 0` and therefore pushes two standing
 * bodies apart as well. Two movers in contact were predicted with twice the
 * server's correction and two standers with none of it — up to 2.5 px/tick,
 * 150 px/s of rubber-band on the player's own body, on every shoulder.
 *
 * These step the real simulation and the predictor side by side and demand the
 * same number, not a similar one. The predictor is fed the obstacle exactly as
 * the server's separation pass sees it: `applyMovement` runs immediately before
 * `resolveBotSeparation` with nothing in between, so the obstacle's contact
 * position is its previous end-of-tick position plus one tick of its commanded
 * velocity. In open geometry that is an exact equality, not an approximation.
 */
describe("LitePredictor mirrors the server's separation", () => {
  const openMap = (bots: MapDocument["botSpawns"]): MapDocument => ({
    id: "separation-parity",
    name: "Separation parity",
    width: 600,
    height: 400,
    outdoor: { roads: [], parks: [], walls: [], objects: [], dotSpawns: [] },
    buildings: [],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns: bots,
  });

  const tickMs = 1000 / defaultGameConfig.tickHz;

  /** One tick of commanded travel, the way `applyMovement` integrates it with no
   * solids in range. */
  const advanced = (from: Vec2, move: Vec2): Vec2 => ({
    x: from.x + (move.x * defaultGameConfig.playerSpeed * tickMs) / 1000,
    y: from.y + (move.y * defaultGameConfig.playerSpeed * tickMs) / 1000,
  });

  async function runParity(bumperMove: Vec2, viewerMove: Vec2, ticks: number): Promise<number> {
    const map = openMap([
      { id: "viewer", name: "Viewer", squadId: "alpha", color: "#15aabf", position: { x: 280, y: 200 }, controller: "human" },
      { id: "bumper", name: "Bumper", squadId: "alpha", color: "#f2994a", position: { x: 320, y: 200 }, controller: "human" },
    ]);
    const simulation = await DotBotSimulation.create({ map });
    const initial = simulation.getSnapshot().bots.find(({ id }) => id === "viewer")!;
    const predictor = new LitePredictor(map, defaultGameConfig, initial);
    const bumperMoving = Math.hypot(bumperMove.x, bumperMove.y) * defaultGameConfig.playerSpeed > 5;
    let worstDivergence = 0;

    for (let tick = 0; tick < ticks; tick += 1) {
      const bumper = simulation.getSnapshot().bots.find(({ id }) => id === "bumper")!;
      predictor.setObstacles([{
        id: "bumper",
        position: advanced(bumper.position, bumperMove),
        radius: bumper.radius,
        facing: bumperMoving ? Math.atan2(bumperMove.y, bumperMove.x) : bumper.facing,
        shieldSegments: [...bumper.shieldSegments],
        hostile: false,
        moving: bumperMoving,
      }]);

      simulation.applyInput("viewer", { move: viewerMove, dash: false });
      simulation.applyInput("bumper", { move: bumperMove, dash: false });
      simulation.step();
      const predicted = predictor.step({ move: viewerMove, dash: false });
      const authoritative = simulation.getSnapshot().bots.find(({ id }) => id === "viewer")!;
      worstDivergence = Math.max(
        worstDivergence,
        Math.hypot(predicted.position.x - authoritative.position.x, predicted.position.y - authoritative.position.y),
      );
    }

    simulation.dispose();
    return worstDivergence;
  }

  it("mirrors the server shouldering a body that is walking into a wall", async () => {
    /**
     * Parity for a wall-adjacent shoulder, built the way
     * `NetSession.setPredictionObstacles` builds obstacles — straight off the
     * snapshot's own `moving`, which is now on the wire.
     *
     * WHAT THIS DOES NOT PROVE, stated because the docstring said otherwise for a
     * while. `moving` went on the wire because the server splits responsibility for an
     * overlap by ATTEMPTED velocity, so a body walking into a wall counts as moving
     * while its position never changes — and the predictor used to guess from exactly
     * that changed position, getting the case backwards. This test passes with the
     * flag removed, and the reason is worth keeping: the bumper here is still pushed
     * along a CLEAR axis, so its position does move and the old guess reads it
     * correctly too.
     *
     * A body whose position is genuinely frozen while it reports moving has to be
     * blocked on the same axis it is pushed along — and that is the server's
     * wall-shortfall relay, which the predictor cannot mirror at all (it would need to
     * know whether the OTHER body's push got through) and which dominates the
     * measurement: 3.87 units, against the 2.5 the flag is worth. So the flag removes
     * a guess rather than fixing a divergence this suite can isolate, and what is
     * pinned here is the parity that the relay does not eat.
     *
     * The bumper walks INTO the wall while the shoulder happens ALONGSIDE it, on a
     * different axis, which matters. Pressing the bumper into the wall on the same
     * axis as the push instead lands on the server's wall-shortfall relay — the
     * yielder's correction is eaten by geometry and handed to its counterpart — and
     * the predictor cannot mirror that, because it needs to know whether the OTHER
     * body's push got through. That is documented in LitePredictor and left to
     * reconciliation; measured here it diverges 3.87 units and would have made this
     * test look like a `moving` failure when it is not one.
     */
    const map: MapDocument = {
      ...openMap([
        { id: "viewer", name: "Viewer", squadId: "alpha", color: "#15aabf", position: { x: 284, y: 276 }, controller: "human" },
        { id: "bumper", name: "Bumper", squadId: "alpha", color: "#f2994a", position: { x: 320, y: 276 }, controller: "human" },
      ]),
      // Wide, because the pair drifts east as they shoulder: run them into the sheet's
      // own edge and `placeBot`'s clamp puts the relay back in play.
      width: 2400,
      outdoor: {
        roads: [], parks: [], objects: [], dotSpawns: [],
        // South face at y = 300, so a body centred at 276 is flush against it.
        walls: [{ id: "south", x: 0, y: 300, w: 2400, h: 100 }],
      },
    };
    const simulation = await DotBotSimulation.create({ map });
    const initial = simulation.getSnapshot().bots.find(({ id }) => id === "viewer")!;
    const predictor = new LitePredictor(map, defaultGameConfig, initial);
    const intoTheWall = { x: 0, y: 1 };
    const alongTheWall = { x: 1, y: 0 };
    let worstDivergence = 0;
    let bumperMovedAtAll = 0;

    for (let tick = 0; tick < 240; tick += 1) {
      const bumper = simulation.getSnapshot().bots.find(({ id }) => id === "bumper")!;
      predictor.setObstacles([{
        id: "bumper",
        position: { ...bumper.position },
        radius: bumper.radius,
        facing: bumper.facing,
        shieldSegments: [...bumper.shieldSegments],
        hostile: false,
        moving: bumper.moving,
      }]);
      const before = bumper.position.y;
      simulation.applyInput("viewer", { move: alongTheWall, dash: false });
      simulation.applyInput("bumper", { move: intoTheWall, dash: false });
      simulation.step();
      const predicted = predictor.step({ move: alongTheWall, dash: false });
      const authoritative = simulation.getSnapshot().bots.find(({ id }) => id === "viewer")!;
      const after = simulation.getSnapshot().bots.find(({ id }) => id === "bumper")!;
      bumperMovedAtAll = Math.max(bumperMovedAtAll, Math.abs(after.position.y - before));
      worstDivergence = Math.max(
        worstDivergence,
        Math.hypot(predicted.position.x - authoritative.position.x, predicted.position.y - authoritative.position.y),
      );
    }
    const bumper = simulation.getSnapshot().bots.find(({ id }) => id === "bumper")!;
    simulation.dispose();

    // The scenario has to be the one described: a body that reports moving while its
    // position does not change, which is what defeats the position-delta fallback.
    expect(bumper.moving, "the bumper should report moving under its own power").toBe(true);
    expect(bumperMovedAtAll, "the wall should be absorbing the bumper's travel").toBeLessThan(0.5);
    expect(worstDivergence).toBeLessThan(1e-9);
  });

  it("splits the overlap evenly when both bodies are moving", async () => {
    // Head-on and held there: every one of the 300 ticks is a live contact, which
    // is where the hardcoded yield of 1 doubled the correction.
    expect(await runParity({ x: -1, y: 0 }, { x: 1, y: 0 }, 300)).toBeLessThan(1e-9);
  });

  it("pushes a standing body apart from another standing body", async () => {
    // Neither one moving: the server splits this 0.5/0.5 and the `if (moving)`
    // gate predicted no push at all.
    expect(await runParity({ x: 0, y: 0 }, { x: 0, y: 0 }, 300)).toBeLessThan(1e-9);
  });

  it("anchors the predicted body when it is standing and the other one walks", async () => {
    expect(await runParity({ x: -1, y: 0 }, { x: 0, y: 0 }, 300)).toBeLessThan(1e-9);
  });

  it("yields the whole capped push when it is the only one moving", async () => {
    expect(await runParity({ x: 0, y: 0 }, { x: -1, y: 0 }, 300)).toBeLessThan(1e-9);
  });

  it("infers motion from the snapshot when the caller does not say", () => {
    // Distinct ids so the two histories cannot contaminate each other, and an
    // overlap small enough that neither yield fraction is clipped by the cap.
    const at = (id: string) => ({
      id,
      position: { x: 1250, y: 850 },
      radius: defaultGameConfig.botRadius,
      facing: Math.PI,
      shieldSegments: [1, 1, 1],
      hostile: false,
    });
    const walker = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    // Told outright that it is moving: the pair splits the overlap.
    walker.setObstacles([{ ...at("walker"), moving: true }]);
    const split = walker.step({ move: { x: 1, y: 0 }, dash: false }).position.x;

    const stander = new LitePredictor(downtownMap, defaultGameConfig, makeBot());
    // Not told anything, and seen twice in the same place: inferred standing, so
    // the mover yields all of it.
    stander.setObstacles([at("parked")]);
    stander.setObstacles([at("parked")]);
    const whole = stander.step({ move: { x: 1, y: 0 }, dash: false }).position.x;

    expect(whole).toBeLessThan(split);
  });
});
