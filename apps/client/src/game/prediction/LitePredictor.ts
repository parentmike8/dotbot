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
    const move = normalizeInputVector(input.move);
    this.state.dashCooldownMs = Math.max(0, this.state.dashCooldownMs - this.tickMs);
    this.state.dashActiveMs = Math.max(0, this.state.dashActiveMs - this.tickMs);

    if (input.dash && this.state.dashCooldownMs <= 0 && this.state.dashActiveMs <= 0) {
      this.state.dashActiveMs = this.config.dashDurationMs;
      this.state.dashCooldownMs = this.config.dashCooldownMs;
    }

    const direction = move;
    const speed = this.state.dashActiveMs > 0 ? this.config.dashSpeed : this.config.playerSpeed;
    if (Math.hypot(direction.x, direction.y) > 0.05) {
      this.state.facing = Math.atan2(direction.y, direction.x);
    }

    this.state.position = this.resolveStaticCollision({
      x: this.state.position.x + (direction.x * speed) / this.config.tickHz,
      y: this.state.position.y + (direction.y * speed) / this.config.tickHz,
    });

    return this.current;
  }

  private resolveStaticCollision(position: Vec2): Vec2 {
    let next = position;
    const solids = this.solidsByFloor.get(this.state.floorId) ?? collectSolidRects(this.map, this.state.floorId);
    this.solidsByFloor.set(this.state.floorId, solids);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      let moved = false;
      for (const solid of solids) {
        const separated = separateCircleFromRect(next, this.state.radius, solid);
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
      x: clamp(next.x, this.state.radius, this.map.width - this.state.radius),
      y: clamp(next.y, this.state.radius, this.map.height - this.state.radius),
    };
  }
}
