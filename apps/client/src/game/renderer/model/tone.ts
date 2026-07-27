/**
 * The DotBot tonal drawing system: a monochrome physical model, lit from the
 * north, photographed from almost directly overhead.
 *
 * This is the successor to the pen-plotter language in `style.ts`. That system
 * banned shadows, gradients and material on principle, which is correct for an
 * architectural drawing and fatal for a game: a drafting symbol for a rack IS a
 * rectangle with bars, so fixtures could never read as objects. Here, value and
 * light carry the work that line weight could not.
 *
 * Three rules hold the whole language together.
 *
 *  1. ONE LIGHT. Everything is lit from the north, slightly west, high enough
 *     that shadows stay short. Every face is shaded by its own normal against
 *     that light (`faceLight`), so a wall at 30 degrees or a round tower is
 *     handled by the same rule that darkens a box's south face. No object may
 *     invent its own light.
 *
 *  2. SILHOUETTE == FOOTPRINT == COLLIDER. Apparent height is taken *inside* the
 *     authored shape, never as an overhang: `volume` pulls a rect's south edge
 *     north, and `volumeShape` pulls each vertex north in proportion to how much
 *     its faces point south, which reproduces the rect case exactly. The drawn
 *     shape and the collider stay the same shape, so the plan-view promise —
 *     what you see is what blocks you — survives at any geometry.
 *
 *  3. ACHROMATIC. The world is neutral grey. Materials separate by value and
 *     by a warm/cool bias so slight it never reads as colour. The entire
 *     chromatic budget belongs to gameplay: bots, Dots, plates, extraction.
 *
 *  4. NOTHING IN MOTION IS DRAWN STATICALLY. No smoke, no steam, no spray, no
 *     fan blades, no flapping. A frozen moving thing reads as an artefact and
 *     promises animation the renderer never delivers. Draw the part that does
 *     not move — the stack, the guard grille, the grate — and let the motion be
 *     absent rather than faked.
 */

import type { Graphics } from "pixi.js";
import { edgeNormal, insetPolygon } from "@dotbot/game/geometry";
import type { Vec2 } from "@dotbot/game/types";

export type Rect = { x: number; y: number; w: number; h: number };

/** Multiply every channel. The one way tones are allowed to relate. */
export function shade(color: number, k: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * k));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * k));
  const b = Math.min(255, Math.round((color & 0xff) * k));
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------------------
// Ground and structure values
// ---------------------------------------------------------------------------

export const V = {
  /** Outside the sheet. */
  void: 0xc8cacd,
  /**
   * Interior slab, held well off white on purpose.
   *
   * The first pass put the slab at 91% and the room died: every object was
   * darker than the floor, so nothing could read as *bright*. At 86% the slab
   * is a mid-tone, and paint, lit cores and the pools under the high bays all
   * have somewhere to go above it.
   */
  slab: 0xdcdee1,
  /** Poured-slab control joints. */
  joint: 0xd0d2d6,
  /** Fresh floor paint. Brighter than the slab, and the brightest ground tone. */
  paint: 0xfafbfc,
  /** Aged floor paint: still legible, no longer new. */
  paintWorn: 0xc6c9cd,
  /** Polished traffic lane — the slab where the trucks actually run. */
  polish: 0xebedef,
  /** Scuffed and soiled slab: aprons, thresholds, wall bases. */
  scuff: 0xd1d4d7,
  /** Tyre and skid marks. */
  skid: 0x92979c,
  /** Rugs and mats: laid on the slab, a touch warmer and darker than it. */
  rug: 0xcdcfd2,
  /** Sealed finish in a partitioned room. */
  sealed: 0xd5d7db,
  /** Painted shop-floor finish. */
  shopFloor: 0xcbced2,
  /** Bare plant-room slab. */
  plantFloor: 0xc2c5ca,
  /** Wall body — the south face of an extruded wall. */
  wall: 0x14171a,
  /** Wall top surface, lit. */
  wallCap: 0x33383d,
  /** Interior partition top, thinner and a touch lighter than the shell. */
  partitionCap: 0x3d4247,
  /** Glazing. */
  glass: 0xdae3e9,
  glassFrame: 0x2a2e33,
} as const;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export type Material = {
  /** Lit top surface. */
  top: number;
  /** South face in shade. */
  front: number;
  /** Silhouette line: darker than the front face, never pure black. */
  edge: number;
  /** North-edge catch light. */
  lit: number;
};

function material(top: number, frontK = 0.68, edgeK = 0.44): Material {
  return {
    top,
    front: shade(top, frontK),
    edge: shade(top, edgeK),
    lit: shade(top, 1.09),
  };
}

/**
 * Cool tones are metal, warm tones are fibre and timber. The bias is about 4%
 * — under the threshold where an eye calls it colour, over the threshold where
 * a steel rack and a shipping crate stop looking like the same object.
 */
export const MAT = {
  steelLit: material(0xdcdfe2),
  steel: material(0xbabfc4),
  steelDark: material(0x8f959b),
  steelDeep: material(0x666c72),
  painted: material(0xa2a8ae),
  paintedDark: material(0x7d838a),
  wood: material(0xc6c1b8),
  woodDark: material(0x9f9a90),
  fibre: material(0xd3cfc7),
  rubber: material(0x43474c),
  /** The bot-world product: cores read as bright discs on a dark deck. */
  core: material(0xe6e9ec),
  plateStock: material(0xb5bac0),
  board: material(0xc7cbcf),
  foliage: material(0xb7bcb9),
} as const;

// ---------------------------------------------------------------------------
// Apparent height
// ---------------------------------------------------------------------------

/**
 * How deep an object's south face is, in world units. This is a stylised
 * constant parallax, not literal height: it stays small enough that a 48-unit
 * DotBot never loses an aisle to a neighbour's front face, and it is capped so
 * the drawing stays a plan rather than drifting toward isometric.
 */
export const LIFT = {
  paint: 0,
  flat: 2,
  low: 3.5,
  seat: 5,
  bench: 7,
  crate: 7,
  cabinet: 9,
  drum: 8,
  machine: 9,
  wall: 10,
  column: 11,
} as const;

// ---------------------------------------------------------------------------
// Shadow
// ---------------------------------------------------------------------------

/**
 * A layered fake penumbra.
 *
 * Each layer is one Graphics whose *container* alpha carries the opacity, so
 * overlapping shadows inside a layer flatten instead of compounding into black
 * blotches under dense racking.
 *
 * Layer count matters more than it looks. Three layers leave visible stepped
 * rectangles around every object — a drop-shadow artefact, not a shadow — so
 * each step also grows its corner radius, and there are enough of them that the
 * ramp reads as falloff.
 */
export type ShadowPad = Graphics[];

/**
 * Darkest first, summing to roughly a quarter-value at the contact edge.
 *
 * The step count is the whole game here. Six steps still showed as concentric
 * rounded rectangles at review zoom — a halo, not a shadow — so the ramp is long
 * and each individual step is nearly invisible.
 */
export const SHADOW_ALPHA = [0.062, 0.05, 0.041, 0.033, 0.026, 0.02, 0.015, 0.011, 0.008] as const;

/** Uniform occlusion hugging a solid, with no offset. Softer and much lighter. */
export const AO_ALPHA = [0.019, 0.016, 0.013, 0.011, 0.009, 0.007, 0.005] as const;

/** Sun vector. Short, south-east, and never changed by a caller. */
const SUN = { x: 0.3, y: 0.62 };

function pushShadow(g: Graphics, r: Rect, dx: number, dy: number, grow: number, radius: number): void {
  g.roundRect(r.x + dx - grow, r.y + dy - grow, r.w + grow * 2, r.h + grow * 2, radius + grow * 0.9)
    .fill({ color: 0x000000 });
}

/** Ground shadow for a rectangular solid of apparent height `lift`. */
export function contact(pad: ShadowPad, r: Rect, lift: number, radius = 0): void {
  if (lift <= 0) return;
  for (let i = 0; i < pad.length; i += 1) {
    const t = pad.length === 1 ? 0 : i / (pad.length - 1);
    const spread = 0.45 + t * 1.5;
    pushShadow(pad[i], r, SUN.x * lift * spread, SUN.y * lift * spread, t * lift * 1.1 + 0.4, radius);
  }
}

/** Ground shadow for a cylinder. */
export function contactRound(pad: ShadowPad, cx: number, cy: number, radius: number, lift: number): void {
  for (let i = 0; i < pad.length; i += 1) {
    const t = pad.length === 1 ? 0 : i / (pad.length - 1);
    const spread = 0.45 + t * 1.5;
    pad[i]
      .circle(cx + SUN.x * lift * spread, cy + SUN.y * lift * spread, radius + t * lift * 1.1 + 0.4)
      .fill({ color: 0x000000 });
  }
}

/** Uniform contact darkening around a solid, drawn into a dedicated AO pad. */
export function occlude(pad: ShadowPad, r: Rect, reach = 9): void {
  for (let i = 0; i < pad.length; i += 1) {
    const t = pad.length === 1 ? 0 : i / (pad.length - 1);
    const grow = 1 + t * reach;
    pad[i]
      .roundRect(r.x - grow, r.y - grow, r.w + grow * 2, r.h + grow * 2, grow)
      .fill({ color: 0x000000 });
  }
}

/**
 * The same ambient occlusion for a shape that is not a rectangle.
 *
 * The outline is grown along its own edge normals rather than radially from a
 * centroid, so a 400-unit wall run gets the same tight band all the way along it
 * instead of a halo that swells towards its ends.
 */
export function occludeShape(pad: ShadowPad, points: Vec2[], reach = 9): void {
  if (points.length < 3) return;
  for (let i = 0; i < pad.length; i += 1) {
    const t = pad.length === 1 ? 0 : i / (pad.length - 1);
    fillPolygon(pad[i], insetPolygon(points, -(1 + t * reach)), 0x000000);
  }
}

// ---------------------------------------------------------------------------
// The volume primitive
// ---------------------------------------------------------------------------

const EDGE_WIDTH = 0.9;

/**
 * Draw an extruded box and return its lit top face.
 *
 * The full authored rect is the silhouette. The south band of depth `lift` is
 * the shaded front face; everything above it is the lit top. Detail belongs on
 * the returned top rect, never on the front face — front faces stay simple so
 * the eye reads them as one continuous shadow line across the room.
 */
export function volume(
  g: Graphics,
  r: Rect,
  mat: Material,
  lift: number,
  radius = 0,
): Rect {
  // Never let the front face eat the top. A 16-unit column at lift 11 has a
  // 5-unit top and reads as a dark blob, not a column, so apparent height is
  // capped against the object's own short side.
  const capped = Math.min(lift, Math.min(r.w, r.h) * 0.45);
  const top: Rect = { x: r.x, y: r.y, w: r.w, h: Math.max(1, r.h - capped) };
  lift = capped;

  if (radius > 0) {
    g.roundRect(r.x, r.y, r.w, r.h, radius).fill({ color: mat.front });
    g.roundRect(top.x, top.y, top.w, top.h, radius).fill({ color: mat.top });
  } else {
    g.rect(r.x, r.y, r.w, r.h).fill({ color: mat.front });
    g.rect(top.x, top.y, top.w, top.h).fill({ color: mat.top });
  }

  // North-edge catch light: the cue that sells thickness at play zoom.
  if (lift >= LIFT.seat && r.w > 6) {
    g.rect(r.x + 0.6, r.y + 0.4, r.w - 1.2, 0.9).fill({ color: mat.lit });
  }

  const inset = EDGE_WIDTH / 2;
  if (radius > 0) {
    g.roundRect(r.x + inset, r.y + inset, r.w - EDGE_WIDTH, r.h - EDGE_WIDTH, radius)
      .stroke({ color: mat.edge, width: EDGE_WIDTH });
  } else {
    g.rect(r.x + inset, r.y + inset, r.w - EDGE_WIDTH, r.h - EDGE_WIDTH)
      .stroke({ color: mat.edge, width: EDGE_WIDTH });
  }

  return top;
}

// ---------------------------------------------------------------------------
// Arbitrary shapes
// ---------------------------------------------------------------------------

/** Unit vector from a surface toward the light: north, slightly west. */
const LIGHT = (() => {
  const x = -0.35;
  const y = -1;
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
})();

/**
 * How lit a face is, from its outward normal. This is the generalisation that
 * frees the language from axis-aligned boxes: the rectangle rule — south faces
 * dark, north faces bright — is just this function evaluated at four normals, so
 * a wall at 30 degrees or a round tower shades correctly with no special case.
 */
export function faceLight(normal: Vec2): number {
  const dot = normal.x * LIGHT.x + normal.y * LIGHT.y;
  return 0.52 + ((dot + 1) / 2) * 0.56;
}

function fillPolygon(g: Graphics, points: Vec2[], color: number, alpha = 1): void {
  if (points.length < 3) return;
  g.poly(points.map((point) => ({ x: point.x, y: point.y }))).fill({ color, alpha });
}

/**
 * Extrude an arbitrary polygon, returning its lit top face.
 *
 * Same three rules as `volume`, generalised. The top face is produced by pulling
 * each vertex north in proportion to how much its adjacent faces point south, so
 * a rectangle reproduces `volume` exactly while an L-plan, a wedge or a circle
 * all keep the silhouette equal to the authored footprint.
 */
export function volumeShape(
  g: Graphics,
  points: Vec2[],
  mat: Material,
  lift: number,
): Vec2[] {
  if (points.length < 3) return points;
  const count = points.length;
  const normals = points.map((_, index) => edgeNormal(points, index));

  const top = points.map((point, index) => {
    const incoming = normals[(index - 1 + count) % count];
    const outgoing = normals[index];
    const southness = Math.max(0, (incoming.y + outgoing.y) / 2);
    return { x: point.x, y: point.y - lift * southness };
  });

  // Silhouette first, so any face the top does not cover is already in shade.
  fillPolygon(g, points, mat.front);

  // Then each visible face, shaded by its own normal.
  for (let index = 0; index < count; index += 1) {
    const normal = normals[index];
    if (normal.y <= 0.01) continue;
    const a = points[index];
    const b = points[(index + 1) % count];
    const ta = top[index];
    const tb = top[(index + 1) % count];
    fillPolygon(g, [ta, tb, b, a], shade(mat.top, faceLight(normal)));
  }

  fillPolygon(g, top, mat.top);

  // Catch light along the faces that turn toward the light.
  for (let index = 0; index < count; index += 1) {
    const normal = normals[index];
    if (normal.y >= -0.35) continue;
    const a = top[index];
    const b = top[(index + 1) % count];
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: mat.lit, width: 1.1 });
  }

  g.poly(points.map((point) => ({ x: point.x, y: point.y })))
    .stroke({ color: mat.edge, width: EDGE_WIDTH });

  return top;
}

/**
 * Ground shadow for an arbitrary polygon.
 *
 * The shape is grown along its own edge normals, not radially from its centroid.
 * Radial growth is fine for something roughly as wide as it is tall, but a
 * 400-unit wall run has a centroid 200 units from either end, so every vertex
 * pulls lengthwise and the shadow stretches off the ends while staying pinned to
 * the long faces.
 */
export function contactShape(pad: ShadowPad, points: Vec2[], lift: number): void {
  if (lift <= 0 || points.length < 3) return;
  for (let i = 0; i < pad.length; i += 1) {
    const t = pad.length === 1 ? 0 : i / (pad.length - 1);
    const spread = 0.45 + t * 1.5;
    const grow = 1 + t * lift * 0.9;
    fillPolygon(
      pad[i],
      insetPolygon(points, -grow).map((point) => ({
        x: point.x + SUN.x * lift * spread,
        y: point.y + SUN.y * lift * spread,
      })),
      0x000000,
    );
  }
}

/** An extruded cylinder: top ellipse plus a shaded south crescent. */
export function cylinder(g: Graphics, cx: number, cy: number, radius: number, mat: Material, lift: number): void {
  g.circle(cx, cy + lift * 0.5, radius).fill({ color: mat.front });
  g.circle(cx, cy, radius).fill({ color: mat.top });
  g.circle(cx, cy, radius - 0.45).stroke({ color: mat.edge, width: EDGE_WIDTH });
}

/** Flat surface detail: no height, no shadow, just a value change on a top face. */
export function inlay(g: Graphics, r: Rect, color: number, radius = 0): void {
  if (radius > 0) g.roundRect(r.x, r.y, r.w, r.h, radius).fill({ color });
  else g.rect(r.x, r.y, r.w, r.h).fill({ color });
}

/**
 * A recessed seam — the dark hairline that says "two panels meet here". Reads
 * as construction rather than annotation, which is why detail lives in seams
 * and cast shadow instead of the hatch marks the old system used.
 */
export function seam(g: Graphics, x1: number, y1: number, x2: number, y2: number, color: number, width = 0.7): void {
  g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color, width });
}

/**
 * Small-object occlusion: the short shadow an item casts onto the surface it
 * sits on, drawn inline rather than into the ground pad.
 */
export function sit(g: Graphics, r: Rect, lift: number, radius = 0): void {
  const dx = SUN.x * lift;
  const dy = SUN.y * lift;
  if (radius > 0) {
    g.roundRect(r.x + dx, r.y + dy, r.w, r.h, radius).fill({ color: 0x000000, alpha: 0.17 });
  } else {
    g.rect(r.x + dx, r.y + dy, r.w, r.h).fill({ color: 0x000000, alpha: 0.17 });
  }
}

export function sitRound(g: Graphics, cx: number, cy: number, radius: number, lift: number): void {
  g.circle(cx + SUN.x * lift, cy + SUN.y * lift, radius).fill({ color: 0x000000, alpha: 0.17 });
}

// ---------------------------------------------------------------------------
// Deterministic variation
// ---------------------------------------------------------------------------

/**
 * Stable 0..1 from an object id. A warehouse where every crate sits at exactly
 * the same angle reads as a tile map; a few degrees of authored-looking scatter
 * reads as a place people work in. Deterministic so collision, tests and
 * screenshots never disagree.
 */
export function jitter(id: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Signed jitter in [-1, 1]. */
export function jitterSigned(id: string, salt = 0): number {
  return jitter(id, salt) * 2 - 1;
}
