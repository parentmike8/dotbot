import { Container, Graphics } from "pixi.js";
import { FLAT_KINDS, stairHalves } from "@dotbot/game/mapModel";
import { isDisc, pathOutline, solidBounds } from "@dotbot/game/geometry";
import type { Barrier, Building, Doorway, FloorPlan, MapObject, StairLink, Vec2, WallSegment, WindowBand } from "@dotbot/game/types";
import { drawModelObject } from "./modelGlyphs";
import { findRooms, type Room, type RoomKind } from "./rooms";
import {
  AO_ALPHA,
  contact,
  inlay,
  jitter,
  LIFT,
  MAT,
  contactShape,
  occlude,
  occludeShape,
  seam,
  shade,
  SHADOW_ALPHA,
  V,
  volume,
  volumeShape,
  type Rect,
  type ShadowPad,
} from "./tone";

/**
 * One authored floor, drawn as a lit physical model.
 *
 * Layer order is the physical stack: slab, floor paint, light spilling in from
 * glazing, then every cast shadow in the room, then the extruded walls and the
 * objects standing on the slab. Nothing here is decoration — the floor paint,
 * the dock apron and the pick-aisle lanes are all derived from the authored
 * geometry, so a new floor gets them for free and no one is tempted to scatter
 * marks to balance a composition.
 */

/**
 * Mirrors the line-plan renderer's per-floor layer contract so either language
 * can back the same `FloorArt`.
 */
export type FloorModel = {
  view: Container;
  /** Slab, wear, paint, light, structure and their shadows. */
  architecture: Container;
  /** Object art plus the shadows those objects cast. */
  furniture: Container;
  /** The object art alone, inside `furniture`. */
  objects: Container;
  objectViews: Map<string, { object: MapObject; view: Graphics }>;
  stairs: Container;
  stairViews: Map<string, { stair: StairLink; view: Container }>;
  annotation: Container;
  annotationGfx: Graphics;
};

const WALL_MAT = { top: V.wallCap, front: V.wall, edge: 0x0b0e11, lit: 0x4d5359 };
const PART_MAT = { top: V.partitionCap, front: shade(V.wall, 1.35), edge: 0x14171a, lit: 0x585e64 };

// ---------------------------------------------------------------------------
// Slab
// ---------------------------------------------------------------------------

/**
 * Poured slab with saw-cut control joints on a 120-unit pour grid.
 *
 * Clipped to the building's real outline when it has one. Filling the bounding box
 * instead paves the notch of an L-plan, which reads as floor a player can stand on
 * and cannot.
 */
function drawSlab(g: Graphics, fp: Rect, outline?: Vec2[]): void {
  if (outline && outline.length >= 3) {
    g.poly(outline.map((point) => ({ x: point.x, y: point.y }))).fill({ color: V.slab });
  } else {
    g.rect(fp.x, fp.y, fp.w, fp.h).fill({ color: V.slab });
  }

  const pour = 120;
  for (let x = fp.x + pour; x < fp.x + fp.w; x += pour) {
    g.rect(x - 0.7, fp.y, 1.4, fp.h).fill({ color: V.joint });
    g.rect(x - 0.7, fp.y, 0.6, fp.h).fill({ color: shade(V.slab, 1.05) });
  }
  for (let y = fp.y + pour; y < fp.y + fp.h; y += pour) {
    g.rect(fp.x, y - 0.7, fp.w, 1.4).fill({ color: V.joint });
    g.rect(fp.x, y - 0.7, fp.w, 0.6).fill({ color: shade(V.slab, 1.05) });
  }
}

const ROOM_FINISH: Record<RoomKind, number | null> = {
  warehouse: null,
  circulation: null,
  shop: V.shopFloor,
  office: V.sealed,
  plant: V.plantFloor,
  store: V.scuff,
};

/**
 * Each discovered room gets its own finish. This is the cheapest richness in
 * the whole language: a dispatch office with a sealed floor and a workshop with
 * a painted one stop reading as "the same warehouse with walls in it", and none
 * of it is authored — delete the partition and the finish merges away.
 */
function drawRoomFinishes(g: Graphics, rooms: Room[]): void {
  for (const room of rooms) {
    const finish = ROOM_FINISH[room.kind];
    if (finish === null) continue;
    for (const run of room.runs) {
      // Overdrawn by half a cell so adjacent runs leave no seam.
      g.rect(run.x, run.y, run.w, run.h + 0.6).fill({ color: finish });
    }

    if (room.kind === "office") {
      // Modular tile grid, aligned to the room rather than the pour grid.
      const tile = 48;
      for (let x = room.bounds.x + tile; x < room.bounds.x + room.bounds.w; x += tile) {
        g.rect(x, room.bounds.y, 0.8, room.bounds.h).fill({ color: shade(finish, 0.95) });
      }
      for (let y = room.bounds.y + tile; y < room.bounds.y + room.bounds.h; y += tile) {
        g.rect(room.bounds.x, y, room.bounds.w, 0.8).fill({ color: shade(finish, 0.95) });
      }
    }

    if (room.kind === "shop" || room.kind === "plant") {
      // Painted equipment outlines: the floor marking that says "this machine
      // lives here", derived from the machines that actually do.
      for (const o of room.objects) {
        if (o.w < 24 && o.h < 24) continue;
        g.rect(o.x - 6, o.y - 6, o.w + 12, o.h + 12).stroke({ color: V.paintWorn, width: 2.2 });
      }
    }
  }
}

/**
 * High-bay lighting, on the regular grid a building this size would actually be
 * lit by. Pools of light are what give the slab a value range and stop a big
 * floor reading as an empty field — and because the grid is a real building
 * system, the marks survive the contract's "no decoration" rule.
 */
function drawHighBays(g: Graphics, rooms: Room[], fp: Rect): void {
  /**
   * Stacked discs approximate a radial falloff. The per-step alpha has to be
   * normalised against the number of steps or the pool composites past 1.0 and
   * blows the slab back to paper white — which is exactly how the first attempt
   * undid the darker slab it was meant to complement.
   */
  const STEPS = 16;
  let weight = 0;
  for (let i = 1; i <= STEPS; i += 1) weight += 1 - i / (STEPS + 1);

  const pool = (cx: number, cy: number, radius: number, peak: number): void => {
    for (let i = STEPS; i >= 1; i -= 1) {
      const t = i / (STEPS + 1);
      g.circle(cx, cy, radius * t).fill({ color: 0xffffff, alpha: (peak * (1 - t)) / weight });
    }
  };

  for (const room of rooms) {
    const big = room.kind === "warehouse" || room.kind === "circulation";
    const pitch = big ? 152 : 96;
    // Radius must stay near half the pitch. Wider than that and neighbouring
    // pools merge into an even smear that reads as glare, not as fixtures — and
    // the peak has to stay low, or the pools become smudges on the slab and
    // undo the mid-tone the floor needs.
    const radius = pitch * 0.5;
    const strength = big ? 0.085 : 0.07;

    // Centre the grid in the room so fixtures look laid out, not sprayed.
    const cols = Math.max(1, Math.round(room.bounds.w / pitch));
    const rowsN = Math.max(1, Math.round(room.bounds.h / pitch));
    for (let ix = 0; ix < cols; ix += 1) {
      for (let iy = 0; iy < rowsN; iy += 1) {
        const cx = room.bounds.x + (room.bounds.w / cols) * (ix + 0.5);
        const cy = room.bounds.y + (room.bounds.h / rowsN) * (iy + 0.5);
        if (cx < fp.x || cx > fp.x + fp.w || cy < fp.y || cy > fp.y + fp.h) continue;
        pool(cx, cy, radius, strength);
      }
    }
  }
}

/**
 * Traffic wear, derived from where traffic actually goes.
 *
 * This is operational information, not texture: the polished lanes show a
 * player the routes the building is built around, and the skids cluster where
 * vehicles turn. Nothing here is placed to balance a composition — remove the
 * dock or the racking and the marks that served them disappear with them.
 */
function drawWear(g: Graphics, floor: FloorPlan, fp: Rect): void {
  const racks = floor.objects.filter((o) => o.kind === "shelf" && o.h > o.w * 3).sort((a, b) => a.x - b.x);
  const vehicleDoors = floor.doorways.filter((d) => d.open && d.width >= 96);

  /**
   * Wear is soft-edged and cumulative. A hard-edged bright rectangle reads as
   * geometry — the first pass turned every aisle into a white slab — so lanes
   * are laid down as a few overlapping translucent bands that fade at the sides.
   */
  /**
   * `peak` is the *total* lightening at the lane centre, not the per-step alpha.
   * Three stacked bands at 0.26 each composite to about 0.6, which is how the
   * first pass turned every aisle into a white slab and flattened the mid-tone
   * the whole language depends on.
   */
  const STEPS = 3;
  const polish = (lane: Rect, vertical: boolean, peak: number): void => {
    const perStep = 1 - (1 - peak) ** (1 / STEPS);
    for (let i = 0; i < STEPS; i += 1) {
      const k = i / (STEPS - 1);
      const shrink = k * (vertical ? lane.w : lane.h) * 0.3;
      g.roundRect(
        lane.x + (vertical ? shrink : 0),
        lane.y + (vertical ? 0 : shrink),
        lane.w - (vertical ? shrink * 2 : 0),
        lane.h - (vertical ? 0 : shrink * 2),
        6,
      ).fill({ color: V.polish, alpha: perStep });
    }
  };

  const skids = (lane: Rect, seedId: string, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const a = jitter(seedId, i);
      const b = jitter(seedId, i + 50);
      g.roundRect(
        lane.x + 4 + a * Math.max(1, lane.w - 10),
        lane.y + 4 + b * Math.max(1, lane.h - 22),
        1.2 + a * 1.6,
        8 + b * 14,
        1,
      ).fill({ color: V.skid, alpha: 0.1 });
    }
  };

  // Cross-dock spine linking the vehicle doors.
  if (vehicleDoors.length >= 2) {
    const y0 = Math.min(...vehicleDoors.map((d) => d.y));
    const north = y0 - fp.y < fp.h / 2;
    const lane: Rect = { x: fp.x + 18, y: north ? y0 + 16 : y0 - 76, w: fp.w - 36, h: 60 };
    polish(lane, false, 0.16);
    for (const door of vehicleDoors) {
      skids({ x: door.x - door.width * 0.4, y: lane.y, w: door.width * 0.8, h: lane.h }, door.id, 5);
    }
  }

  // Pick aisles.
  for (let i = 0; i < racks.length - 1; i += 1) {
    const a = racks[i];
    const b = racks[i + 1];
    if (b.x - (a.x + a.w) < 60) continue;
    const lane: Rect = {
      x: a.x + a.w + 10,
      y: Math.max(a.y, b.y) - 24,
      w: b.x - (a.x + a.w) - 20,
      h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + 48,
    };
    polish(lane, true, 0.13);
    skids(lane, a.id, 4);
  }
}

/**
 * Diagonal hazard hatching, clipped to a rect. Returned as a masked container
 * so the stripes can run at a true 45 degrees without per-stripe clipping math.
 */
function hazardBand(r: Rect, light: number, dark: number, pitch = 11): Container {
  const holder = new Container();
  const stripes = new Graphics();
  stripes.rect(r.x, r.y, r.w, r.h).fill({ color: light });
  const reach = r.w + r.h;
  for (let i = -r.h; i < reach; i += pitch * 2) {
    stripes
      .poly([
        r.x + i, r.y,
        r.x + i + pitch, r.y,
        r.x + i + pitch - r.h, r.y + r.h,
        r.x + i - r.h, r.y + r.h,
      ])
      .fill({ color: dark });
  }
  const mask = new Graphics();
  mask.rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff });
  stripes.mask = mask;
  holder.addChild(mask, stripes);
  return holder;
}

/** True if a rect lies inside the footprint's interior, not in its wall band. */
function interiorSide(fp: Rect, doorway: Doorway): "N" | "S" | "E" | "W" {
  if (doorway.dir === "h") return doorway.y - fp.y < fp.h / 2 ? "N" : "S";
  return doorway.x - fp.x < fp.w / 2 ? "W" : "E";
}

/**
 * Floor paint, all of it derived.
 *
 * - Every vehicle door gets a keep-clear apron inside it.
 * - Vehicle doors on a shared wall get a hazard-striped dock strip between them.
 * - Every gap between parallel racking runs gets a pick-aisle lane pair.
 * - Person doors get a worn threshold.
 */
function drawFloorPaint(layer: Container, g: Graphics, floor: FloorPlan, fp: Rect): void {
  const vehicleDoors = floor.doorways.filter((d) => d.open && d.width >= 96);

  // Dock strip: the band inside the wall that the vehicle doors share.
  if (vehicleDoors.length >= 2 && vehicleDoors.every((d) => d.dir === "h")) {
    const y0 = Math.min(...vehicleDoors.map((d) => d.y));
    const north = y0 - fp.y < fp.h / 2;
    const depth = 86;
    const xs = vehicleDoors.map((d) => d.x);
    const strip: Rect = {
      x: Math.min(...xs) - vehicleDoors[0].width / 2 - 26,
      y: north ? y0 + 6 : y0 - depth - 6,
      w: Math.max(...xs) - Math.min(...xs) + vehicleDoors[0].width + 52,
      h: depth,
    };
    // A single worn traffic pad, edged in paint. The apron a dock actually has.
    inlay(g, strip, V.scuff);
    for (const edge of [
      { x: strip.x, y: strip.y, w: strip.w, h: 2 },
      { x: strip.x, y: strip.y + strip.h - 2, w: strip.w, h: 2 },
      { x: strip.x, y: strip.y, w: 2, h: strip.h },
      { x: strip.x + strip.w - 2, y: strip.y, w: 2, h: strip.h },
    ]) inlay(g, edge, V.paint);
  }

  for (const door of floor.doorways) {
    const side = interiorSide(fp, door);
    const horizontal = door.dir === "h";
    if (door.open && door.width >= 96) {
      // Keep-clear apron: hazard hatching directly inside a vehicle door.
      const depth = 30;
      const band: Rect = horizontal
        ? {
            x: door.x - door.width / 2,
            y: side === "N" ? door.y + 8 : door.y - depth - 8,
            w: door.width,
            h: depth,
          }
        : {
            x: side === "W" ? door.x + 8 : door.x - depth - 8,
            y: door.y - door.width / 2,
            w: depth,
            h: door.width,
          };
      layer.addChild(hazardBand(band, V.scuff, V.paintWorn, 9));
      continue;
    }
    // Person doors and interior openings: a worn threshold patch.
    const depth = 16;
    const band: Rect = horizontal
      ? { x: door.x - door.width / 2, y: door.y - depth / 2, w: door.width, h: depth }
      : { x: door.x - depth / 2, y: door.y - door.width / 2, w: depth, h: door.width };
    inlay(g, band, V.scuff);
  }

  // Pick aisles: the gap between each pair of parallel racking runs.
  const racks = floor.objects
    .filter((o) => o.kind === "shelf" && o.h > o.w * 3)
    .sort((a, b) => a.x - b.x);
  for (let i = 0; i < racks.length - 1; i += 1) {
    const a = racks[i];
    const b = racks[i + 1];
    const gap = b.x - (a.x + a.w);
    if (gap < 60) continue;
    const top = Math.max(a.y, b.y);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    if (bottom - top < 40) continue;
    /**
     * Continuous lane edges. The first pass broke them into random worn
     * segments and the aisles filled with white specks that read as noise — a
     * painted line only reads as intentional if it is actually a line.
     */
    for (const x of [a.x + a.w + 7, b.x - 10]) {
      inlay(g, { x, y: top - 10, w: 3, h: bottom - top + 20 }, V.paint);
      inlay(g, { x, y: top - 10, w: 3, h: 3 }, V.paintWorn);
      inlay(g, { x, y: bottom + 7, w: 3, h: 3 }, V.paintWorn);
    }
    // Bay ticks: one short mark per rack bay, so the lane carries the rack's
    // own rhythm instead of an invented label.
    const bays = Math.max(2, Math.round(a.h / 44));
    for (let k = 1; k < bays; k += 1) {
      const y = a.y + (a.h / bays) * k;
      inlay(g, { x: a.x + a.w + 10, y: y - 1.5, w: 9, h: 3 }, V.paintWorn);
      inlay(g, { x: b.x - 19, y: y - 1.5, w: 9, h: 3 }, V.paintWorn);
    }
  }
}

// ---------------------------------------------------------------------------
// Glazing
// ---------------------------------------------------------------------------

/**
 * Bounding box of an opening's centreline, widened across the wall.
 *
 * An angled band still draws as an axis-aligned patch for now; it lands in the
 * right place and reads correctly, and a truly rotated glazing pass is a later
 * refinement rather than a correctness problem.
 */
function spanRect(span: NonNullable<WindowBand["span"]>, thickness: number): Rect {
  const minX = Math.min(span.ax, span.bx);
  const minY = Math.min(span.ay, span.by);
  const w = Math.abs(span.bx - span.ax);
  const h = Math.abs(span.by - span.ay);
  const across = w >= h;
  return across
    ? { x: minX, y: minY + h / 2 - thickness / 2, w: Math.max(w, 2), h: thickness }
    : { x: minX + w / 2 - thickness / 2, y: minY, w: thickness, h: Math.max(h, 2) };
}

function windowRect(band: WindowBand, walls: WallSegment[]): Rect | null {
  const wall = walls.find((w) =>
    band.dir === "h"
      ? band.y >= w.y && band.y <= w.y + w.h && band.x >= w.x && band.x <= w.x + w.w
      : band.x >= w.x && band.x <= w.x + w.w && band.y >= w.y && band.y <= w.y + w.h,
  );
  if (!wall) return null;
  return band.dir === "h"
    ? { x: band.x - band.length / 2, y: wall.y, w: band.length, h: wall.h }
    : { x: wall.x, y: band.y - band.length / 2, w: wall.w, h: band.length };
}

/** Daylight reaching the slab through a window. Three steps, no filters. */
function drawLightSpill(g: Graphics, band: WindowBand, walls: WallSegment[], fp: Rect): void {
  const r = band.span ? spanRect(band.span, 14) : windowRect(band, walls);
  if (!r) return;
  const inward = band.dir === "h"
    ? (band.y - fp.y < fp.h / 2 ? 1 : -1)
    : (band.x - fp.x < fp.w / 2 ? 1 : -1);

  /**
   * Six soft steps rather than three hard ones. Three rectangles at 0.5, 0.3
   * and 0.16 read as blown-out white boxes stuck to the wall; a longer ramp with
   * rounded ends and a much lower peak reads as daylight falling on a slab.
   */
  const STEPS = 6;
  const reach = 76;
  const peak = 0.3;
  const perStep = 1 - (1 - peak) ** (1 / STEPS);
  for (let i = STEPS; i >= 1; i -= 1) {
    const t = i / STEPS;
    const depth = reach * t;
    const spread = 14 * t;
    const patch: Rect = band.dir === "h"
      ? {
          x: r.x - spread,
          y: inward > 0 ? r.y + r.h : r.y - depth,
          w: r.w + spread * 2,
          h: depth,
        }
      : {
          x: inward > 0 ? r.x + r.w : r.x - depth,
          y: r.y - spread,
          w: depth,
          h: r.h + spread * 2,
        };
    g.roundRect(patch.x, patch.y, patch.w, patch.h, 10 * t)
      .fill({ color: 0xffffff, alpha: perStep });
  }
}

function drawWindow(g: Graphics, band: WindowBand, walls: WallSegment[], thickness = 14): void {
  // A span-based band comes from a path wall and carries its own geometry; the
  // rect lookup only works for axis-aligned runs.
  const r = band.span ? spanRect(band.span, thickness) : windowRect(band, walls);
  if (!r) return;
  // Glazing sits in the wall thickness, with a lit interior sill.
  inlay(g, r, V.glassFrame);
  const glass = band.dir === "h"
    ? { x: r.x + 1.5, y: r.y + 1.5, w: r.w - 3, h: r.h - 3 }
    : { x: r.x + 1.5, y: r.y + 1.5, w: r.w - 3, h: r.h - 3 };
  inlay(g, glass, V.glass);
  // Mullions.
  const span = band.dir === "h" ? glass.w : glass.h;
  const lights = Math.max(2, Math.round(span / 18));
  for (let i = 1; i < lights; i += 1) {
    const at = (span / lights) * i;
    if (band.dir === "h") inlay(g, { x: glass.x + at, y: glass.y, w: 1.2, h: glass.h }, V.glassFrame);
    else inlay(g, { x: glass.x, y: glass.y + at, w: glass.w, h: 1.2 }, V.glassFrame);
  }
  // Sill highlight on the lit side.
  if (band.dir === "h") inlay(g, { x: glass.x, y: glass.y, w: glass.w, h: 0.9 }, 0xffffff);
  else inlay(g, { x: glass.x, y: glass.y, w: 0.9, h: glass.h }, 0xffffff);
}

// ---------------------------------------------------------------------------
// Walls and openings
// ---------------------------------------------------------------------------

/**
 * Walls use the same volume convention as furniture: a lit cap with a shaded
 * south face. That single decision is what makes the room read as an extruded
 * model instead of a plan, because the eye gets one consistent light for every
 * solid in the frame.
 */
function drawWalls(g: Graphics, pad: ShadowPad, floor: FloorPlan, fp: Rect): void {
  for (const wall of floor.walls) {
    const shell = wall.w >= 11 || wall.h >= 11;
    const lift = Math.min(LIFT.wall, Math.max(3, (shell ? 10 : 7)));
    contact(pad, wall, lift);
    volume(g, wall, shell ? WALL_MAT : PART_MAT, lift);
  }
  for (const barrier of floor.barriers ?? []) drawBarrier(g, pad, barrier);
  void fp;
}

/**
 * Group a barrier's capsules back into the contiguous runs they were cut into.
 *
 * A wall stays one named entity in the data — which is what an editor selects and
 * what an author edits — so the renderer recovers the run boundaries by following
 * the chain: consecutive capsules that share an endpoint belong to one stretch, and
 * a break is where a doorway was cut.
 */
export function capsuleRuns(barrier: Barrier): Array<{ points: Vec2[]; thickness: number }> {
  const runs: Array<{ points: Vec2[]; thickness: number }> = [];
  for (const solid of barrier.solids) {
    if (solid.kind !== "capsule" || isDisc(solid)) continue;
    const current = runs.at(-1);
    const tail = current?.points.at(-1);
    const continues = tail
      && Math.abs(tail.x - solid.ax) < 0.01
      && Math.abs(tail.y - solid.ay) < 0.01
      && current!.thickness === solid.r * 2;
    if (continues) current!.points.push({ x: solid.bx, y: solid.by });
    else {
      runs.push({
        points: [{ x: solid.ax, y: solid.ay }, { x: solid.bx, y: solid.by }],
        thickness: solid.r * 2,
      });
    }
  }

  /**
   * Close the loop.
   *
   * Following the chain forwards can never reach the join a closed shell makes at
   * the point its outline was authored from: the two halves of that one corner
   * land in the first and last runs, get mitered independently, and leave a
   * visible step where they fail to meet. Every other corner is interior to the
   * chain and comes out clean, which is why the defect appears at exactly one
   * corner per building — Mercy Clinic's outline starts at `200,140`, so it showed
   * up at the clinic's north-west corner and nowhere else.
   */
  const first = runs[0];
  const last = runs.at(-1);
  if (runs.length > 1 && first && last && first.thickness === last.thickness) {
    const head = first.points[0];
    const tail = last.points.at(-1)!;
    if (Math.abs(head.x - tail.x) < 0.01 && Math.abs(head.y - tail.y) < 0.01) {
      last.points.push(...first.points.slice(1));
      runs.shift();
    }
  }

  return runs;
}

/** A wall at any angle, extruded and shaded by face normal like everything else. */
function drawBarrier(g: Graphics, pad: ShadowPad, barrier: Barrier): void {
  for (const run of capsuleRuns(barrier)) {
    const outline = pathOutline(run.points, run.thickness);
    if (outline.length < 3) continue;
    const shell = run.thickness >= 11;
    const lift = shell ? 10 : 7;
    contactShape(pad, outline, lift);
    volumeShape(g, outline, shell ? WALL_MAT : PART_MAT, lift);
  }

  /**
   * A pier: the stub of wall left between an opening and the wall's end, too
   * short to have a spine. It is still a piece of wall and still collides, so it
   * draws as one rather than being quietly left off the plan.
   */
  for (const solid of barrier.solids) {
    if (solid.kind !== "capsule" || !isDisc(solid)) continue;
    const shell = solid.r * 2 >= 11;
    const { x, y, w, h } = solidBounds(solid);
    contact(pad, { x, y, w, h }, shell ? 10 : 7);
    volume(g, { x, y, w, h }, shell ? WALL_MAT : PART_MAT, shell ? 10 : 7);
  }

  // Convex hulls — a ship, a wedge — draw as themselves.
  for (const solid of barrier.solids) {
    if (solid.kind !== "poly") continue;
    contactShape(pad, solid.points, LIFT.wall);
    volumeShape(g, solid.points, WALL_MAT, LIFT.wall);
  }
}

function bandFromWall(door: Doorway, walls: WallSegment[]): Rect | null {
  const wall = walls.find((w) =>
    door.dir === "h"
      ? door.y >= w.y - 3 && door.y <= w.y + w.h + 3
      : door.x >= w.x - 3 && door.x <= w.x + w.w + 3,
  );
  if (!wall) return null;
  return door.dir === "h"
    ? { x: door.x - door.width / 2, y: wall.y, w: door.width, h: wall.h }
    : { x: wall.x, y: door.y - door.width / 2, w: wall.w, h: door.width };
}

/**
 * Roll-up door: the retracted curtain sitting in the wall thickness, with a
 * guide rail at each jamb. The opening itself stays completely open — nothing
 * here implies collision the data does not declare.
 */
function drawVehicleDoorHead(g: Graphics, pad: ShadowPad, door: Doorway, walls: WallSegment[]): void {
  // The curtain occupies exactly the wall band, never more. A source-authored
  // door states its own reveal depth; a rect-authored one has to find the run it
  // was cut from, because the wall is the only thing that knows how deep it is.
  const r = door.thickness !== undefined
    ? spanRect(door.span ?? {
      ax: door.dir === "h" ? door.x - door.width / 2 : door.x,
      ay: door.dir === "h" ? door.y : door.y - door.width / 2,
      bx: door.dir === "h" ? door.x + door.width / 2 : door.x,
      by: door.dir === "h" ? door.y : door.y + door.width / 2,
    }, door.thickness)
    : bandFromWall(door, walls);
  if (!r) return;

  contact(pad, r, 5);
  volume(g, r, MAT.steelDark, 5);

  // Curtain slats run across the opening.
  const span = door.dir === "h" ? r.w : r.h;
  const slats = Math.max(3, Math.floor(span / 9));
  for (let i = 1; i < slats; i += 1) {
    const at = (span / slats) * i;
    if (door.dir === "h") seam(g, r.x + at, r.y, r.x + at, r.y + r.h - 5, MAT.steelDeep.top, 0.8);
    else seam(g, r.x, r.y + at, r.x + r.w - 5, r.y + at, MAT.steelDeep.top, 0.8);
  }

  // Guide rails, inside the jambs so the traversable gap is unchanged.
  for (const end of [0, 1]) {
    const rail: Rect = door.dir === "h"
      ? { x: end ? r.x + r.w - 3.5 : r.x, y: r.y, w: 3.5, h: r.h }
      : { x: r.x, y: end ? r.y + r.h - 3.5 : r.y, w: r.w, h: 3.5 };
    volume(g, rail, MAT.steelDeep, 6);
  }
}

// ---------------------------------------------------------------------------
// Stairs
// ---------------------------------------------------------------------------

/**
 * A descending flight. Treads darken as they drop, which is the whole reason
 * the language works for a vertical world: depth is a value change, not a
 * change of projection, so a stair down looks like a stair down from directly
 * above and never needs a camera trick.
 */
function drawStair(g: Graphics, pad: ShadowPad, stair: StairLink): void {
  const { entry, exit, vertical } = stairHalves(stair);
  const r = stair.rect;

  // The shaft opening: a hole in the slab, dark at the bottom.
  contact(pad, r, LIFT.wall);
  inlay(g, r, 0x23272b);

  const down = stair.direction === "down";
  const runs: Array<{ half: Rect; from: number; to: number }> = down
    ? [{ half: entry, from: 0.02, to: 0.55 }, { half: exit, from: 0.55, to: 0.98 }]
    : [{ half: exit, from: 0.98, to: 0.55 }, { half: entry, from: 0.55, to: 0.02 }];

  for (const run of runs) {
    const span = vertical ? run.half.h : run.half.w;
    const treads = Math.max(4, Math.round(span / 16));
    for (let i = 0; i < treads; i += 1) {
      const t = i / treads;
      const depth = run.from + (run.to - run.from) * t;
      const tread: Rect = vertical
        ? { x: run.half.x, y: run.half.y + (span / treads) * i, w: run.half.w, h: span / treads }
        : { x: run.half.x + (span / treads) * i, y: run.half.y, w: span / treads, h: run.half.h };
      // Tread nose lit, riser in shadow, both darkening with depth.
      const k = 1 - depth * 0.72;
      inlay(g, tread, shade(MAT.steel.top, k));
      inlay(
        g,
        vertical
          ? { x: tread.x, y: tread.y + tread.h - 1.6, w: tread.w, h: 1.6 }
          : { x: tread.x + tread.w - 1.6, y: tread.y, w: 1.6, h: tread.h },
        shade(MAT.steel.edge, k),
      );
      inlay(
        g,
        vertical ? { x: tread.x, y: tread.y, w: tread.w, h: 0.8 } : { x: tread.x, y: tread.y, w: 0.8, h: tread.h },
        shade(MAT.steel.lit, k),
      );
    }
  }

  // Stringers down both flanks.
  for (const end of [0, 1]) {
    const side: Rect = vertical
      ? { x: r.x + (end ? r.w - 3 : 0), y: r.y, w: 3, h: r.h }
      : { x: r.x, y: r.y + (end ? r.h - 3 : 0), w: r.w, h: 3 };
    volume(g, side, MAT.steelDeep, 5);
  }
}

/**
 * The same stair, seen from the roof above it.
 *
 * From up here you cannot see the flight — it is inside a housing, and what shows
 * is a small box with a door in one side. Drawing the open treads on a roof is
 * what put "stairs visible through the roof" on this map: the flight was right
 * for every floor below and simply wrong for the one on top, because a roof is
 * the only floor that looks *down* onto a stair from outside it.
 */
export function drawStairHead(g: Graphics, pad: ShadowPad, stair: StairLink): void {
  const r = stair.rect;
  const { entry, vertical } = stairHalves(stair);

  contact(pad, r, LIFT.column);
  /**
   * Built of the same stuff as the parapet, not of interior wall.
   *
   * A housing drawn in `V.wallCap` is nearly black against the roof membrane, so
   * it reads as a hole punched in the deck — the very thing this replaced. It is
   * a small structure standing *on* a roof in full daylight, so it is the
   * lightest thing up there.
   */
  const top = volume(g, r, MAT.steelLit, LIFT.column);
  inlay(g, { x: top.x + 2.6, y: top.y + 2.6, w: top.w - 5.2, h: top.h - 5.2 }, shade(MAT.steelLit.top, 0.95));

  // The door, on whichever face the flight is entered from.
  const span = (vertical ? r.w : r.h) * 0.46;
  const thick = 5;
  const atLowSide = vertical ? entry.y <= r.y + 0.5 : entry.x <= r.x + 0.5;
  inlay(g, vertical
    ? { x: r.x + (r.w - span) / 2, y: atLowSide ? r.y : r.y + r.h - thick, w: span, h: thick }
    : { x: atLowSide ? r.x : r.x + r.w - thick, y: r.y + (r.h - span) / 2, w: thick, h: span },
    shade(MAT.steelLit.top, 0.38));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function makePad(alphas: readonly number[]): ShadowPad {
  return alphas.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
}

/**
 * Build one floor in the lit-model language, filling the same layer contract the
 * line-plan renderer exposes: an `architecture` group Map Studio can hide, a
 * `furniture` group it can hide independently, and addressable per-object views
 * for the fabrication draw-on hook.
 *
 * Object shadows live *inside* `furniture`, below the object art, so hiding
 * furniture in Map Studio takes its shadows with it. Structure shadows stay in
 * `architecture` for the same reason.
 */
export function buildFloorModel(building: Building, floor: FloorPlan): FloorModel {
  const fp = building.footprint;
  const view = new Container();
  const architecture = new Container();
  const furniture = new Container();
  const objects = new Container();
  const stairs = new Container();
  const annotation = new Container();
  const annotationGfx = new Graphics();
  const objectViews = new Map<string, { object: MapObject; view: Graphics }>();
  const stairViews = new Map<string, { stair: StairLink; view: Container }>();

  const slab = new Graphics();
  const finishes = new Graphics();
  const wear = new Graphics();
  const bays = new Graphics();
  const paintLayer = new Container();
  const paint = new Graphics();
  const light = new Graphics();
  const structure = new Graphics();
  const glazing = new Graphics();

  const structurePad = makePad(SHADOW_ALPHA);
  const structureAo = makePad(AO_ALPHA);
  const objectPad = makePad(SHADOW_ALPHA);
  const objectAo = makePad(AO_ALPHA);

  const rooms = findRooms(fp, floor);
  drawSlab(slab, fp, building.outline);
  /**
   * Clip the ground stack to the building's real outline. The pour grid, room
   * finishes and wear are all laid out across the bounding box, so without this an
   * L-plan's notch gets paved with floor a player can see and never stand on.
   */
  let slabClip: Graphics | null = null;
  if (building.outline && building.outline.length >= 3) {
    slabClip = new Graphics();
    slabClip.poly(building.outline.map((point) => ({ x: point.x, y: point.y }))).fill({ color: 0xffffff });
  }
  drawRoomFinishes(finishes, rooms);
  drawWear(wear, floor, fp);
  drawHighBays(bays, rooms, fp);
  drawFloorPaint(paintLayer, paint, floor, fp);
  paintLayer.addChildAt(paint, 0);

  for (const band of floor.windows ?? []) drawLightSpill(light, band, floor.walls, fp);

  // Ambient occlusion hugging every solid. Without it a room reads as shapes
  // cut out of paper; with it the slab looks like it meets something.
  for (const wall of floor.walls) occlude(structureAo, wall, 11);
  for (const barrier of floor.barriers ?? []) {
    for (const run of capsuleRuns(barrier)) occludeShape(structureAo, pathOutline(run.points, run.thickness), 11);
  }
  for (const object of floor.objects) occlude(objectAo, object, 7);

  drawWalls(structure, structurePad, floor, fp);
  for (const door of floor.doorways) {
    // An archway is a hole in a wall: no curtain, no rails. Where the opening
    // does not say what it is, a wide open one is a roll-up by convention.
    const rollup = door.opening ? door.opening === "rollup" : door.open && door.width >= 96;
    if (rollup) drawVehicleDoorHead(structure, structurePad, door, floor.walls);
  }
  for (const band of floor.windows ?? []) drawWindow(glazing, band, floor.walls);

  for (const stair of floor.stairs) {
    const stairView = new Container();
    const g = new Graphics();
    if (floor.label === "ROOF") drawStairHead(g, structurePad, stair);
    else drawStair(g, structurePad, stair);
    stairView.addChild(g);
    stairs.addChild(stairView);
    stairViews.set(stair.id, { stair, view: stairView });
  }

  /**
   * Floor coverings first, then everything standing on the slab south-first so a
   * nearer object always overlaps the one behind it.
   *
   * The split matters as much as the order. A rug sorts by its own bottom edge,
   * which is *below* the table standing in the middle of it — so in one pass the
   * rug paints over the table and the player meets a solid object they cannot
   * see. Anything genuinely flat belongs under everything, always.
   */
  const byDepth = (a: MapObject, b: MapObject) => a.y + a.h - (b.y + b.h);
  const flat = floor.objects.filter((object) => FLAT_KINDS.has(object.kind)).sort(byDepth);
  const standing = floor.objects.filter((object) => !FLAT_KINDS.has(object.kind)).sort(byDepth);
  for (const object of [...flat, ...standing]) {
    const g = new Graphics();
    drawModelObject(g, objectPad, object);
    objects.addChild(g);
    objectViews.set(object.id, { object, view: g });
  }

  const groundStack = new Container();
  groundStack.addChild(slab, finishes, wear, bays, paintLayer, light);
  if (slabClip) {
    groundStack.addChild(slabClip);
    groundStack.mask = slabClip;
  }
  architecture.addChild(
    groundStack,
    ...structureAo, ...structurePad,
    structure, glazing,
  );
  furniture.addChild(...objectAo, ...objectPad, objects);
  annotation.addChild(annotationGfx);

  view.addChild(architecture, stairs, furniture, annotation);
  return {
    view,
    architecture,
    furniture,
    objects,
    objectViews,
    stairs,
    stairViews,
    annotation,
    annotationGfx,
  };
}

/** Deterministic scatter for objects that should not all sit square. */
export function objectJitter(o: MapObject): number {
  return jitter(o.id);
}
