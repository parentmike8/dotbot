import { pointToSolidDistanceSquared, rectSolid } from "@dotbot/game/geometry";
import type { Doorway, FloorPlan, MapObject, Rect, Solid, WallSegment } from "@dotbot/game/types";

/**
 * Room discovery.
 *
 * A DotBot floor is authored as walls and objects, with no room entities — so
 * the renderer finds rooms the same way a person reading the plan does: flood
 * fill the slab, treat wall runs *and* their door gaps as boundaries, then name
 * each enclosure by what is standing in it.
 *
 * This is what lets every partitioned space get its own floor finish without a
 * single authored coordinate. Add a partition anywhere in the city and the room
 * it creates picks up a finish; delete it and the finish merges away.
 */

export type RoomKind = "warehouse" | "shop" | "office" | "plant" | "store" | "circulation";

export type Room = {
  kind: RoomKind;
  /** Merged horizontal spans, one entry per grid row. Cheap to fill. */
  runs: Rect[];
  bounds: Rect;
  area: number;
  objects: MapObject[];
};

const CELL = 8;

/**
 * Doorways are gaps in the wall runs, so a plain wall flood fill leaks between
 * rooms. Closing each opening with a short barrier keeps enclosures distinct
 * while leaving the authored geometry — and therefore collision — untouched.
 */
function doorBarrier(door: Doorway): Rect {
  const jamb = 9;
  return door.dir === "h"
    ? { x: door.x - door.width / 2, y: door.y - jamb, w: door.width, h: jamb * 2 }
    : { x: door.x - jamb, y: door.y - door.width / 2, w: jamb * 2, h: door.width };
}

function hits(solids: Solid[], x: number, y: number): boolean {
  for (const solid of solids) {
    if (pointToSolidDistanceSquared({ x, y }, solid) === 0) return true;
  }
  return false;
}

/** Whichever kind dominates the room's anchor furniture names the room. */
function classify(objects: MapObject[], area: number, largest: number): RoomKind {
  if (area >= largest * 0.9) return "warehouse";

  const score: Record<RoomKind, number> = {
    warehouse: 0, shop: 0, office: 0, plant: 0, store: 0, circulation: 0,
  };
  for (const o of objects) {
    switch (o.kind) {
      case "workbench":
      case "toolCabinet":
        score.shop += 3;
        break;
      case "locker":
        score.shop += 1;
        break;
      case "desk":
      case "filingCabinet":
      case "chair":
      case "plant":
        score.office += 3;
        break;
      case "generator":
      case "utilityBox":
      case "hvac":
        score.plant += 3;
        break;
      case "shelf":
      case "crateStack":
      case "pallet":
      case "drum":
        score.store += 2;
        break;
      default:
        break;
    }
  }
  const best = (Object.entries(score) as Array<[RoomKind, number]>)
    .sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] === 0) return "circulation";
  return best[0];
}

export function findRooms(footprint: Rect, floor: FloorPlan): Room[] {
  /**
   * Every boundary a room can have: rect walls, path walls compiled to capsules,
   * and the doorway closures. A floor authored in map source has no rect walls at
   * all, so omitting barriers here finds exactly one room and no finishes.
   */
  const barriers: Solid[] = [
    ...floor.walls.map((w: WallSegment) => rectSolid({ x: w.x, y: w.y, w: w.w, h: w.h })),
    ...(floor.barriers ?? []).flatMap((barrier) => barrier.solids),
    ...floor.doorways.map((door) => rectSolid(doorBarrier(door))),
  ];

  const cols = Math.floor(footprint.w / CELL);
  const rowCount = Math.floor(footprint.h / CELL);
  const open = new Uint8Array(cols * rowCount);
  for (let cy = 0; cy < rowCount; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const wx = footprint.x + cx * CELL + CELL / 2;
      const wy = footprint.y + cy * CELL + CELL / 2;
      open[cy * cols + cx] = hits(barriers, wx, wy) ? 0 : 1;
    }
  }

  const label = new Int32Array(cols * rowCount).fill(-1);
  const regions: Array<{ cells: number }> = [];
  const stack: number[] = [];

  for (let start = 0; start < open.length; start += 1) {
    if (!open[start] || label[start] !== -1) continue;
    const id = regions.length;
    regions.push({ cells: 0 });
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const at = stack.pop()!;
      regions[id].cells += 1;
      const cx = at % cols;
      const cy = (at - cx) / cols;
      const neighbours = [
        cx > 0 ? at - 1 : -1,
        cx < cols - 1 ? at + 1 : -1,
        cy > 0 ? at - cols : -1,
        cy < rowCount - 1 ? at + cols : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || !open[n] || label[n] !== -1) continue;
        label[n] = id;
        stack.push(n);
      }
    }
  }

  // Merge each region's cells into horizontal runs, and take its bounds.
  const runs: Rect[][] = regions.map(() => []);
  const bounds = regions.map(() => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
  for (let cy = 0; cy < rowCount; cy += 1) {
    let cx = 0;
    while (cx < cols) {
      const id = label[cy * cols + cx];
      if (id < 0) {
        cx += 1;
        continue;
      }
      let end = cx;
      while (end + 1 < cols && label[cy * cols + end + 1] === id) end += 1;
      const rect: Rect = {
        x: footprint.x + cx * CELL,
        y: footprint.y + cy * CELL,
        w: (end - cx + 1) * CELL,
        h: CELL,
      };
      runs[id].push(rect);
      const b = bounds[id];
      b.x0 = Math.min(b.x0, rect.x);
      b.y0 = Math.min(b.y0, rect.y);
      b.x1 = Math.max(b.x1, rect.x + rect.w);
      b.y1 = Math.max(b.y1, rect.y + rect.h);
      cx = end + 1;
    }
  }

  const areas = regions.map((r) => r.cells * CELL * CELL);
  const largest = Math.max(1, ...areas);

  return regions
    .map((_, id) => {
      const b = bounds[id];
      const box: Rect = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
      const inside = floor.objects.filter((o) => {
        const mx = o.x + o.w / 2;
        const my = o.y + o.h / 2;
        const cx = Math.floor((mx - footprint.x) / CELL);
        const cy = Math.floor((my - footprint.y) / CELL);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rowCount) return false;
        return label[cy * cols + cx] === id;
      });
      return {
        kind: classify(inside, areas[id], largest),
        runs: runs[id],
        bounds: box,
        area: areas[id],
        objects: inside,
      };
    })
    // Slivers between a wall and a fixture are not rooms.
    .filter((room) => room.area > 900);
}
