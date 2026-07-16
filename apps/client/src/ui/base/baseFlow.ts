import { defaultGameConfig } from "@dotbot/game/config";
import type { InteractionDot, MapDocument, MapObject, PlacementSlot, Rect, Vec2 } from "@dotbot/game/types";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import { physicsFloorId } from "@dotbot/game/mapModel";

export type BaseTarget =
  | { id: string; type: "deployment"; center: Vec2; rect: Rect; dot: InteractionDot }
  | { id: string; type: "object"; center: Vec2; rect: Rect; object: MapObject; dot: InteractionDot }
  | { id: string; type: "emptySlot"; center: Vec2; rect: Rect; slot: PlacementSlot; dot: InteractionDot };

export type BaseChannelState = {
  targetId: string;
  startedAt: number;
  lastPosition: Vec2;
  completedId: string | null;
};

export function findBaseTarget(
  map: MapDocument,
  position: Vec2,
  floorId = OUTDOOR_FLOOR_ID,
  interactionReach = defaultGameConfig.botRadius - defaultGameConfig.dotRadius - 2,
): BaseTarget | null {
  const dot = (map.interactionDots ?? [])
    .filter((candidate) => physicsFloorId(map, candidate.floorId) === floorId)
    .map((candidate) => ({ candidate, distance: distance(position, candidate.position) }))
    .filter(({ distance }) => distance <= interactionReach)
    .sort((a, b) => a.distance - b.distance || a.candidate.id.localeCompare(b.candidate.id))[0]?.candidate;
  if (!dot) return null;

  const floor = map.buildings[0]?.floors.find((candidate) => candidate.id === dot.floorId);
  if (dot.kind === "object") {
    const object = floor?.objects.find((candidate) => candidate.id === dot.targetId && candidate.slotId);
    return object ? { id: dot.id, type: "object", center: dot.position, object, rect: object, dot } : null;
  }
  if (dot.kind === "emptySlot") {
    const slot = map.placementSlots?.find((candidate) => candidate.id === dot.targetId && candidate.floor === floor?.label);
    return slot ? { id: dot.id, type: "emptySlot", center: dot.position, slot, rect: slot.rect, dot } : null;
  }
  const deployment = map.extractionPoints.find((candidate) => candidate.id === dot.targetId);
  return deployment ? { id: dot.id, type: "deployment", center: dot.position, rect: deployment.rect, dot } : null;
}

export function advanceBaseChannel(
  previous: BaseChannelState | null,
  target: BaseTarget | null,
  position: Vec2,
  timeMs: number,
  durationMs = 1000,
): { state: BaseChannelState; progress: number | null; completed: BaseTarget | null } {
  const moved = previous ? distance(previous.lastPosition, position) > 1.5 : true;
  if (!target) {
    return {
      state: { targetId: "", startedAt: timeMs, lastPosition: { ...position }, completedId: null },
      progress: null,
      completed: null,
    };
  }
  if (previous?.completedId === target.id && !moved) {
    return { state: { ...previous, lastPosition: { ...position } }, progress: null, completed: null };
  }
  const startedAt = !previous || previous.targetId !== target.id || moved ? timeMs : previous.startedAt;
  const progress = Math.min(1, Math.max(0, (timeMs - startedAt) / durationMs));
  const completed = progress >= 1 && previous?.completedId !== target.id ? target : null;
  return {
    state: {
      targetId: target.id,
      startedAt,
      lastPosition: { ...position },
      completedId: progress >= 1 ? target.id : moved ? null : previous?.completedId ?? null,
    },
    progress,
    completed,
  };
}

function distance(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
