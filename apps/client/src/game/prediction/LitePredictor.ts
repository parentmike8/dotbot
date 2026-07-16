import { collectSolidRects, separateCircleFromRect } from "@dotbot/game/collision";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import type { DotBotEntity, GameConfig, InputCommand, MapDocument, Vec2 } from "@dotbot/game";

export type PredictedOwnBot = Pick<
  DotBotEntity,
  "id" | "position" | "radius" | "floorId" | "facing" | "dashCooldownMs" | "dashActiveMs"
>;

const cloneState = (bot: PredictedOwnBot): PredictedOwnBot => ({
  ...bot,
  position: { ...bot.position },
});

/**
 * Fixed-step prediction for the local bot's movement state only.
 * It deliberately knows nothing about remote bots, combat, dots, or stairs.
 */
export class LitePredictor {
  readonly tickMs: number;
  private state: PredictedOwnBot;
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

    const direction = move;
    const speed = state.dashActiveMs > 0 ? this.config.dashSpeed : this.config.playerSpeed;
    if (Math.hypot(direction.x, direction.y) > 0.05) {
      state.facing = Math.atan2(direction.y, direction.x);
    }

    state.position = this.resolveStaticCollision({
      x: state.position.x + direction.x * speed * elapsedMs / 1000,
      y: state.position.y + direction.y * speed * elapsedMs / 1000,
    }, state);

    return state;
  }

  private resolveStaticCollision(position: Vec2, state = this.state): Vec2 {
    let next = position;
    const solids = this.solidsByFloor.get(state.floorId) ?? collectSolidRects(this.map, state.floorId);
    this.solidsByFloor.set(state.floorId, solids);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      let moved = false;
      for (const solid of solids) {
        const separated = separateCircleFromRect(next, state.radius, solid);
        if (separated.x !== next.x || separated.y !== next.y) {
          next = separated;
          moved = true;
        }
      }
      if (!moved) {
        break;
      }
    }

    return {
      x: clamp(next.x, state.radius, this.map.width - state.radius),
      y: clamp(next.y, state.radius, this.map.height - state.radius),
    };
  }
}
