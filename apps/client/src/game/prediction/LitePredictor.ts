import { collectSolidRects } from "@dotbot/game/collision";
import { integrateWithWalls, pointSegmentDistance, resolveAgainstSolids, separationPush } from "@dotbot/game/kinematics";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import type { DotBotEntity, GameConfig, InputCommand, MapDocument, Vec2 } from "@dotbot/game";

export type PredictedOwnBot = Pick<
  DotBotEntity,
  "id" | "position" | "radius" | "floorId" | "facing" | "dashCooldownMs" | "dashActiveMs"
>;

/** Another bot the predicted bot must shoulder past, from the latest
 * snapshot. Hostile obstacles also stop a predicted dash at contact,
 * mirroring the server's stop-at-contact rule. */
export type PredictionObstacle = { position: Vec2; radius: number; hostile: boolean };

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
  /** Contact point of the most recent predicted dash stop; a side channel
   * (survives replay resets) so the session can flash impact FX instantly. */
  private dashContact: Vec2 | null = null;
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

  /** One-shot read of the latest predicted dash impact (null when none). */
  consumeDashContact(): Vec2 | null {
    const contact = this.dashContact;
    this.dashContact = null;
    return contact;
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

    const previous = { ...state.position };
    let position = integrateWithWalls(
      state.position,
      { x: direction.x * speed, y: direction.y * speed },
      elapsedMs,
      state.radius,
      solids,
    );

    // Mirror the server's stop-at-contact: a dash that sweeps into a hostile
    // body ends there and snaps to just-touching — out of an overlap or
    // magnetized inward across a small gap — so the impact is FELT the frame
    // it happens instead of a ghost pass-through corrected later.
    if (state.dashActiveMs > 0) {
      for (const obstacle of this.obstacles) {
        if (!obstacle.hostile) continue;
        const sweep = pointSegmentDistance(obstacle.position, previous, position);
        if (sweep - state.radius - obstacle.radius > 4) continue;
        state.dashActiveMs = 0;
        const dx = position.x - obstacle.position.x;
        const dy = position.y - obstacle.position.y;
        const dist = Math.hypot(dx, dy);
        const touching = state.radius + obstacle.radius;
        if (dist - touching <= 16) {
          const nx = dist > 0.001 ? dx / dist : 1;
          const ny = dist > 0.001 ? dy / dist : 0;
          position = resolveAgainstSolids(
            { x: obstacle.position.x + nx * touching, y: obstacle.position.y + ny * touching },
            state.radius,
            solids,
          );
        }
        this.dashContact = {
          x: (position.x + obstacle.position.x) / 2,
          y: (position.y + obstacle.position.y) / 2,
        };
        break;
      }
    }

    // Shoulder past other bots like the server's separation pass. Mirror its
    // anchor rule: when this bot is not moving it cannot be displaced, and
    // when it is the mover it yields the full capped push.
    const moving = this.channelFrozen ? false : state.dashActiveMs > 0 || Math.hypot(move.x, move.y) > 0.05;
    if (moving) {
      const maxPushPx = (this.config.botSeparationSpeed * elapsedMs) / 1000;
      for (const obstacle of this.obstacles) {
        const push = separationPush(position, state.radius, obstacle.position, obstacle.radius, maxPushPx, 1);
        if (push.x !== 0 || push.y !== 0) {
          position = resolveAgainstSolids({ x: position.x + push.x, y: position.y + push.y }, state.radius, solids);
        }
      }
    }

    state.position = {
      x: clamp(position.x, state.radius, this.map.width - state.radius),
      y: clamp(position.y, state.radius, this.map.height - state.radius),
    };
    return state;
  }
}
