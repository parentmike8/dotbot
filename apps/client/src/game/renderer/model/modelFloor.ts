import { Container, Graphics } from "pixi.js";
import {
  bandFromWall,
  FLAT_KINDS,
  isSolidObject,
  isVehicleDoor,
  stairHalves,
  SURFACE_KINDS,
} from "@dotbot/game/mapModel";
import { pathOutline } from "@dotbot/game/geometry";
import type { Building, Doorway, FloorPlan, MapObject, StairLink, Vec2, WallSegment, WindowBand } from "@dotbot/game/types";
import { drawModelObject } from "./modelGlyphs";
import { findRooms, type Room, type RoomKind } from "./rooms";
import {
  AO_ALPHA,
  contact,
  inlay,
  jitter,
  LIFT,
  markPassable,
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
  withViewPull,
  type Rect,
  type ShadowPad,
} from "./tone";
import { pullToward } from "./prism";
import { drawStair, drawStairHead } from "./modelStairs";
import { capsuleRuns, drawBarrier, drawWallRects } from "./modelWalls";

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
  const vehicleDoors = floor.doorways.filter(isVehicleDoor);

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
  const vehicleDoors = floor.doorways.filter(isVehicleDoor);

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
    if (isVehicleDoor(door)) {
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
/**
 * An opening's band, from its true centreline.
 *
 * ONE BUG FIXED, ONE I TALKED MYSELF INTO AND WAS WRONG ABOUT, ONE STILL OPEN. Worth all
 * three, because the wrong one is the sort of confident explanation that outlives a fix.
 *
 * FIXED — LENGTH. The old version took the span's bounding box and used its dominant side,
 * which is the span PROJECTED onto an axis. A 92-unit window on a 45-degree arc drew 65 units
 * long, and every opening on a curve was foreshortened by its own angle. It uses
 * `hypot` now, so an opening is its authored width whatever the wall is doing.
 *
 * NOT A BUG — POSITION. I wrote, and briefly believed, that the band was centred on the
 * bounding box rather than the wall and that this was what put a window floating inside the
 * shed. That is arithmetically false: the bounding box of a segment is centred ON that
 * segment's midpoint, so `minX + w / 2` already equalled `(ax + bx) / 2`. The old code placed
 * the centre correctly. Comparing the render before and after is what caught it — the bands
 * did not move, because there was nothing to move.
 *
 * STILL OPEN — ANGLE, and it is the whole of what remains. The band is axis-aligned, so on a
 * curved wall it is a straight bar laid across an arc: it can only touch the wall at one point
 * along its length, which is exactly what reads as "not properly aligned at the walls". Every
 * mark in `drawWindow` and `drawVehicleDoorHead` is a `Rect` — frame, glass, mullions, sill,
 * curtain slats, jamb rails — so turning one means quads, or a rotated container per angled
 * opening the way a turned object gets one. Task #78.
 */
function spanRect(span: NonNullable<WindowBand["span"]>, thickness: number): Rect {
  const { at, length } = spanFrame(span);
  // Always laid along +x. `spanFrame`'s angle turns it onto the wall, so there is no
  // dominant axis to choose any more — the band is built in its own frame and rotated.
  return { x: at.x - length / 2, y: at.y - thickness / 2, w: length, h: thickness };
}

/**
 * An opening's own frame: where its centre is, how long it is, and which way it points.
 *
 * The angle is what makes a band sit ON a curved wall rather than across it. A straight bar
 * laid over an arc touches at one point along its length, which is what read as "windows are
 * not properly aligned at the walls" and as bay doors that ignore their own radial roads.
 */
function spanFrame(span: NonNullable<WindowBand["span"]>): { at: Vec2; angle: number; length: number } {
  return {
    at: { x: (span.ax + span.bx) / 2, y: (span.ay + span.by) / 2 },
    angle: Math.atan2(span.by - span.ay, span.bx - span.ax),
    length: Math.max(Math.hypot(span.bx - span.ax, span.by - span.ay), 2),
  };
}

/**
 * Draw an angled opening into its own Graphics, turned onto the wall it sits in.
 *
 * The same trick a turned object uses, and it works for the same two reasons: the marks are
 * laid out in WORLD coordinates around the span's midpoint, and a Pixi `Graphics` is itself a
 * container — so pivoting at that midpoint and setting a rotation spins the finished drawing in
 * place. `drawWindow` and `drawVehicleDoorHead` need no changes at all; they are handed a band
 * that has already been squared up along +x, and the rotation puts it back on the arc.
 *
 * KNOWN, and the same limitation rotated objects carry: `contact` writes the door head's
 * ground shadow into the shared axis-aligned pad, so that one mark does not turn with the
 * opening. It is a soft wash at lift 5 under a dark curtain. Worth fixing when the pad learns
 * about rotation, not before.
 */
function turnedOpening(span: NonNullable<WindowBand["span"]>, draw: (g: Graphics) => void): Graphics {
  const g = new Graphics();
  draw(g);
  const { at, angle } = spanFrame(span);
  g.pivot.set(at.x, at.y);
  g.position.set(at.x, at.y);
  g.rotation = angle;
  return g;
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
  drawWallRects(g, pad, floor.walls);
  for (const barrier of floor.barriers ?? []) drawBarrier(g, pad, barrier);
  void fp;
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
 * A pad that goes nowhere, for redrawing an object's volume without its shadow.
 *
 * A shadow lies on the floor, and the floor does not move — so when the camera turns and
 * an object's top face slides, its cast shadow and its contact darkening stay exactly
 * where they were. That is not an approximation; it is what a shadow does, and it is why
 * `modelRoof` leaves `blockShadow` outside the sliding mass.
 *
 * But `drawModelObject` draws both at once, into the object's `Graphics` and into the
 * floor's shared pad. Redrawing naively would pile a fresh copy of every shadow onto the
 * pad each time. Splitting the shadow out means splitting fifty glyph functions and 109
 * pad call sites; absorbing it costs one throwaway pad, cleared per object, never added to
 * the stage. The geometry is built and dropped, which is waste — bounded waste, on the
 * only floor being looked at, and measurable.
 *
 * One instance for the whole module: it is written and discarded within a single
 * synchronous call, so there is nothing to keep.
 */
const SCRATCH_PAD: ShadowPad = SHADOW_ALPHA.map(() => new Graphics());

/**
 * Redraw one floor's objects for a new camera position.
 *
 * Only the objects, and only their volumes: the slab, the walls, the shadows and the
 * ambient occlusion are all unaffected by where the camera is. Returns the number of
 * objects rebuilt, so the caller can report the cost rather than guess at it.
 */
export function redrawFloorObjects(
  objectViews: Map<string, { object: MapObject; view: Graphics }>,
  viewCentre: Vec2,
  strength: number,
): number {
  let drawn = 0;
  for (const { object, view } of objectViews.values()) {
    const centre = { x: object.x + object.w / 2, y: object.y + object.h / 2 };
    const pull = pullToward(centre, viewCentre, strength);
    for (const layer of SCRATCH_PAD) layer.clear();
    view.clear();
    withViewPull(pull, () => drawModelObject(view, SCRATCH_PAD, object));
    drawn += 1;
  }
  return drawn;
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
  /**
   * THE FLOOR's extent and plan, falling back to the building's.
   *
   * A floor below ground is not bound by the mass standing on it — the temple's undercroft
   * is a cross of tunnel galleries reaching out well past the pyramid — so paving it to the
   * pyramid's outline drew a slab over a fifth of the level and nothing over the rest.
   */
  const fp = floor.bounds ?? building.footprint;
  const plan = floor.outline ?? building.outline;
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
  drawSlab(slab, fp, plan);
  /**
   * Clip the ground stack to the building's real outline. The pour grid, room
   * finishes and wear are all laid out across the bounding box, so without this an
   * L-plan's notch gets paved with floor a player can see and never stand on.
   */
  let slabClip: Graphics | null = null;
  if (plan && plan.length >= 3) {
    slabClip = new Graphics();
    slabClip.poly(plan.map((point) => ({ x: point.x, y: point.y }))).fill({ color: 0xffffff });
  }
  drawRoomFinishes(finishes, rooms);
  drawWear(wear, floor, fp);
  drawHighBays(bays, rooms, fp);
  drawFloorPaint(paintLayer, paint, floor, fp);
  paintLayer.addChildAt(paint, 0);

  /**
   * Daylight on the floor inside each window, turned with the window it comes through.
   *
   * Missed on the first pass, and the render is what caught it: with the glazing turned onto
   * the arc and the spill still square to the world, every bay had a pale axis-aligned patch
   * sitting at an angle to its own opening. A light pool that does not agree with its window is
   * worse than no light pool.
   *
   * These join `groundStack` rather than `architecture`, so they stay under the walls and inside
   * the slab clip like the flat `light` layer they came from.
   */
  const turnedSpill: Graphics[] = [];
  for (const band of floor.windows ?? []) {
    if (band.span) {
      turnedSpill.push(turnedOpening(band.span, (g) => drawLightSpill(g, { ...band, dir: "h" }, floor.walls, fp)));
    } else {
      drawLightSpill(light, band, floor.walls, fp);
    }
  }

  // Ambient occlusion hugging every solid. Without it a room reads as shapes
  // cut out of paper; with it the slab looks like it meets something.
  for (const wall of floor.walls) occlude(structureAo, wall, 11);
  for (const barrier of floor.barriers ?? []) {
    for (const run of capsuleRuns(barrier)) occludeShape(structureAo, pathOutline(run.points, run.thickness), 11);
  }
  for (const object of floor.objects) occlude(objectAo, object, 7);

  drawWalls(structure, structurePad, floor, fp);
  /**
   * Openings that sit on a turning wall get their own rotated Graphics; the rest draw
   * straight into the shared layers as before.
   *
   * `dir` is forced to "h" for a turned one, because `spanRect` now builds the band along +x
   * in its own frame — so the mullions, the sill highlight and the curtain slats all run
   * ACROSS that length, and the rotation carries them onto the wall together.
   */
  const turned: Graphics[] = [];
  for (const door of floor.doorways) {
    // An archway is a hole in a wall: no curtain, no rails. Where the opening
    // does not say what it is, a wide open one is a roll-up by convention.
    if (!isVehicleDoor(door)) continue;
    if (door.span && door.thickness !== undefined) {
      turned.push(turnedOpening(door.span, (g) =>
        drawVehicleDoorHead(g, structurePad, { ...door, dir: "h" }, floor.walls)));
    } else {
      drawVehicleDoorHead(structure, structurePad, door, floor.walls);
    }
  }
  for (const band of floor.windows ?? []) {
    if (band.span) {
      turned.push(turnedOpening(band.span, (g) => drawWindow(g, { ...band, dir: "h" }, floor.walls)));
    } else {
      drawWindow(glazing, band, floor.walls);
    }
  }

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
    // Derived from the collider, not from a kind list — that disagreement is the bug
    // this fixes. A surface is exempt because paint cannot be mistaken for cover.
    if (!isSolidObject(object) && !SURFACE_KINDS.has(object.kind)) {
      markPassable(g, { x: object.x, y: object.y, w: object.w, h: object.h });
    }
    /**
     * A turned object, rotated about its own centre.
     *
     * Costs nothing and needs no glyph to know about it, because of two facts that happen to
     * line up: this loop already builds one `Graphics` per object, and every glyph draws in
     * WORLD coordinates. So setting the pivot to the object's world-space centre and the
     * position to that same point spins the finished drawing in place. Fifty glyph functions
     * stay untouched.
     *
     * Only passable kinds reach here with an angle set — `compileObject` throws on a rotated
     * solid, because its collider would stay square to the world.
     *
     * KNOWN AND ACCEPTED: the ambient-occlusion smudge from `occlude(objectAo, object, 7)`
     * further up is keyed to the unrotated rect, so a turned object's ground darkening does
     * not turn with it. It is a soft wash under a flat floor marking and invisible at play
     * zoom; it becomes worth fixing when solids can turn, since a box's contact shadow is not
     * subtle. Written down rather than left to be rediscovered.
     */
    if (object.angle) {
      const cx = object.x + object.w / 2;
      const cy = object.y + object.h / 2;
      g.pivot.set(cx, cy);
      g.position.set(cx, cy);
      g.rotation = object.angle;
    }
    objects.addChild(g);
    objectViews.set(object.id, { object, view: g });
  }

  const groundStack = new Container();
  groundStack.addChild(slab, finishes, wear, bays, paintLayer, light, ...turnedSpill);
  if (slabClip) {
    groundStack.addChild(slabClip);
    groundStack.mask = slabClip;
  }
  architecture.addChild(
    groundStack,
    ...structureAo, ...structurePad,
    /**
     * THE FLIGHT GOES UNDER THE WALLS, because a wall at the head of a flight stands ON it.
     *
     * The stairs used to be a sibling drawn after all of `architecture`, so any wall that
     * crossed a stair rect was painted over by the treads. Reported on sight: "the top
     * barrier is not visible on the stairs in the observatory". The barrier was there, in
     * the data and in the collider — the observatory's F1 cap is a capsule spanning y
     * 2700..2708 and the flight it caps is y 2700..2820, so the cap sat wholly inside the
     * rect and every pixel of it was overdrawn. Its GROUND twin was invisible for the same
     * reason, and so is every wall anywhere in the world that ends on a flight.
     *
     * The flight is floor, not furniture: it belongs with the slab and the paint, under the
     * structure that is built on top of them. Ordering it that way makes the barrier appear
     * everywhere at once rather than nudging one building's cap out from under its stair.
     */
    stairs,
    structure, glazing,
    // After the flat layers, so a turned curtain or window reads as sitting in the wall
    // rather than under it. Same z-intent as `structure` and `glazing`, one node each.
    ...turned,
  );
  furniture.addChild(...objectAo, ...objectPad, objects);
  annotation.addChild(annotationGfx);

  view.addChild(architecture, furniture, annotation);
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

export { drawStair, drawStairHead } from "./modelStairs";
