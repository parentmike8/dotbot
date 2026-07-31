import { doorRuntimeId, physicsFloorId } from "@dotbot/game/mapModel";
import { buildContactShape, contactDistance, makeContactShape } from "@dotbot/game/bodyContact";
import type { DoorEntity, GameSnapshot, MapDocument } from "@dotbot/game/types";
import type { EntityMeta, KillCamActor, KillCamClip, KillCamFrame } from "@dotbot/protocol";

/** Slow enough to read the impact, without turning a one-second attack into a wait. */
export const KILL_CAM_PLAYBACK_RATE = 0.8;
const IMPACT_HOLD_MS = 1_200;
const CONTACT_BLEND_SECONDS = 0.18;

export function killCamLabel(clip: KillCamClip, sourceName?: string): string {
  const cause = clip.cause.kind === "environment" ? "IMPACT" : clip.cause.kind.toUpperCase();
  return sourceName ? `DOWNED BY ${sourceName.toUpperCase()} · ${cause}` : cause;
}

export class KillCamPlayback {
  private elapsedRealMs = 0;
  private skipped = false;

  constructor(readonly clip: KillCamClip) {}

  get replayTick(): number {
    const elapsedReplayMs = this.elapsedRealMs * KILL_CAM_PLAYBACK_RATE;
    return Math.min(
      this.clip.deathTick,
      this.clip.startTick + elapsedReplayMs / (1000 / this.clip.tickHz),
    );
  }

  get progress(): number {
    const span = Math.max(1, this.clip.deathTick - this.clip.startTick);
    return Math.max(0, Math.min(1, (this.replayTick - this.clip.startTick) / span));
  }

  get finished(): boolean {
    if (this.skipped) return true;
    const replayDurationMs = (this.clip.deathTick - this.clip.startTick) * (1000 / this.clip.tickHz);
    return this.elapsedRealMs >= replayDurationMs / KILL_CAM_PLAYBACK_RATE + IMPACT_HOLD_MS;
  }

  advance(elapsedMs: number): void {
    this.elapsedRealMs += Math.max(0, elapsedMs);
  }

  skip(): void {
    this.skipped = true;
  }

  sample(): KillCamFrame {
    return sampleClip(this.clip.frames, this.replayTick);
  }
}

export function killCamSnapshot(
  frame: KillCamFrame,
  clip: KillCamClip,
  meta: ReadonlyMap<string, EntityMeta>,
  doorCatalog: readonly DoorEntity[],
): GameSnapshot {
  const presentedSource = frame.source
    ? sourceAtVisibleContact(frame, clip, meta)
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
): KillCamActor | undefined {
  const source = frame.source;
  if (!source || (clip.cause.kind !== "dash" && clip.cause.kind !== "ram")) return source;
  const blendTicks = Math.max(1, clip.tickHz * CONTACT_BLEND_SECONDS);
  const blend = Math.max(0, Math.min(1, (frame.tick - (clip.deathTick - blendTicks)) / blendTicks));
  if (blend <= 0) return source;

  const victimRadius = meta.get(frame.victim.id)?.radius ?? 24;
  const sourceRadius = meta.get(source.id)?.radius ?? 24;
  const victimShape = makeContactShape(frame.victim.shieldSegments.length);
  const sourceShape = makeContactShape(source.shieldSegments.length);
  buildContactShape(victimShape, victimRadius, frame.victim.facing, frame.victim.shieldSegments);
  buildContactShape(sourceShape, sourceRadius, source.facing, source.shieldSegments);

  const causeLength = Math.hypot(clip.cause.direction.x, clip.cause.direction.y);
  const recordedDx = source.position.x - frame.victim.position.x;
  const recordedDy = source.position.y - frame.victim.position.y;
  const recordedLength = Math.hypot(recordedDx, recordedDy);
  const ux = causeLength > 0.001
    ? -clip.cause.direction.x / causeLength
    : recordedLength > 0.001 ? recordedDx / recordedLength : 1;
  const uy = causeLength > 0.001
    ? -clip.cause.direction.y / causeLength
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

function sampleClip(frames: readonly KillCamFrame[], tick: number): KillCamFrame {
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
      return {
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
