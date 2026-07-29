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
 *     authored shape, never as an overhang: both `volume` and `volumeShape` get
 *     their top face from `prism.ts`, so a rect and a polygon are one rule and
 *     cannot drift apart. The drawn shape and the collider stay the same shape, so
 *     the plan-view promise — what you see is what blocks you — survives at any
 *     geometry. Its corollary is that the outermost thing any solid draws is
 *     `mat.edge`: light on the boundary reads as a gap, not as a surface.
 *
 *  3. ACHROMATIC. The world is neutral grey. Materials separate by value and
 *     by a warm/cool bias so slight it never reads as colour. The entire
 *     chromatic budget belongs to gameplay: bots, Dots, plates, extraction.
 *
 *  4. A MOVING THING IS EITHER ANIMATED OR NOT DRAWN. **This is not a rule
 *     against motion. Motion is wanted.**
 *
 *     It was written after a review of static smoke — a puff of frozen circles
 *     over a chimney, which reads as a solid blob of debris rather than as
 *     smoke. That is the entire defect: a moving thing frozen into a still mark
 *     is an artefact. The fix is to ANIMATE IT, and only where that is not on
 *     the table yet, to draw the part that is genuinely still (the stack, the
 *     guard grille, the grate) and leave the motion out.
 *
 *     Do NOT read this rule as a reason to choose a still subject over a moving
 *     one, or to cut something because it would need to move. It has been
 *     misread that way repeatedly and it cost real content: a chairoplane was
 *     deleted rather than given swinging seats, and a whole derelict fairground
 *     was justified on the grounds that stillness was the point. Mike has
 *     corrected this more than once. Rides turning, canopies swaying, leaves
 *     falling, trails in the dirt and eventually vehicles and fast travel are
 *     all wanted — see `docs/world-motion.md`, which owns the how.
 */

import type { Graphics } from "pixi.js";
import { edgeNormal, insetPolygon } from "@dotbot/game/geometry";
import type { Vec2 } from "@dotbot/game/types";
import { cappedLift, NORTH, topFace, topRect } from "./prism";

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
  /**
   * The materials a world outside a city is built from.
   *
   * They join `MAT` rather than living beside it, and the reason is the reason `MAT`
   * is closed at all: the moment a region can mint its own material, the world stops
   * being one place. These arrived as a private `mat()` in a mock file, which was
   * fine for a mock and is the exact seam a second palette grows out of.
   *
   * Note where each sits on the existing ramp. Dressed stone is between `wood` and
   * `steel`, a shade brighter than paving because it is cut and dry. Rusted iron is
   * near `steelDeep`, dark on purpose: outside the city the GROUND owns the bright
   * end, and a rail region drawn in mid-grey iron on pale ballast came out as one
   * flat field.
   */
  stone: material(0xc6c7c2),
  stoneWorn: material(0xb9bab4),
  /** Adobe, mud brick, lime render. Warm, and brighter than cut stone. */
  adobe: material(0xd2ccbf),
  /** Weathered boulder and outcrop. */
  rock: material(0xb4b6b2),
  /** Wet or shaded rock, and the inside of a cave mouth. */
  rockDark: material(0x8e918d),
  /** Rusted iron: a rail, a tank, corrugated sheet. */
  iron: material(0x7d7b76),
  /** Canvas and painted timber gone chalky in the sun — a fairground's own material. */
  canvas: material(0xd7d3cb),
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
  /**
   * Landmark scale, and the reason the ramp needed two more rungs.
   *
   * Everything above is furniture, and the tallest of it — a column, floor to deck —
   * is one storey. A landmark is not furniture: a water tower, a coaling stage, a
   * ferris wheel and a pyramid terrace are all building-sized, and drawn on
   * `LIFT.column` every one of them read as a crate somebody had left out. The ramp
   * stops here rather than continuing, because past `tower` the parallax is doing the
   * work of a building and the thing should be a building.
   *
   * Both still go through `cappedLift`, so a small object cannot claim them: a
   * 40-unit boulder asking for `tower` gets 18, and the drawing stays a plan.
   */
  mass: 17,
  tower: 34,
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

/**
 * Composite darkness the nine-step ramp reaches where every layer overlaps.
 *
 * `1 - ∏(1 - alpha)`, not the sum: the layers composite over one another. Any
 * replacement ramp has to land on this number or every surface under a shadow
 * changes value — a roof deck's tone was picked by eye with this wash already on
 * it.
 */
export const SHADOW_TOTAL = 1 - SHADOW_ALPHA.reduce((keep, alpha) => keep * (1 - alpha), 1);

/**
 * How fast the shadow lightens away from the object.
 *
 * Fitted against the hand-tuned nine-step ramp, which comes out at 1.6 sampled at
 * a quarter, a half and three quarters of its reach. Without it the shadow
 * composites to the right total and still looks wrong: a uniform wash and a real
 * penumbra are the same number at the centre and nothing alike anywhere else.
 *
 * It grades the *alpha*, not the spacing. Bunching the rings instead is the same
 * curve and was the first attempt — but then the widest gap is at the outer edge
 * and is `bias` times what even spacing would give, so the step count needed to
 * hide it goes up by the same factor. A test caught that; the screenshot would
 * not have, because the one visible band was out in the faint tail.
 */
const SHADOW_FALLOFF = 1.6;

/** Widest a ring may sit from the next before the eye starts finding the edge. */
const SHADOW_STEP_MAX = 2.4;

/**
 * The tallest a block may claim to be, as far as its shadow is concerned.
 *
 * Ring count follows reach, so cost is linear in lift and an unclamped one would
 * let a single absurd building spend hundreds of fills. Clamping here rather than
 * capping the ring count is deliberate: a cap on rings degrades quietly back into
 * the banding this whole primitive exists to remove, and a silent degradation is
 * how the original bug survived. A saturated shadow is honest — past about ten
 * storeys the pool stops being how you tell buildings apart anyway.
 */
export const MAX_BLOCK_LIFT = 124;

/**
 * Ground shadow for a lone solid, drawn into one Graphics at a step count set by
 * how far it actually spreads.
 *
 * `contact` has a fixed nine steps, and nine was chosen for furniture: at a wall's
 * lift of 10 the rings land about a unit apart and vanish. Buildings broke that
 * the moment their shadows started scaling with storey count — at Civic Tower's
 * lift of 101 the same nine steps are twelve units apart, and the shadow comes out
 * as six concentric rounded rectangles stepping across the pavement. Exactly the
 * halo the ramp's own comment says it exists to prevent, just at a lift nobody had
 * tried.
 *
 * So the count follows the spread instead of being a constant. It goes into a
 * single Graphics rather than a pad because a block casts alone — the pad's
 * one-Graphics-per-layer arrangement exists so that fifty racks sharing a pad
 * flatten instead of compounding, and paying sixty display objects per building
 * for that would be paying for nothing.
 */
export type ShadowRing = { dx: number; dy: number; grow: number; alpha: number };

/**
 * The rings of a block shadow, outermost first. Pure, so the thing that broke —
 * a step count that was fine at one lift and a stack of visible bands at another
 * — is checked by arithmetic rather than by squinting at a screenshot.
 */
export function blockShadowRings(rawLift: number): ShadowRing[] {
  if (rawLift <= 0) return [];
  const lift = Math.min(rawLift, MAX_BLOCK_LIFT);
  const reach = lift * 1.1;
  const steps = Math.max(SHADOW_ALPHA.length, Math.ceil(reach / SHADOW_STEP_MAX) + 1);

  /**
   * How much light still gets through everything from ring `index` outward.
   *
   * Each ring is then handed exactly the alpha that takes the running product
   * from its neighbour's transmission to its own, so the stack telescopes to
   * `1 - SHADOW_TOTAL` at the centre no matter how many rings there are. That is
   * what lets the count follow the spread without restyling every surface a
   * shadow falls on.
   */
  const transmission = (index: number): number =>
    (index >= steps ? 1 : 1 - SHADOW_TOTAL * Math.pow(1 - index / steps, SHADOW_FALLOFF));

  const rings: ShadowRing[] = [];
  for (let index = steps - 1; index >= 0; index -= 1) {
    const t = index / (steps - 1);
    const spread = 0.45 + t * 1.5;
    rings.push({
      dx: SUN.x * lift * spread,
      dy: SUN.y * lift * spread,
      grow: t * reach + 0.4,
      alpha: 1 - transmission(index) / transmission(index + 1),
    });
  }
  return rings;
}

export function contactBlock(g: Graphics, r: Rect, lift: number, radius = 0): void {
  for (const ring of blockShadowRings(lift)) {
    g.roundRect(
      r.x + ring.dx - ring.grow,
      r.y + ring.dy - ring.grow,
      r.w + ring.grow * 2,
      r.h + ring.grow * 2,
      radius + ring.grow * 0.9,
    ).fill({ color: 0x000000, alpha: ring.alpha });
  }
}

/**
 * The same block shadow, for a building that is not a rectangle.
 *
 * An L-plan, a chamfered corner and an annular sector all cast the shadow of their
 * own shape, and until this existed they cast the shadow of their bounding box — so
 * the roundhouse threw a rectangle across half a rail yard, and Quayside's L had been
 * shading the courtyard it wraps for as long as it had existed.
 */
export function contactBlockShape(g: Graphics, points: Vec2[], lift: number): void {
  if (points.length < 3) return;
  for (const ring of blockShadowRings(lift)) {
    fillPolygon(
      g,
      insetPolygon(points, -ring.grow).map((point) => ({ x: point.x + ring.dx, y: point.y + ring.dy })),
      0x000000,
      ring.alpha,
    );
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

/**
 * Which way the current drawing pass pulls its top faces.
 *
 * Render-pass state, and deliberately not a parameter. The alternative is threading a
 * direction through `drawModelObject` and every one of the fifty glyph functions under
 * it — 109 call sites — to say one thing that is true of the whole pass rather than of
 * any object. This is what a pass parameter is.
 *
 * It is scoped by WHEN it is set, which is the part to be careful about. Structure —
 * walls, stairs, glazing — is drawn while it is `NORTH`, because a wall is part of the
 * building and the building already parallaxes as a whole mass in `modelRoof`; sliding
 * its top independently would slide it twice. Only the object pass sets it, and it is
 * always put back.
 */
let viewPull: Vec2 = NORTH;

/** Set the pass pull. Always restore it — `withViewPull` does that for you. */
export function setViewPull(pull: Vec2): void {
  viewPull = pull;
}

/** Draw `body` with `pull` in force, restoring whatever was in force before. */
export function withViewPull(pull: Vec2, body: () => void): void {
  const previous = viewPull;
  viewPull = pull;
  try {
    body();
  } finally {
    viewPull = previous;
  }
}

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

/**
 * The four axis faces, evaluated once.
 *
 * `volume` needs these because a box's exposed band is a FACE, and until now it was
 * not treated as one: the rectangle path flooded the whole footprint with `mat.front`
 * and painted the top over it, so whichever band was left showing came out in the
 * south tone no matter which side of the object it was on. That was invisible while
 * the pull was always north — the exposed band always WAS the south face — and it is
 * the reason object parallax could not ship: turned far enough, a box showed a dark
 * band on its north side, a shadow on the lit side.
 *
 * Note how far apart the two primitives had drifted: `material()` uses `frontK = 0.68`
 * while `faceLight` at a south normal gives 0.536. Every rectangle in the game has been
 * drawing its front face a quarter lighter than every polygon draws the same face.
 * Unifying moves the rectangles onto the darker, physically-derived value, which is the
 * direction that reads as more solid rather than less.
 */
const BAND = {
  north: faceLight({ x: 0, y: -1 }),
  south: faceLight({ x: 0, y: 1 }),
  east: faceLight({ x: 1, y: 0 }),
  west: faceLight({ x: -1, y: 0 }),
};

const EDGE_WIDTH = 0.9;

/**
 * Width of the north-edge catch light.
 *
 * It is drawn a full edge-width in from the silhouette, never on it. Contract §3
 * gives the reason: dark, closed outlines mean solid and impassable, so the
 * outermost thing a solid draws has to be `mat.edge`. A catch light sitting on the
 * boundary is light where the boundary should be dark, and against a pale slab it
 * reads as a gap — a bot resting hard against a wall looks like it stopped short of
 * one, with a bright line in between.
 */
const CATCH_WIDTH = 0.9;

/**
 * Draw an extruded box and return its lit top face.
 *
 * The full authored rect is the silhouette. The band of depth `lift` left showing
 * once the top has been shifted along the pull is a vertical FACE, shaded by its
 * own outward normal like every other face in the language. Detail belongs on the
 * returned top rect, never on a side band — bands stay flat so the eye reads them
 * as one continuous depth line across the room.
 */
export function volume(
  g: Graphics,
  r: Rect,
  mat: Material,
  lift: number,
  radius = 0,
  pull: Vec2 = viewPull,
): Rect {
  // Never let the front face eat the top: see `cappedLift`. `topRect` measures the
  // depth along the pull, so an east-west pull is capped against width, not height.
  const top = topRect(r, lift, pull);
  const capped = cappedLift(r.h, lift);
  lift = capped;

  /**
   * Which side each band is on, and therefore which way it faces.
   *
   * `topRect` shifts the top ALONG the pull and clips, so the band is left on the
   * OPPOSITE side: pull north and the south face shows, pull south and the north
   * face shows — and a north face is brighter than the top it belongs to, because
   * a vertical surface square to the light catches more of it than a horizontal one.
   * At most one of each pair can exist, since a single shift cannot expose both.
   */
  const northBand = top.y > r.y ? { y: r.y, h: top.y - r.y, k: BAND.north } : null;
  const southBand =
    top.y + top.h < r.y + r.h
      ? { y: top.y + top.h, h: r.y + r.h - (top.y + top.h), k: BAND.south }
      : null;
  const westBand = top.x > r.x ? { x: r.x, w: top.x - r.x, k: BAND.west } : null;
  const eastBand =
    top.x + top.w < r.x + r.w
      ? { x: top.x + top.w, w: r.x + r.w - (top.x + top.w), k: BAND.east }
      : null;

  const upright = northBand ?? southBand;
  const flank = westBand ?? eastBand;

  /**
   * The base fill covers the whole footprint so no anti-aliased seam can open between
   * two bands, and it is the upright band's tone because that is the band an oblique
   * pull leaves widest — the flank is painted over it, which also settles the shared
   * corner in favour of the side actually facing the viewer.
   */
  const base = shade(mat.top, upright?.k ?? flank?.k ?? BAND.south);

  // Only an oblique pull exposes two faces at once. On an axis the base fill already
  // IS the one exposed face, so painting the flank again would be the same colour twice.
  const secondFace = upright && flank ? { ...flank, color: shade(mat.top, flank.k) } : null;

  if (radius > 0) {
    g.roundRect(r.x, r.y, r.w, r.h, radius).fill({ color: base });
    if (secondFace) g.rect(secondFace.x, r.y, secondFace.w, r.h).fill({ color: secondFace.color });
    g.roundRect(top.x, top.y, top.w, top.h, radius).fill({ color: mat.top });
  } else {
    g.rect(r.x, r.y, r.w, r.h).fill({ color: base });
    if (secondFace) g.rect(secondFace.x, r.y, secondFace.w, r.h).fill({ color: secondFace.color });
    g.rect(top.x, top.y, top.w, top.h).fill({ color: mat.top });
  }

  // North-edge catch light: the cue that sells thickness at play zoom.
  if (lift >= LIFT.seat && r.w > EDGE_WIDTH * 2 + 6) {
    g.rect(r.x + EDGE_WIDTH, r.y + EDGE_WIDTH, r.w - EDGE_WIDTH * 2, CATCH_WIDTH)
      .fill({ color: mat.lit });
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
  pull: Vec2 = viewPull,
): Vec2[] {
  if (points.length < 3) return points;
  const count = points.length;
  const normals = points.map((_, index) => edgeNormal(points, index));
  const top = topFace(points, lift, pull);

  // Silhouette first, so any face the top does not cover is already in shade.
  fillPolygon(g, points, mat.front);

  /**
   * Then each visible face, shaded by its own normal.
   *
   * WHICH faces are visible is a question about the camera — you see the ones turned away
   * from it — so it follows the pull. HOW they are shaded is a question about the light,
   * which does not move, so it stays `faceLight(normal)`. Keeping those two apart is the
   * whole reason one light and a moving camera can coexist: the same face can be visible
   * from the north and dark, or hidden and lit.
   *
   * This was `normal.y <= 0.01`, which is the same test with the pull nailed north.
   */
  for (let index = 0; index < count; index += 1) {
    const normal = normals[index];
    if (-(normal.x * pull.x + normal.y * pull.y) <= 0.01) continue;
    const a = points[index];
    const b = points[(index + 1) % count];
    const ta = top[index];
    const tb = top[(index + 1) % count];
    fillPolygon(g, [ta, tb, b, a], shade(mat.top, faceLight(normal)));
  }

  fillPolygon(g, top, mat.top);

  /**
   * Catch light along the faces that turn toward the light, held clear of the
   * silhouette.
   *
   * A north face's top edge *is* the footprint boundary, so stroking it directly
   * put a 1.1-wide light line centred on the collider — 0.55 of it outside the
   * shape, which the 0.9 dark outline could not cover. The ring it runs on is
   * inset far enough that the outline stays the outermost thing drawn.
   */
  const litRing = insetPolygon(top, EDGE_WIDTH + CATCH_WIDTH / 2);
  for (let index = 0; index < count; index += 1) {
    if (normals[index].y >= -0.35) continue;
    const a = litRing[index];
    const b = litRing[(index + 1) % count];
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: mat.lit, width: CATCH_WIDTH });
  }

  // Inset like `volume`'s, so the dark ring lands inside the collider instead of
  // straddling it. What the drawing promises is impassable is exactly what is.
  g.poly(insetPolygon(points, EDGE_WIDTH / 2).map((point) => ({ x: point.x, y: point.y })))
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
 * How much of the floor shows through something you can walk over.
 *
 * The point of a number this low is that it cannot be mistaken for a material. An
 * earlier attempt at this made passable things *slightly* fainter and it did not
 * read at play zoom — a subtle cue is no cue, and the one after that made the cue
 * the ABSENCE of a cast shadow, which is weaker still: you have to notice something
 * missing, find a neighbour to compare it against, and already know the rule.
 */
export const PASSABLE_ALPHA = 0.6;

/**
 * How far a passable thing is washed toward white, on top of being see-through.
 *
 * Transparency alone puts the floor's own tone through the object, and the floor is
 * a mid grey — so a grey fixture at 60% over a grey slab is still a grey rectangle.
 * The wash is what breaks it out of the material range entirely: hazed and bleached,
 * the way something behind glass looks, which is a thing no solid in the game does.
 */
export const PASSABLE_WASH = 0.38;

/**
 * Mark a drawn object as something a bot walks straight through.
 *
 * Applied from the collider — `!isSolidObject(object)` — and never from a list of
 * kinds, which is the whole reason it exists. Three glyphs had been drawing an
 * extruded box with a cast shadow while the sim let bots walk through them, and a
 * comment three files away asserted the opposite was true. Deriving the treatment
 * from the same predicate the physics uses means the drawing cannot disagree with
 * what you can walk through, and a new passable kind gets the treatment for free.
 */
export function markPassable(g: Graphics, r: Rect): void {
  g.alpha = PASSABLE_ALPHA;
  g.rect(r.x, r.y, r.w, r.h).fill({ color: 0xffffff, alpha: PASSABLE_WASH });
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
