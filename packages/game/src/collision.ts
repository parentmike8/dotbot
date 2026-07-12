import { clamp } from "./math";
import { isSolidObject, physicsFloorId } from "./mapModel";
import type { MapDocument, Rect, Vec2 } from "./types";

/** Static wall/object rectangles on one physics plane. GROUND plans share outdoor. */
export function collectSolidRects(map: MapDocument, floorId: string): Rect[] {
  const targetFloorId = physicsFloorId(map, floorId);
  const rects: Rect[] = [];

  if (targetFloorId === physicsFloorId(map, "outdoor")) {
    rects.push(...map.outdoor.walls, ...map.outdoor.objects.filter(isSolidObject));
  }

  for (const building of map.buildings) {
    for (const floor of building.floors) {
      if (physicsFloorId(map, floor.id) === targetFloorId) {
        rects.push(...floor.walls, ...floor.objects.filter(isSolidObject));
      }
    }
  }

  return rects;
}

export function separateCircleFromRect(position: Vec2, radius: number, wall: Rect): Vec2 {
  const closestX = clamp(position.x, wall.x, wall.x + wall.w);
  const closestY = clamp(position.y, wall.y, wall.y + wall.h);
  const offset = {
    x: position.x - closestX,
    y: position.y - closestY,
  };
  const distanceSquared = offset.x * offset.x + offset.y * offset.y;
  const radiusSquared = radius * radius;

  if (distanceSquared >= radiusSquared) {
    return position;
  }

  if (distanceSquared > 0.0001) {
    const distanceToWall = Math.sqrt(distanceSquared);
    const push = (radius - distanceToWall) / distanceToWall;
    return {
      x: position.x + offset.x * push,
      y: position.y + offset.y * push,
    };
  }

  const left = Math.abs(position.x - wall.x);
  const right = Math.abs(wall.x + wall.w - position.x);
  const top = Math.abs(position.y - wall.y);
  const bottom = Math.abs(wall.y + wall.h - position.y);
  const nearest = Math.min(left, right, top, bottom);

  if (nearest === left) {
    return { x: wall.x - radius, y: position.y };
  }

  if (nearest === right) {
    return { x: wall.x + wall.w + radius, y: position.y };
  }

  if (nearest === top) {
    return { x: position.x, y: wall.y - radius };
  }

  return { x: position.x, y: wall.y + wall.h + radius };
}
