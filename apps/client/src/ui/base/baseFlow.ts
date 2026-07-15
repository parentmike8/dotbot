import type { MapDocument, MapObject, PlacementSlot, Rect, Vec2 } from "@dotbot/game/types";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import { physicsFloorId } from "@dotbot/game/mapModel";

export type BaseTarget =
  | { id: string; type: "deployment"; center: Vec2; rect: Rect }
  | { id: string; type: "object"; center: Vec2; rect: Rect; object: MapObject }
  | { id: string; type: "emptySlot"; center: Vec2; rect: Rect; slot: PlacementSlot };

export type BaseChannelState = {
  targetId: string;
  startedAt: number;
  lastPosition: Vec2;
  completedId: string | null;
};

export function findBaseTarget(map: MapDocument, position: Vec2, floorId = OUTDOOR_FLOOR_ID, interactionReach = 46): BaseTarget | null {
  const deployment = map.extractionPoints[0];
  if (floorId === OUTDOOR_FLOOR_ID && deployment && contains(deployment.rect, position)) {
    return { id: deployment.id, type: "deployment", center: center(deployment.rect), rect: deployment.rect };
  }
  const floor = map.buildings[0]?.floors.find((candidate) => physicsFloorId(map, candidate.id) === floorId);
  // Only slot-backed furniture is interactive; architectural decor is not.
  const object = floor?.objects.find((candidate) => candidate.slotId && distanceToRect(position, candidate) <= interactionReach);
  if (object) return { id: object.id, type: "object", center: center(object), object, rect: object };
  const occupied = new Set(floor?.objects.map((candidate) => candidate.slotId));
  const slot = map.placementSlots?.find((candidate) =>
    candidate.floor === floor?.label && !occupied.has(candidate.id) && distanceToRect(position, candidate.rect) <= interactionReach,
  );
  return slot ? { id: `empty-${slot.id}`, type: "emptySlot", center: center(slot.rect), slot, rect: slot.rect } : null;
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

function contains(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}
function center(rect: Rect): Vec2 { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }
function distance(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function distanceToRect(point: Vec2, rect: Rect): number {
  const dx = point.x - Math.max(rect.x, Math.min(point.x, rect.x + rect.w));
  const dy = point.y - Math.max(rect.y, Math.min(point.y, rect.y + rect.h));
  return Math.hypot(dx, dy);
}
