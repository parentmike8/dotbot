import { collectSolidRects } from "@dotbot/game/collision";
import { integrateWithWalls, resolveAgainstSolids, separationPush } from "@dotbot/game/kinematics";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import type { DotBotEntity, GameConfig, InputCommand, MapDocument, Vec2 } from "@dotbot/game";

export type PredictedOwnBot = Pick<
  DotBotEntity,
  "id" | "position" | "radius" | "floorId" | "facing" | "dashCooldownMs" | "dashActiveMs"
>;

/** Another bot the predicted bot must shoulder past, from the latest snapshot. */
export type PredictionObstacle = { position: Vec2; radius: number };

const cloneState = (bot: PredictedOwnBot): PredictedOwnBot => ({
  ...bot,
  position: { ...bot.position },
});

/**
 * Fixed-step prediction for the local bot's movement state only. Integration
 * runs through the SAME kinematics module as the server simulation — walls,
 * substepping, and bot separation cannot diverge mechanically; only unknown
 * information (hits, other players' inputs) produces corrections.
 */
export class LitePredictor {
  readonly tickMs: number;
  private state: PredictedOwnBot;
  private lastAim: Vec2 = { x: 1, y: 0 };
  private obstacles: PredictionObstacle[] = [];
  private channelFrozen = false;
  private readonly solidsByFloor = new Map<string, ReturnType<typeof collectSolidRects>>();

  constructor(
    private readonly map: MapDocument,
    private readonly config: GameConfig,
    initialBot: PredictedOwnBot,
  ) {
    this.tickMs = 1000 / config.tickHz;
    this.state = cloneState(initialBot);
  }

  get current(): PredictedOwnBot {
    return cloneState(this.state);
  }

  reset(bot: PredictedOwnBot): void {
    this.state = cloneState(bot);
  }

  /** Latest known other bots (alive, same floor); refreshed per snapshot. */
  setObstacles(obstacles: PredictionObstacle[]): void {
    this.obstacles = obstacles;
  }

  /** Mirrors the server's stationary-channel rule: while this bot channels a
   * loot/revive/consume, movement input is ignored (timers still run). */
  setChannelFrozen(frozen: boolean): void {
    this.channelFrozen = frozen;
  }

  step(input: InputCommand): PredictedOwnBot {
    this.state = this.advance(cloneState(this.state), input, this.tickMs, true);
    return this.current;
  }

  /**
   * Samples the partial tick after `current` without changing fixed-step
   * prediction state. Rendering this preview avoids presenting a held frame
   * followed by a double-sized step when display frames and sim ticks drift.
   */
  preview(input: InputCommand, elapsedMs: number): PredictedOwnBot {
    const alpha = clamp(elapsedMs / this.tickMs, 0, 1);
    const next = this.advance(cloneState(this.state), input, this.tickMs, false);
    return {
      ...next,
      position: {
        x: this.state.position.x + (next.position.x - this.state.position.x) * alpha,
        y: this.state.position.y + (next.position.y - this.state.position.y) * alpha,
      },
      dashCooldownMs: this.state.dashCooldownMs + (next.dashCooldownMs - this.state.dashCooldownMs) * alpha,
      dashActiveMs: this.state.dashActiveMs + (next.dashActiveMs - this.state.dashActiveMs) * alpha,
    };
  }

  private advance(state: PredictedOwnBot, input: InputCommand, elapsedMs: number, consumeDash: boolean): PredictedOwnBot {
    const move = normalizeInputVector(input.move);
    state.dashCooldownMs = Math.max(0, state.dashCooldownMs - elapsedMs);
    state.dashActiveMs = Math.max(0, state.dashActiveMs - elapsedMs);

    if (consumeDash && input.dash && state.dashCooldownMs <= 0 && state.dashActiveMs <= 0) {
      state.dashActiveMs = this.config.dashDurationMs;
      state.dashCooldownMs = this.config.dashCooldownMs;
    }

    // Mirror the server: a dash rides the LAST aim, so releasing the keys
    // mid-dash no longer desyncs the predicted dash from the real one.
    if (Math.hypot(move.x, move.y) > 0.05 && consumeDash) {
      this.lastAim = move;
    }
    const direction = this.channelFrozen ? { x: 0, y: 0 } : state.dashActiveMs > 0 ? this.lastAim : move;
    const speed = state.dashActiveMs > 0 ? this.config.dashSpeed : this.config.playerSpeed;
    if (Math.hypot(direction.x, direction.y) > 0.05) {
      state.facing = Math.atan2(direction.y, direction.x);
    }

    const solids = this.solidsByFloor.get(state.floorId) ?? collectSolidRects(this.map, state.floorId);
    this.solidsByFloor.set(state.floorId, solids);

    let position = integrateWithWalls(
      state.position,
      { x: direction.x * speed, y: direction.y * speed },
      elapsedMs,
      state.radius,
      solids,
    );

    // Shoulder past other bots exactly like the server's separation pass;
    // only this bot yields here (the server moves both halves).
    const maxPushPx = (this.config.botSeparationSpeed * elapsedMs) / 1000;
    for (const obstacle of this.obstacles) {
      const push = separationPush(position, state.radius, obstacle.position, obstacle.radius, maxPushPx);
      if (push.x !== 0 || push.y !== 0) {
        position = resolveAgainstSolids({ x: position.x + push.x, y: position.y + push.y }, state.radius, solids);
      }
    }

    state.position = {
      x: clamp(position.x, state.radius, this.map.width - state.radius),
      y: clamp(position.y, state.radius, this.map.height - state.radius),
    };
    return state;
  }
}
