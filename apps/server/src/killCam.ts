import { contextKey, doorEntityCollisionRect, physicsFloorId } from "@dotbot/game/mapModel";
import type { DoorEntity, DownCause, GameSnapshot, MapDocument } from "@dotbot/game/types";
import { distance } from "@dotbot/game/math";
import { hasLineOfSight, OUTDOOR_SIGHT, seesOutdoors } from "@dotbot/game/visibility";
import type { KillCamActor, KillCamClip, KillCamFrame } from "@dotbot/protocol";

type HistoryActor = KillCamActor;

type HistoryFrame = {
  tick: number;
  tickHz: number;
  bots: Map<string, HistoryActor>;
  doors: DoorEntity[];
};

type KillCamHistoryOptions = {
  /** Four seconds at the shipped 60 Hz simulation rate. */
  historyTicks?: number;
};

const DEFAULT_HISTORY_TICKS = 4 * 60;
const DOOR_CAPTURE_RANGE = OUTDOOR_SIGHT + 80;

/**
 * Server-authoritative, privacy-minimal history used only to build a clip after
 * a down. It stores no inventory, intel, marks, radar, dots, mines, noise, or
 * interaction state.
 */
export class KillCamHistory {
  private readonly frames: HistoryFrame[] = [];
  private readonly historyTicks: number;

  constructor(
    private readonly map: MapDocument,
    options: KillCamHistoryOptions = {},
  ) {
    this.historyTicks = options.historyTicks ?? DEFAULT_HISTORY_TICKS;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  record(snapshot: GameSnapshot): void {
    const tick = snapshot.debug.tickCount;
    const bots = new Map(snapshot.bots.map((bot) => [bot.id, copyActor(bot)]));
    const doors = (snapshot.doors ?? []).map((door) => ({
      ...door,
      position: { ...door.position },
    }));
    const duplicate = this.frames.at(-1)?.tick === tick;
    const frame = { tick, tickHz: snapshot.debug.tickHz, bots, doors };
    if (duplicate) this.frames[this.frames.length - 1] = frame;
    else this.frames.push(frame);
    const oldestTick = tick - this.historyTicks;
    while (this.frames[0] && this.frames[0].tick < oldestTick) this.frames.shift();
  }

  createClip(victimId: string, sourceBotId: string | undefined, cause: DownCause): KillCamClip | null {
    const throughDeath = this.frames.filter((frame) => frame.tick <= cause.tick);
    if (throughDeath.length === 0) return null;
    const selected = throughDeath.filter((frame) => frame.tick >= cause.tick - this.historyTicks);
    const frames: KillCamFrame[] = [];

    for (const frame of selected) {
      const victim = frame.bots.get(victimId);
      if (!victim) continue;
      const nearbyBlockingDoors = frame.doors.filter((door) =>
        door.blocking
        && door.floorId === physicsFloorId(this.map, victim.floorId)
        && distance(door.position, victim.position) <= DOOR_CAPTURE_RANGE);
      const blockingDoorIds = nearbyBlockingDoors
        .filter((door) => historicallyVisibleDoor(this.map, victim, door, nearbyBlockingDoors))
        .map((door) => door.id)
        .sort();
      const source = cause.kind === "mine" || cause.kind === "environment" || !sourceBotId
        ? undefined
        : frame.bots.get(sourceBotId);
      frames.push({
        tick: frame.tick,
        victim: copyHistoryActor(victim),
        ...(source && historicallyVisible(this.map, victim, source, frame.doors)
          ? { source: copyHistoryActor(source) }
          : {}),
        blockingDoorIds,
      });
    }

    if (frames.length === 0) return null;
    const exposeSourceId = frames.some((frame) => frame.source !== undefined);
    return {
      id: `${victimId}-${cause.tick}`,
      victimId,
      ...(exposeSourceId && sourceBotId ? { sourceBotId } : {}),
      cause: {
        ...cause,
        position: { ...cause.position },
        direction: { ...cause.direction },
      },
      startTick: frames[0].tick,
      deathTick: cause.tick,
      tickHz: selected.at(-1)?.tickHz ?? 60,
      frames,
    };
  }

  /** Deterministic accounting for the bounded numeric/state payload retained by a room. */
  estimatedBytes(): number {
    let bytes = 0;
    for (const frame of this.frames) {
      bytes += 16;
      bytes += frame.bots.size * 72;
      bytes += frame.doors.length * 48;
    }
    return bytes;
  }
}

function historicallyVisibleDoor(
  map: MapDocument,
  victim: HistoryActor,
  door: DoorEntity,
  nearbyBlockingDoors: readonly DoorEntity[],
): boolean {
  const victimContext = contextKey(map, victim.floorId, victim.position);
  const otherDoorOccluders = nearbyBlockingDoors
    .filter((candidate) => candidate.id !== door.id)
    .map(doorEntityCollisionRect);
  return hasLineOfSight(map, victimContext, victim.position, door.position, otherDoorOccluders);
}

function copyActor(bot: GameSnapshot["bots"][number]): HistoryActor {
  return {
    id: bot.id,
    position: { ...bot.position },
    facing: bot.facing,
    floorId: bot.floorId,
    shieldSegments: [...bot.shieldSegments],
    dashActiveMs: bot.dashActiveMs,
    state: bot.state,
  };
}

function copyHistoryActor(actor: HistoryActor): HistoryActor {
  return {
    ...actor,
    position: { ...actor.position },
    shieldSegments: [...actor.shieldSegments],
  };
}

function historicallyVisible(
  map: MapDocument,
  victim: HistoryActor,
  source: HistoryActor,
  doors: readonly DoorEntity[],
): boolean {
  if (physicsFloorId(map, victim.floorId) !== physicsFloorId(map, source.floorId)) return false;
  const occluders = doors
    .filter((door) => door.blocking && door.floorId === physicsFloorId(map, victim.floorId))
    .map(doorEntityCollisionRect);
  const victimContext = contextKey(map, victim.floorId, victim.position);
  const sourceContext = contextKey(map, source.floorId, source.position);
  if (victimContext === sourceContext) {
    if (physicsFloorId(map, victim.floorId) === "outdoor"
      && distance(victim.position, source.position) > OUTDOOR_SIGHT) return false;
    return hasLineOfSight(map, victimContext, victim.position, source.position, occluders);
  }
  return seesOutdoors(map, victim.floorId, victim.position, source.floorId, source.position, occluders);
}
