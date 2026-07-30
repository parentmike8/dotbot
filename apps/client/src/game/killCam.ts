import { doorRuntimeId, physicsFloorId } from "@dotbot/game/mapModel";
import type { DoorEntity, GameSnapshot, MapDocument } from "@dotbot/game/types";
import type { EntityMeta, KillCamActor, KillCamClip, KillCamFrame } from "@dotbot/protocol";

export const KILL_CAM_PLAYBACK_RATE = 0.25;
const IMPACT_HOLD_MS = 600;

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
  const actors = [frame.victim, frame.source].filter((actor): actor is KillCamActor => actor !== undefined);
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
    return {
      x: (frame.victim.position.x + frame.source.position.x) / 2,
      y: (frame.victim.position.y + frame.source.position.y) / 2,
    };
  }
  const nearingImpact = frame.tick >= clip.deathTick - clip.tickHz * 0.5;
  if (nearingImpact) {
    return {
      x: (frame.victim.position.x + clip.cause.position.x) / 2,
      y: (frame.victim.position.y + clip.cause.position.y) / 2,
    };
  }
  return frame.victim.position;
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
    blockingDoorIds: [...frame.blockingDoorIds],
  };
}
