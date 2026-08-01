import { collectSolids } from "@dotbot/game/collision";
import { buildSolidIndex, withExtraSolids, type SolidIndex } from "@dotbot/game/solidIndex";
import { rectSolid } from "@dotbot/game/geometry";
import { doorEntityCollisionRect } from "@dotbot/game/mapModel";
import {
  coincidentSeparationAxis,
  integrateWithWalls,
  pointSegmentDistance,
  resolveAgainstSolids,
  separationAxis,
  separationPush,
} from "@dotbot/game/kinematics";
import { clamp, clampInputVector, normalize } from "@dotbot/game/math";
import {
  DASH_HIT_FORGIVENESS_PX,
  DASH_CLINCH_TICKS,
  DASH_CONTACT_EPSILON_PX,
  MOVING_SPEED,
} from "@dotbot/game/config";
import { contactReach } from "@dotbot/game/shields";
import { buildContactShape, contactDistance, contactingPlate, makeContactShape } from "@dotbot/game/bodyContact";
import type { DoorEntity, DotBotEntity, GameConfig, InputCommand, MapDocument, Solid, Vec2 } from "@dotbot/game";

export type PredictedOwnBot = Pick<
  DotBotEntity,
  "id" | "position" | "radius" | "floorId" | "facing" | "bays" | "dashCooldownMs" | "dashActiveMs" | "dashOverchargeMs" | "shieldSegments" | "moving"
>;

export type PredictedDashContact = {
  position: Vec2;
  targetId: string;
  kind: "hit" | "bump" | "clash";
};

/** Another bot the predicted bot must shoulder past, from the latest
 * snapshot. Hostile obstacles also stop a predicted dash at contact,
 * mirroring the server's stop-at-contact rule.
 *
 * Facing and plates travel with it because contact is no longer a circle: a bot
 * reaches as far as its plate on the side you approach, and only as far as its
 * core where that plate is gone. Predicting with a plain radius while the server
 * uses the plate profile is a desync on every single contact. */
export type PredictionObstacle = {
  id: string;
  position: Vec2;
  radius: number;
  facing: number;
  shieldSegments: number[];
  hostile: boolean;
  /** Present-time combat state used only to classify a possible clash. */
  dashActiveMs?: number;
  /** Invulnerable hostiles still bump at point blank, but an armed dash passes. */
  damageable?: boolean;
  /**
   * Was this body moving on the tick it was snapshotted?
   *
   * The server splits separation responsibility by velocity — mover yields,
   * stander anchors, both-or-neither splits it evenly — and the wire does not
   * carry velocity. Supplying it here is the only way the predictor can be an
   * exact mirror; when it is absent the predictor falls back to whether the
   * body's snapshotted position changed, which is right for everything except a
   * body walking into a wall (the server calls that moving, the fallback calls it
   * still). A body seen for the first time has no history to compare against and
   * is read as standing: the evidence so far is that it has not moved.
   */
  moving?: boolean;
};

/**
 * The gap at which the predicted bot and an obstacle touch, along the line
 * between them. The server's `contactGap`, and it has to stay that way — which is
 * why it is the server's `contactDistance` and not a re-derivation of it. Two
 * shapes, reused: a frame builds at most one own-bot pose and one obstacle pose at
 * a time, and prediction re-runs the whole input buffer every frame.
 */
const ownShape = makeContactShape(8);
const otherShape = makeContactShape(8);

function contactGap(state: PredictedOwnBot, obstacle: PredictionObstacle, from: Vec2): number {
  const dx = obstacle.position.x - from.x;
  const dy = obstacle.position.y - from.y;
  const dist = Math.hypot(dx, dy);
  const ux = dist > 0.001 ? dx / dist : 1;
  const uy = dist > 0.001 ? dy / dist : 0;
  return contactGapAlong(state, obstacle, ux, uy);
}

function activeDashesOppose(
  state: PredictedOwnBot,
  obstacle: PredictionObstacle,
  from: Vec2,
): boolean {
  const dx = obstacle.position.x - from.x;
  const dy = obstacle.position.y - from.y;
  const away = Math.hypot(dx, dy);
  if (away < 0.001) return true;
  const ux = dx / away;
  const uy = dy / away;
  const ownToward = Math.cos(state.facing) * ux + Math.sin(state.facing) * uy;
  const otherToward = Math.cos(obstacle.facing) * -ux + Math.sin(obstacle.facing) * -uy;
  return ownToward > 0 && otherToward > 0;
}

function contactGapAlong(
  state: PredictedOwnBot,
  obstacle: PredictionObstacle,
  ux: number,
  uy: number,
): number {
  const toward = Math.atan2(uy, ux);
  const seed = contactReach(state.radius, state.facing, state.shieldSegments, toward)
    + contactReach(obstacle.radius, obstacle.facing, obstacle.shieldSegments, toward + Math.PI);
  buildContactShape(ownShape, state.radius, state.facing, state.shieldSegments);
  buildContactShape(otherShape, obstacle.radius, obstacle.facing, obstacle.shieldSegments);
  return contactDistance(ownShape, otherShape, ux, uy, seed);
}

const cloneState = (bot: PredictedOwnBot): PredictedOwnBot => ({
  ...bot,
  position: { ...bot.position },
  // Copied, not aliased. Reconciliation resets from a live snapshot every frame,
  // and a plate array shared across the prediction boundary is a mutation waiting
  // to be blamed on the netcode.
  shieldSegments: [...bot.shieldSegments],
  bays: bot.bays.map((item) => item && { ...item }),
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
  /** Per-obstacle motion state for this snapshot: explicit when the caller knows
   * it, otherwise inferred from the previous snapshot's position. */
  private readonly obstacleMoving = new Map<string, boolean>();
  private readonly lastObstaclePositions = new Map<string, Vec2>();
  /**
   * Consecutive snapshots spent touching each hostile, mirroring the server's dwell
   * count so a predicted bump and an authoritative one agree about which dashes are
   * disarmed.
   */
  private readonly contactDwell = new Map<string, number>();
  /** The clinches frozen for the length of the current local dash. */
  private readonly dashBlockedTargets = new Set<string>();
  private channelFrozen = false;
  /** Contact point of the most recent predicted dash stop; a side channel
   * (survives replay resets) so the session can flash impact FX instantly. */
  private dashContact: PredictedDashContact | null = null;
  /**
   * Gridded per floor, matching the server. Prediction runs the same resolver over
   * the same geometry every frame, so it pays the same cost and has to produce the
   * same answer — see `solidIndex.ts`.
   */
  private readonly solidsByFloor = new Map<string, SolidIndex>();
  private readonly doorSolidsByFloor = new Map<string, Solid[]>();

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
    if (bot.dashActiveMs <= 0) this.dashBlockedTargets.clear();
  }

  /** Latest known other bots (alive, same floor); refreshed per snapshot. */
  setObstacles(obstacles: PredictionObstacle[]): void {
    this.obstacles = obstacles;
    this.obstacleMoving.clear();
    for (const obstacle of obstacles) {
      const previous = this.lastObstaclePositions.get(obstacle.id);
      this.obstacleMoving.set(
        obstacle.id,
        obstacle.moving
          ?? (previous !== undefined
            && Math.hypot(obstacle.position.x - previous.x, obstacle.position.y - previous.y) > 0.001),
      );
      this.lastObstaclePositions.set(obstacle.id, { ...obstacle.position });
    }
    this.updateClinches();
  }

  /**
   * The server's dwell count, run once per snapshot rather than per replayed input.
   *
   * Per snapshot because replay advances the same frame many times over: counting
   * inside `advance` would make the dwell depend on how many inputs happened to be
   * buffered, which is not a property of the world. Authoritative obstacle positions
   * against the predicted own position — the same pair everything else here reasons
   * about.
   */
  private updateClinches(): void {
    const touchingNow = new Set<string>();
    for (const obstacle of this.obstacles) {
      if (!obstacle.hostile) continue;
      const gap = Math.hypot(
        obstacle.position.x - this.state.position.x,
        obstacle.position.y - this.state.position.y,
      ) - contactGap(this.state, obstacle, this.state.position);
      if (gap > DASH_CONTACT_EPSILON_PX) continue;
      this.contactDwell.set(obstacle.id, (this.contactDwell.get(obstacle.id) ?? 0) + 1);
      touchingNow.add(obstacle.id);
    }
    // Obstacles arrive pre-filtered to this bot's own floor, so anything absent has
    // gone down, left the floor, or left the match. All of those end the contact.
    for (const id of this.contactDwell.keys()) {
      if (!touchingNow.has(id)) this.contactDwell.delete(id);
    }
  }

  /** Authoritative moving-door collision from the latest rendered snapshot. */
  setDoors(doors: readonly DoorEntity[]): void {
    this.doorSolidsByFloor.clear();
    for (const door of doors) {
      if (!door.blocking) continue;
      const solids = this.doorSolidsByFloor.get(door.floorId) ?? [];
      solids.push(rectSolid(doorEntityCollisionRect(door)));
      this.doorSolidsByFloor.set(door.floorId, solids);
    }
  }

  /** Mirrors the server's stationary-channel rule: while this bot channels a
   * loot/revive/consume, movement input is ignored (timers still run). */
  setChannelFrozen(frozen: boolean): void {
    this.channelFrozen = frozen;
  }

  /** One-shot read of the latest predicted dash impact (null when none). */
  consumeDashContact(): PredictedDashContact | null {
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
      dashOverchargeMs: this.state.dashOverchargeMs + (next.dashOverchargeMs - this.state.dashOverchargeMs) * alpha,
    };
  }

  private advance(state: PredictedOwnBot, input: InputCommand, elapsedMs: number, consumeDash: boolean): PredictedOwnBot {
    const move = clampInputVector(input.move);
    state.dashOverchargeMs = Math.max(0, state.dashOverchargeMs - elapsedMs);
    state.dashCooldownMs = state.dashOverchargeMs > 0
      ? 0
      : Math.max(0, state.dashCooldownMs - elapsedMs);
    state.dashActiveMs = Math.max(0, state.dashActiveMs - elapsedMs);

    if (
      consumeDash
      && input.useBay !== undefined
      && Number.isInteger(input.useBay)
      && input.useBay >= 0
      && input.useBay < state.bays.length
    ) {
      const item = state.bays[input.useBay];
      if (item?.kind === "powerup" && item.type === "dashOvercharge") {
        state.bays[input.useBay] = null;
        state.dashOverchargeMs = this.config.dashOverchargeDurationMs;
        state.dashCooldownMs = 0;
      }
    }

    if (
      consumeDash
      && input.dash
      && (state.dashOverchargeMs > 0 || state.dashCooldownMs <= 0)
      && state.dashActiveMs <= 0
    ) {
      state.dashActiveMs = this.config.dashDurationMs;
      state.dashCooldownMs = state.dashOverchargeMs > 0 ? 0 : this.config.dashCooldownMs;
      this.dashBlockedTargets.clear();
      for (const [targetId, ticks] of this.contactDwell) {
        if (ticks >= DASH_CLINCH_TICKS) this.dashBlockedTargets.add(targetId);
      }
    }

    // Mirror the server: a dash rides the LAST aim, so releasing the keys
    // mid-dash no longer desyncs the predicted dash from the real one.
    if (Math.hypot(move.x, move.y) > 0.05 && consumeDash) {
      this.lastAim = normalize(move);
    }
    const direction = this.channelFrozen ? { x: 0, y: 0 } : state.dashActiveMs > 0 ? this.lastAim : move;
    const speed = state.dashActiveMs > 0 ? this.config.dashSpeed : this.config.playerSpeed;
    if (Math.hypot(direction.x, direction.y) > 0.05) {
      state.facing = Math.atan2(direction.y, direction.x);
    }

    let index = this.solidsByFloor.get(state.floorId);
    if (!index) {
      index = buildSolidIndex(collectSolids(this.map, state.floorId));
      this.solidsByFloor.set(state.floorId, index);
    }
    const solids = withExtraSolids(index, this.doorSolidsByFloor.get(state.floorId) ?? []);

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
        if (sweep - contactGap(state, obstacle, position) > DASH_HIT_FORGIVENESS_PX) continue;
        const startedTouching = this.dashBlockedTargets.has(obstacle.id);
        const closing = (position.x - previous.x) * (obstacle.position.x - previous.x)
          + (position.y - previous.y) * (obstacle.position.y - previous.y) > 0;
        // A dash only reaches what it drives INTO, mirroring the server. The swept
        // segment is within reach of a body the dash STARTED on whichever way it then
        // travels, so without this a dash used to escape a clinch registers against
        // the thing it is escaping. Was masked while anything touching was disarmed
        // outright; contact having to persist made it reachable.
        if (!closing) continue;
        const blocked = startedTouching;
        if (!blocked && obstacle.damageable === false) continue;
        state.dashActiveMs = 0;
        const dx = position.x - obstacle.position.x;
        const dy = position.y - obstacle.position.y;
        const dist = Math.hypot(dx, dy);
        const touching = contactGap(state, obstacle, position);
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
          targetId: obstacle.id,
          kind: blocked
            ? "bump"
            : (obstacle.dashActiveMs ?? 0) > 0
                && activeDashesOppose(state, obstacle, position)
                && platesMeet(state, obstacle, position)
              ? "clash"
              : "hit",
          position: {
            x: (position.x + obstacle.position.x) / 2,
            y: (position.y + obstacle.position.y) / 2,
          },
        };
        break;
      }
    }

    /**
     * Shoulder past other bots exactly the way the server's separation pass
     * does — the same yield rule, over the same bodies, in the same order.
     *
     * It used to be an `if (moving)` gate around a hardcoded `yieldFraction = 1`.
     * Both halves were wrong against the server, which uses
     * `aMoving === bMoving ? 0.5 : aMoving ? 1 : 0` and therefore also pushes two
     * bodies that are both standing still. Two movers in contact were predicted
     * with twice the server's correction and two standers with none of it: up to
     * 2.5 px/tick, 150 px/s of rubber-band on the player's own body, on every
     * single shoulder.
     *
     * The one thing this cannot mirror is the server's wall-shortfall relay,
     * which needs to know whether the OTHER body's push got through. That is
     * information the client does not have, like a hit or another player's input,
     * and reconciliation is what it is for.
     */
    const speedNow = Math.hypot(direction.x, direction.y) * speed;
    const selfMoving = speedNow > MOVING_SPEED;
    // Published, because the renderer reads it off the snapshot for the viewer's own
    // body the same way it reads it for everyone else's.
    state.moving = selfMoving;
    const maxPushPx = (this.config.botSeparationSpeed * elapsedMs) / 1000;
    for (const obstacle of this.obstacles) {
      const otherMoving = this.obstacleMoving.get(obstacle.id) ?? true;
      const yieldFraction = selfMoving === otherMoving ? 0.5 : selfMoving ? 1 : 0;
      const span = state.radius + obstacle.radius;
      const away = separationAxis(position, obstacle.position, coincidentSeparationAxis(state.id, obstacle.id));
      if (Math.hypot(obstacle.position.x - position.x, obstacle.position.y - position.y) >= span) {
        // The server's prune, so the two agree about which pairs are even tested.
        continue;
      }
      // The pair's real contact distance, off the same axis the push uses — the
      // server derives `need` the same way, including at coincident centres where
      // the axis is invented.
      const need = contactGapAlong(state, obstacle, -away.x, -away.y);
      const push = separationPush(position, obstacle.position, need, maxPushPx, yieldFraction, away);
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

function platesMeet(
  state: PredictedOwnBot,
  obstacle: PredictionObstacle,
  ownPosition: Vec2,
): boolean {
  if (state.shieldSegments.length === 0 || obstacle.shieldSegments.length === 0) return false;
  const dx = obstacle.position.x - ownPosition.x;
  const dy = obstacle.position.y - ownPosition.y;
  const dist = Math.hypot(dx, dy);
  const ux = dist > 0.001 ? dx / dist : 1;
  const uy = dist > 0.001 ? dy / dist : 0;
  buildContactShape(ownShape, state.radius, state.facing, state.shieldSegments);
  buildContactShape(otherShape, obstacle.radius, obstacle.facing, obstacle.shieldSegments);
  const ownPlate = contactingPlate(
    ownShape,
    state.facing,
    state.shieldSegments,
    otherShape,
    ux,
    uy,
  );
  const obstaclePlate = contactingPlate(
    otherShape,
    obstacle.facing,
    obstacle.shieldSegments,
    ownShape,
    -ux,
    -uy,
  );
  return ownPlate !== null && obstaclePlate !== null;
}
