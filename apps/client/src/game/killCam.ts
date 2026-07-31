import { doorRuntimeId, physicsFloorId } from "@dotbot/game/mapModel";
import { buildContactShape, contactDistance, makeContactShape } from "@dotbot/game/bodyContact";
import { platesForCount, restoreShieldPlate } from "@dotbot/game/shields";
import type { DoorEntity, GameSnapshot, MapDocument } from "@dotbot/game/types";
import type { EntityMeta, KillCamActor, KillCamClip, KillCamFrame } from "@dotbot/protocol";

/** Two readable passes: orient once, then inspect the same contact more slowly. */
export const KILL_CAM_PLAYBACK_RATES = [0.8, 0.7] as const;
export const KILL_CAM_BETWEEN_PASS_HOLD_MS = 1_500;
export const KILL_CAM_MAX_OPEN_MS = 30_000;
const CONTACT_BLEND_SECONDS = 0.18;
const CONTACT_RELEASE_SECONDS = 0.12;
const DEFAULT_REPLAY_BODY_RADIUS = 24;
const MAX_INFERRED_IMPACT_DISTANCE = 144;

export type KillCamImpact = {
  tick: number;
  result: "plateBreak" | "downed";
  position: { x: number; y: number };
  targetPosition: { x: number; y: number };
  direction: { x: number; y: number };
  sourceId?: string;
};

export function killCamLabel(clip: KillCamClip, sourceName?: string): string {
  const cause = clip.cause.kind === "environment" ? "IMPACT" : clip.cause.kind.toUpperCase();
  return sourceName ? `DOWNED BY ${sourceName.toUpperCase()} · ${cause}` : cause;
}

export class KillCamPlayback {
  private elapsedRealMs = 0;
  private skipped = false;
  readonly impacts: KillCamImpact[];

  constructor(readonly clip: KillCamClip) {
    this.impacts = killCamImpacts(clip);
  }

  private get replayDurationMs(): number {
    return (this.clip.deathTick - this.clip.startTick) * (1000 / this.clip.tickHz);
  }

  get pass(): 1 | 2 {
    const firstPassMs = this.replayDurationMs / KILL_CAM_PLAYBACK_RATES[0];
    return this.elapsedRealMs < firstPassMs + KILL_CAM_BETWEEN_PASS_HOLD_MS ? 1 : 2;
  }

  get replaysComplete(): boolean {
    const totalReplayMs = KILL_CAM_PLAYBACK_RATES.reduce(
      (total, rate) => total + this.replayDurationMs / rate,
      KILL_CAM_BETWEEN_PASS_HOLD_MS,
    );
    return this.elapsedRealMs >= totalReplayMs;
  }

  get replayTick(): number {
    const firstPassMs = this.replayDurationMs / KILL_CAM_PLAYBACK_RATES[0];
    if (this.elapsedRealMs < firstPassMs) {
      const elapsedReplayMs = this.elapsedRealMs * KILL_CAM_PLAYBACK_RATES[0];
      return this.clip.startTick + elapsedReplayMs / (1000 / this.clip.tickHz);
    }
    if (this.elapsedRealMs < firstPassMs + KILL_CAM_BETWEEN_PASS_HOLD_MS) {
      return this.clip.deathTick;
    }
    const secondPassElapsedMs = this.elapsedRealMs - firstPassMs - KILL_CAM_BETWEEN_PASS_HOLD_MS;
    const secondReplayMs = secondPassElapsedMs * KILL_CAM_PLAYBACK_RATES[1];
    return Math.min(
      this.clip.deathTick,
      this.clip.startTick + secondReplayMs / (1000 / this.clip.tickHz),
    );
  }

  get progress(): number {
    const span = Math.max(1, this.clip.deathTick - this.clip.startTick);
    return Math.max(0, Math.min(1, (this.replayTick - this.clip.startTick) / span));
  }

  get finished(): boolean {
    return this.skipped || this.elapsedRealMs >= KILL_CAM_MAX_OPEN_MS;
  }

  advance(elapsedMs: number): void {
    this.elapsedRealMs += Math.max(0, elapsedMs);
  }

  skip(): void {
    this.skipped = true;
  }

  sample(): KillCamFrame {
    return sampleClip(this.clip.frames, this.replayTick, this.clip.impacts);
  }
}

/** Exact event data on current clips; shield-state reconstruction for old rooms. */
export function killCamImpacts(clip: KillCamClip): KillCamImpact[] {
  if (clip.impacts) {
    const exact = clip.impacts.map((impact) => ({
      ...impact,
      position: { ...impact.position },
      direction: { ...impact.direction },
      targetPosition: {
        ...sampleClip(clip.frames, impact.tick).victim.position,
      },
    }));
    if (!exact.some((impact) => impact.result === "downed" && impact.tick === clip.deathTick)) {
      const deathFrame = clip.frames.at(-1)?.victim;
      exact.push({
        tick: clip.deathTick,
        result: "downed",
        position: { ...clip.cause.position },
        targetPosition: deathFrame ? { ...deathFrame.position } : { ...clip.cause.position },
        direction: { ...clip.cause.direction },
        ...(clip.sourceBotId ? { sourceId: clip.sourceBotId } : {}),
      });
    }
    return exact.sort((a, b) => a.tick - b.tick);
  }

  const impacts: KillCamImpact[] = [];
  for (let index = 1; index < clip.frames.length; index += 1) {
    const older = clip.frames[index - 1].victim;
    const newerFrame = clip.frames[index];
    const newer = newerFrame.victim;
    if (newer.state !== "alive") continue;
    const plateCount = Math.max(older.shieldSegments.length, newer.shieldSegments.length);
    const olderPlateCount = older.shieldSegments.filter((plate) => plate > 0).length;
    const newerPlateCount = newer.shieldSegments.filter((plate) => plate > 0).length;
    if (newerPlateCount >= olderPlateCount) continue;

    // Plates re-seat after every hit, so the array index that became zero is
    // the new trailing slot, not necessarily the arc that was struck. The
    // admitted attacker position is the honest impact direction when present.
    const source = newerFrame.source;
    const sourceDx = source ? source.position.x - newer.position.x : 0;
    const sourceDy = source ? source.position.y - newer.position.y : 0;
    const sourceDistance = Math.hypot(sourceDx, sourceDy);
    const admittedSource = source && sourceDistance <= MAX_INFERRED_IMPACT_DISTANCE ? source : undefined;
    const fallbackBrokenPlate = newer.shieldSegments.findIndex((plate) => plate <= 0);
    const fallbackAngle = newer.facing
      + Math.max(0, fallbackBrokenPlate) * Math.PI * 2 / Math.max(1, plateCount);
    const towardSource = admittedSource && sourceDistance > 0.001
      ? { x: sourceDx / sourceDistance, y: sourceDy / sourceDistance }
      : { x: Math.cos(fallbackAngle), y: Math.sin(fallbackAngle) };
    impacts.push({
      tick: newerFrame.tick,
      result: "plateBreak",
      position: {
        x: newer.position.x + towardSource.x * DEFAULT_REPLAY_BODY_RADIUS,
        y: newer.position.y + towardSource.y * DEFAULT_REPLAY_BODY_RADIUS,
      },
      targetPosition: { ...newer.position },
      direction: { x: -towardSource.x, y: -towardSource.y },
      ...(admittedSource ? { sourceId: admittedSource.id } : {}),
    });
  }
  const deathFrame = clip.frames.at(-1)?.victim;
  impacts.push({
    tick: clip.deathTick,
    result: "downed",
    position: { ...clip.cause.position },
    targetPosition: deathFrame ? { ...deathFrame.position } : { ...clip.cause.position },
    direction: { ...clip.cause.direction },
    ...(clip.sourceBotId ? { sourceId: clip.sourceBotId } : {}),
  });
  return impacts.sort((a, b) => a.tick - b.tick);
}

export function killCamSnapshot(
  frame: KillCamFrame,
  clip: KillCamClip,
  meta: ReadonlyMap<string, EntityMeta>,
  doorCatalog: readonly DoorEntity[],
  impacts: readonly KillCamImpact[] = killCamImpacts(clip),
): GameSnapshot {
  const presentedSource = frame.source
    ? sourceAtVisibleContact(frame, clip, meta, impacts)
    : undefined;
  const actors = [frame.victim, presentedSource, ...frame.visibleBots]
    .filter((actor): actor is KillCamActor => actor !== undefined);
  const bots = actors.map((actor) => {
    const entity = meta.get(actor.id);
    const maxShields = entity?.maxShields ?? actor.shieldSegments.length;
    return {
      id: actor.id,
      name: entity?.name ?? (actor.id === clip.victimId ? "You" : "Source"),
      squadId: entity?.squadId ?? (actor.id === clip.victimId ? "victim" : "source"),
      isAmbient: entity?.isAmbient ?? false,
      color: entity?.color ?? "#111111",
      position: { ...actor.position },
      radius: entity?.radius ?? 24,
      state: actor.state,
      floorId: actor.floorId,
      facing: actor.facing,
      moving: false,
      maxShields,
      shields: actor.shieldSegments.reduce((sum, plate) => sum + plate, 0),
      shieldSegments: [...actor.shieldSegments],
      bays: [],
      hold: [],
      carriedCount: 0,
      searched: false,
      pleaded: false,
      radarActiveMs: 0,
      radarPings: [],
      dashOverchargeCharges: 0,
      incognitoMs: 0,
      dashCooldownMs: 0,
      dashActiveMs: actor.dashActiveMs,
      invulnerabilityMs: 0,
    };
  });
  const blocking = new Set(frame.blockingDoorIds);
  const doors = doorCatalog
    .filter((door) => blocking.has(door.id))
    .map((door) => ({ ...door, position: { ...door.position }, blocking: true, openness: 0, phase: "closed" as const }));
  const mines = clip.cause.kind === "mine" && frame.tick >= clip.deathTick - clip.tickHz * 0.1
    ? [{
        id: `kill-cam-cause-${clip.id}`,
        position: { ...clip.cause.position },
        radius: 12,
        placedByBotId: "",
        squadId: "cause",
        floorId: frame.victim.floorId,
        placedAtMs: 0,
        revealedToBotIds: [],
        presentation: "revealed" as const,
      }]
    : [];
  return {
    timeMs: frame.tick * (1000 / clip.tickHz),
    bots,
    dots: [],
    mines,
    coverages: [],
    noises: [],
    doors,
    debug: {
      tickHz: clip.tickHz,
      tickCount: Math.round(frame.tick),
      fps: 0,
      activeBodies: bots.length,
      activeDots: 0,
    },
  };
}

/**
 * A dash is validated against the attacker's swept path, then the simulation
 * resolves its final position against nearby solids. In a tight corner that
 * post-hit placement can be several body widths away even though the sweep
 * genuinely connected. Ease the replay's final fraction onto the exact shared
 * body-contact distance so the kill cam shows the contact combat adjudicated.
 */
function sourceAtVisibleContact(
  frame: KillCamFrame,
  clip: KillCamClip,
  meta: ReadonlyMap<string, EntityMeta>,
  impacts: readonly KillCamImpact[],
): KillCamActor | undefined {
  const source = frame.source;
  if (!source || (clip.cause.kind !== "dash" && clip.cause.kind !== "ram")) return source;
  const blendTicks = Math.max(1, clip.tickHz * CONTACT_BLEND_SECONDS);
  const releaseTicks = Math.max(1, clip.tickHz * CONTACT_RELEASE_SECONDS);
  const impact = impacts
    .filter((candidate) => candidate.sourceId === source.id)
    .filter((candidate) => frame.tick >= candidate.tick - blendTicks)
    .filter((candidate) => candidate.result === "downed" || frame.tick <= candidate.tick + releaseTicks)
    .sort((a, b) => Math.abs(frame.tick - a.tick) - Math.abs(frame.tick - b.tick))[0];
  if (!impact) return source;
  const blend = frame.tick <= impact.tick
    ? Math.max(0, Math.min(1, (frame.tick - (impact.tick - blendTicks)) / blendTicks))
    : impact.result === "downed"
      ? 1
      : Math.max(0, 1 - (frame.tick - impact.tick) / releaseTicks);
  if (blend <= 0) return source;

  const victimRadius = meta.get(frame.victim.id)?.radius ?? 24;
  const sourceRadius = meta.get(source.id)?.radius ?? 24;
  const victimShape = makeContactShape(frame.victim.shieldSegments.length);
  const sourceShape = makeContactShape(source.shieldSegments.length);
  const victimSegments = [...frame.victim.shieldSegments];
  // The exact-tick frame already carries the post-hit shield count. Contact was
  // established against the pre-hit shell, so restore the plate only for this
  // geometric witness or the replay pulls the attacker through the plate to the
  // smaller core on the same frame the plate breaks.
  if (impact.result === "plateBreak") restoreShieldPlate(victimSegments);
  buildContactShape(victimShape, victimRadius, frame.victim.facing, victimSegments);
  buildContactShape(sourceShape, sourceRadius, source.facing, source.shieldSegments);

  const causeLength = Math.hypot(impact.direction.x, impact.direction.y);
  const recordedDx = source.position.x - frame.victim.position.x;
  const recordedDy = source.position.y - frame.victim.position.y;
  const recordedLength = Math.hypot(recordedDx, recordedDy);
  const ux = causeLength > 0.001
    ? -impact.direction.x / causeLength
    : recordedLength > 0.001 ? recordedDx / recordedLength : 1;
  const uy = causeLength > 0.001
    ? -impact.direction.y / causeLength
    : recordedLength > 0.001 ? recordedDy / recordedLength : 0;
  const touching = contactDistance(victimShape, sourceShape, ux, uy, 0);
  const contact = {
    x: frame.victim.position.x + ux * touching,
    y: frame.victim.position.y + uy * touching,
  };
  return {
    ...source,
    position: {
      x: source.position.x + (contact.x - source.position.x) * blend,
      y: source.position.y + (contact.y - source.position.y) * blend,
    },
    shieldSegments: [...source.shieldSegments],
  };
}

/** Static door geometry keyed by the same runtime ids recorded by the server. */
export function killCamDoorCatalog(map: MapDocument): DoorEntity[] {
  const doors: DoorEntity[] = [];
  for (const building of map.buildings) {
    for (const floor of building.floors) {
      for (const doorway of floor.doorways) {
        if (!doorway.mechanism) continue;
        doors.push({
          id: doorRuntimeId(floor.id, doorway.id),
          doorwayId: doorway.id,
          buildingId: building.id,
          floorId: physicsFloorId(map, floor.id),
          position: { x: doorway.x, y: doorway.y },
          width: doorway.width,
          dir: doorway.dir,
          phase: "closed",
          openness: 0,
          blocking: true,
        });
      }
    }
  }
  return doors;
}

export function killCamCameraTarget(frame: KillCamFrame, clip: KillCamClip): { x: number; y: number } {
  if (frame.source) {
    const firstVisibleTick = clip.frames.find((candidate) => candidate.source)?.tick ?? frame.tick;
    const blendTicks = Math.max(1, clip.tickHz * 0.5);
    const sourceWeight = Math.max(0, Math.min(1, (frame.tick - firstVisibleTick) / blendTicks));
    const midpoint = {
      x: (frame.victim.position.x + frame.source.position.x) / 2,
      y: (frame.victim.position.y + frame.source.position.y) / 2,
    };
    return {
      x: frame.victim.position.x + (midpoint.x - frame.victim.position.x) * sourceWeight,
      y: frame.victim.position.y + (midpoint.y - frame.victim.position.y) * sourceWeight,
    };
  }
  const impactBlendStart = clip.deathTick - clip.tickHz * 0.5;
  if (frame.tick >= impactBlendStart) {
    const impactWeight = Math.max(0, Math.min(1, (frame.tick - impactBlendStart) / Math.max(1, clip.tickHz * 0.5)));
    const midpoint = {
      x: (frame.victim.position.x + clip.cause.position.x) / 2,
      y: (frame.victim.position.y + clip.cause.position.y) / 2,
    };
    return {
      x: frame.victim.position.x + (midpoint.x - frame.victim.position.x) * impactWeight,
      y: frame.victim.position.y + (midpoint.y - frame.victim.position.y) * impactWeight,
    };
  }
  return frame.victim.position;
}

/**
 * Interpolation may still present the victim as alive briefly after the
 * server delivers the death clip. An alive snapshot can end replay only after
 * this client has first observed the downed state; an explicit authoritative
 * revive/recruit event can end it immediately.
 */
export function liveStateEndsKillCam(
  observedDowned: boolean,
  victimState: KillCamActor["state"] | undefined,
  authorityRevived: boolean,
): boolean {
  return authorityRevived || (observedDowned && victimState === "alive");
}

function sampleClip(
  frames: readonly KillCamFrame[],
  tick: number,
  exactImpacts?: readonly { tick: number; result: "plateBreak" | "downed" }[],
): KillCamFrame {
  const first = frames[0];
  const last = frames.at(-1);
  if (!first || !last) throw new Error("Kill cam clip has no frames");
  if (tick <= first.tick) return copyFrame(first);
  if (tick >= last.tick) return copyFrame(last);

  let older = first;
  for (let index = 1; index < frames.length; index += 1) {
    const newer = frames[index];
    if (tick <= newer.tick) {
      const alpha = (tick - older.tick) / Math.max(1, newer.tick - older.tick);
      const sampled = {
        tick,
        victim: interpolateActor(older.victim, newer.victim, alpha),
        ...(
          older.source && newer.source
            ? { source: interpolateActor(older.source, newer.source, alpha) }
            : tick >= newer.tick - 1e-6 && newer.source
              ? { source: copyActor(newer.source) }
              : older.source && tick < newer.tick
                ? { source: copyActor(older.source) }
                : {}
        ),
        blockingDoorIds: [...older.blockingDoorIds],
        visibleBots: interpolateVisibleBots(older.visibleBots, newer.visibleBots, alpha),
      };
      // Visual frames are sampled at 20 Hz, but hits are authoritative 60 Hz
      // events. Between two visual samples, apply the exact event on its own tick
      // instead of leaving the old plate visible beside an already-playing flash.
      if (alpha < 1 && exactImpacts) {
        const landed = exactImpacts.filter((impact) =>
          impact.tick > older.tick && impact.tick <= tick);
        for (const impact of landed) {
          if (impact.result === "downed") {
            sampled.victim.state = "downed";
            sampled.victim.shieldSegments = platesForCount(sampled.victim.shieldSegments.length, 0);
            continue;
          }
          const remaining = Math.max(
            0,
            sampled.victim.shieldSegments.filter((plate) => plate > 0).length - 1,
          );
          sampled.victim.shieldSegments = platesForCount(
            sampled.victim.shieldSegments.length,
            remaining,
          );
        }
      }
      return sampled;
    }
    older = newer;
  }
  return copyFrame(last);
}

function interpolateActor(older: KillCamActor, newer: KillCamActor, alpha: number): KillCamActor {
  if (older.floorId !== newer.floorId) return alpha < 1 ? copyActor(older) : copyActor(newer);
  const angle = Math.atan2(Math.sin(newer.facing - older.facing), Math.cos(newer.facing - older.facing));
  return {
    ...older,
    position: {
      x: older.position.x + (newer.position.x - older.position.x) * alpha,
      y: older.position.y + (newer.position.y - older.position.y) * alpha,
    },
    facing: older.facing + angle * alpha,
    shieldSegments: alpha < 1 ? [...older.shieldSegments] : [...newer.shieldSegments],
    dashActiveMs: older.dashActiveMs + (newer.dashActiveMs - older.dashActiveMs) * alpha,
    state: alpha < 1 ? older.state : newer.state,
  };
}

function copyActor(actor: KillCamActor): KillCamActor {
  return { ...actor, position: { ...actor.position }, shieldSegments: [...actor.shieldSegments] };
}

function copyFrame(frame: KillCamFrame): KillCamFrame {
  return {
    tick: frame.tick,
    victim: copyActor(frame.victim),
    ...(frame.source ? { source: copyActor(frame.source) } : {}),
    visibleBots: frame.visibleBots.map(copyActor),
    blockingDoorIds: [...frame.blockingDoorIds],
  };
}

function interpolateVisibleBots(
  older: readonly KillCamActor[],
  newer: readonly KillCamActor[],
  alpha: number,
): KillCamActor[] {
  const newerById = new Map(newer.map((actor) => [actor.id, actor]));
  const result = older.flatMap((actor) => {
    const next = newerById.get(actor.id);
    if (next) {
      newerById.delete(actor.id);
      return [interpolateActor(actor, next, alpha)];
    }
    return alpha < 1 ? [copyActor(actor)] : [];
  });
  if (alpha >= 1) result.push(...[...newerById.values()].map(copyActor));
  return result;
}
