import { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import {
  MAT,
  contactRound,
  contactShape,
  cylinder,
  jitter,
  shade,
  volumeShape,
  type Material,
  type Rect,
  type ShadowPad,
} from "../../game/renderer/model/tone";

/**
 * Terrain primitives, as a SKETCH.
 *
 * The city needs none of these, which is the point: this file is the honest
 * measure of what leaving Downtown actually costs. Everything here is drawn in the
 * production language — `tone.ts` values, `volumeShape`, one light north-slightly-west,
 * silhouette equal to collider — so a vignette built out of it is a claim the engine
 * can be held to, not a picture. Contract §2 forbids proving world direction with a
 * concept image, and it is right to: an illustration of a forest tells you an
 * illustrator can draw a forest.
 *
 * It lives under `ui/worlds/` rather than `renderer/model/` on purpose. None of it is
 * tested, none of it is reachable from the game, and only the region Mike picks earns
 * promotion into the renderer with tests behind it. Sketch now, production later, and
 * the directory says which is which.
 */

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/**
 * Natural ground, continuing the exterior's albedo scale rather than starting a
 * new one.
 *
 * `modelOutdoor`'s scale runs forecourt → footway → yard → asphalt → verge → void,
 * lightest to darkest, and it follows real albedo. These slot into the same ramp:
 * dry dust is bright like fresh paving, wet rock is dark like tarmac, standing
 * water is nearly the void. Inventing a second scale for "outside the city" is how
 * a region ends up looking like a different game.
 */
export const GROUND = {
  /** Dry dust and sand. The brightest ground in the game — a desert reads hot. */
  dust: 0xd9d5cb,
  /** Beaten earth: a trail, a yard, a plaza floor worn back to soil. */
  earth: 0xc9c4b9,
  /** River gravel and shingle, cool where dust is warm. */
  gravel: 0xcfd0cd,
  /** Cut stone, worn. Between footway and yard, because that is what it is. */
  flag: 0xcbccc8,
  /**
   * Forest floor: leaf litter over soil, under a canopy.
   *
   * Much darker than a first pass had it, and this is the value the whole region hangs
   * off. At 0xb6b4a9 it sat within a few steps of the tree crowns, the boulders and the
   * gravel, and the sheet came out as one beige field with grey lumps on it. A forest
   * floor is genuinely in shade — that is what a canopy DOES — and giving the ground the
   * dark end of the scale is what lets a sunlit crown be the bright thing.
   */
  humus: 0x8f8d84,
  /** Open grass, in the sun: a clearing, which is why it is much lighter than humus. */
  grass: 0xaeb2a8,
  /** Scrub and low brush, matching the city's verge so planting reads the same. */
  scrub: 0x99a09a,
  /** Bare rock underfoot. */
  rock: 0xa9aba8,
  /** Shallow water over a bright bed. */
  shallow: 0x9ba4a9,
  /**
   * Water with depth under it.
   *
   * Darker than the city's asphalt on purpose. At 0x6f777d it was four steps off
   * `OUT.asphalt` and a straight reach of creek read as a road — the shape said river and
   * the value said carriageway, and the value won.
   */
  deep: 0x565e64,
  /** A sinkhole, a well, a flooded shaft: the darkest value the world contains. */
  abyss: 0x474d52,
} as const;

/**
 * Local stand-in for `tone.ts`'s private `material()`.
 *
 * Duplicated deliberately rather than exported from `tone.ts`: exporting it would
 * invite every surface to mint its own materials, and `MAT` being a closed set is
 * what keeps the world in one palette. These graduate INTO `MAT` when a region is
 * chosen.
 */
function mat(top: number, frontK = 0.68, edgeK = 0.44): Material {
  return { top, front: shade(top, frontK), edge: shade(top, edgeK), lit: shade(top, 1.09) };
}

export const NAT = {
  /** Weathered boulder and outcrop. */
  rock: mat(0xb4b6b2),
  /** Wet or shaded rock, and the inside of a cave mouth. */
  rockDark: mat(0x8e918d),
  /** Dressed stone: a temple face, a quay, a kerb cut from rock. */
  stone: mat(0xc6c7c2),
  /** Dressed stone that has been walked on for centuries. */
  stoneWorn: mat(0xb9bab4),
  /** Adobe, mud brick, rendered block. Warm, and brighter than cut stone. */
  adobe: mat(0xd2ccbf),
  /** A trunk, a post, a rail. Timber already exists — reuse it. */
  timber: MAT.wood,
  timberDark: MAT.woodDark,
  /**
   * Rusted iron: a rail, a tank, corrugated sheet.
   *
   * Dark, because in a dust region the GROUND owns the bright end and every built thing
   * has to sit against it. The frontier's first render put 0x9c9a95 iron and 0xc6c1b8
   * timber on 0xd9d5cb dust and the whole sheet came out as one beige field.
   */
  iron: mat(0x7d7b76),
} as const;

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

function signedArea(points: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Offset a polygon along its own edge normals, positive inward.
 *
 * Scaling toward the centroid is the tempting shortcut and it is wrong for anything
 * elongated — `contactShape` carries the same note for the same reason: a 400-unit
 * river reach has a centroid 200 units from either end, so every vertex would pull
 * lengthwise instead of across the flow.
 */
export function inset(points: Vec2[], d: number): Vec2[] {
  const area = signedArea(points);
  const sign = area > 0 ? 1 : -1;
  const count = points.length;
  /**
   * Clamp the offset to something the shape can absorb.
   *
   * An unclamped inset past a shape's own inradius turns it inside out, and the result is
   * not a small polygon — it is a wedge pointing the wrong way. That produced a triangle
   * where the temple's summit doorway should be and turned both serpent heads into little
   * arrows. `sqrt(area)` is a crude inradius but it is the right crude one: it scales with
   * the shape rather than with any one edge.
   */
  d = Math.min(d, Math.sqrt(Math.abs(area)) * 0.42);
  /**
   * Inward normal. The sign matters and got this backwards first time round.
   *
   * For a screen-space square wound (0,0)→(1,0)→(1,1)→(0,1), `signedArea` is positive
   * and the top edge runs +x, so its INWARD normal has to be +y — down the screen, into
   * the shape. `(dy, -dx)` gives −y, which is outward, so every call in this file
   * quietly grew its polygon instead of shrinking it: four temple terraces got bigger as
   * they climbed and read as one dark slab, and the creek's deep water spilled past its
   * own banks and read as asphalt.
   */
  const normals = points.map((_, i) => {
    const a = points[i];
    const b = points[(i + 1) % count];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: (-dy / len) * sign, y: (dx / len) * sign };
  });
  return points.map((point, i) => {
    const n1 = normals[(i - 1 + count) % count];
    const n2 = normals[i];
    const bx = n1.x + n2.x;
    const by = n1.y + n2.y;
    const len = Math.hypot(bx, by) || 1;
    const ux = bx / len;
    const uy = by / len;
    // Miter length, floored so a near-reflex corner cannot fling a vertex away.
    const miter = Math.max(0.4, ux * n2.x + uy * n2.y);
    return { x: point.x + (ux * d) / miter, y: point.y + (uy * d) / miter };
  });
}

/**
 * Scale a polygon toward its own centroid.
 *
 * The companion to `inset`, for the case `inset` is deliberately bad at. Edge-normal
 * offsetting is correct for anything elongated but degenerates on a small skewed quad —
 * push it past the inradius and you get a wedge, which is how the temple's summit doorway
 * became a triangle and both serpent heads became little arrows. Centroid scaling cannot
 * degenerate: it is always the same shape, smaller. Use it for compact blocky detail and
 * `inset` for runs, banks and terraces.
 */
export function shrink(points: Vec2[], factor: number): Vec2[] {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x / points.length;
    cy += p.y / points.length;
  }
  return points.map((p) => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

/** Shift a polygon bodily. */
export function shift(points: Vec2[], dx: number, dy: number): Vec2[] {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

/**
 * A closed blob of `count` points around a centre, radius wobbled by `id`.
 *
 * The workhorse for everything natural. A boulder, a canopy crown, a pool and a
 * clearing are all this function with different radii and materials — which is the
 * useful discovery, because it means the natural world needs one authoring shape
 * (a centre, a radius, a seed) and not fifty hand-plotted vertices.
 */
export function blob(cx: number, cy: number, radius: number, id: string, wobble = 0.26, count = 13): Vec2[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    const r = radius * (1 - wobble / 2 + jitter(id, i) * wobble);
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  });
}

/**
 * A ribbon along a centreline: a creek, a trail, a rail bed.
 *
 * Returns one closed polygon by walking out one side and back the other, so a
 * meander is authored as four or five points and a width instead of as an outline.
 * This is the shape `Surface` cannot hold today, and the reason it cannot is the
 * whole reason a river is hard: `Surface = Rect & {id, kind}`.
 */
export function ribbon(spine: Vec2[], widthAt: (t: number) => number): Vec2[] {
  const normalAt = (i: number): Vec2 => {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(spine.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  };
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < spine.length; i += 1) {
    const t = spine.length === 1 ? 0 : i / (spine.length - 1);
    const half = widthAt(t) / 2;
    const n = normalAt(i);
    left.push({ x: spine[i].x + n.x * half, y: spine[i].y + n.y * half });
    right.push({ x: spine[i].x - n.x * half, y: spine[i].y - n.y * half });
  }
  return [...left, ...right.reverse()];
}

export function fillPoly(g: Graphics, points: Vec2[], color: number, alpha = 1): void {
  g.poly(points.map((p) => ({ x: p.x, y: p.y }))).fill({ color, alpha });
}

/** Ground, as a region rather than a rectangle. The one change everything else needs. */
export function groundPoly(g: Graphics, points: Vec2[], color: number): void {
  fillPoly(g, points, color);
}

/**
 * Speckle a ground region: gravel, litter, tussocks, patch repairs.
 *
 * The exterior already does this per surface kind — `yard` gets patch repairs,
 * `verge` gets planting blobs — so natural ground gets it the same way rather than
 * with a texture, because no raster ships.
 */
export function speckle(
  g: Graphics,
  points: Vec2[],
  id: string,
  opts: { color: number; count: number; size: [number, number]; alpha?: number },
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // Clipped to the region by drawing inside an inset copy, which is cheaper than a
  // mask and good enough when the speck is small next to the region.
  const held = inset(points, opts.size[1]);
  const clip = new Graphics();
  fillPoly(clip, held, 0xffffff);
  for (let i = 0; i < opts.count; i += 1) {
    const x = minX + jitter(id, i) * (maxX - minX);
    const y = minY + jitter(id, i + 91) * (maxY - minY);
    if (!inPoly({ x, y }, held)) continue;
    const r = opts.size[0] + jitter(id, i + 37) * (opts.size[1] - opts.size[0]);
    g.circle(x, y, r).fill({ color: opts.color, alpha: opts.alpha ?? 0.5 });
  }
  clip.destroy();
}

export function inPoly(point: Vec2, points: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Water: impassable, but recessed rather than raised
// ---------------------------------------------------------------------------

/**
 * Water, and the reason it is not just a dark polygon.
 *
 * Contract §3 has exactly one way of saying impassable — "dark, closed outlines mean
 * solid and impassable" — and it was written for things that stand UP. Water stops a
 * bot just as hard while going DOWN, and if it borrows the raised treatment the eye
 * reads a low black plinth. So the shading inverts: a raised solid is lit on its
 * north face and casts south-east, a recess is dark on its north-west inner wall and
 * lit on its south-east one, because the light passes over the near rim and lands on
 * the far one.
 *
 * That inversion is a genuinely new category in the language, and it is worth having:
 * once a recess reads as a recess, a cenote, a well, a flooded shaft, a ravine and a
 * quarry are all the same primitive.
 */
export function water(
  g: Graphics,
  points: Vec2[],
  id: string,
  opts: { deep?: number; shallow?: number; rim?: number; still?: boolean } = {},
): void {
  const deep = opts.deep ?? GROUND.deep;
  const shallow = opts.shallow ?? GROUND.shallow;
  const rim = opts.rim ?? 6;

  // Light comes from the north-west, so it lands on the far (south-east) inner wall.
  const toward = { x: 0.35, y: 1 };
  const len = Math.hypot(toward.x, toward.y);
  const lx = toward.x / len;
  const ly = toward.y / len;

  // The dark near wall is the whole silhouette, then the water is laid back into it
  // offset along the light: what stays showing is a thick shadow on the near rim and a
  // thin one on the far.
  fillPoly(g, points, shade(shallow, 0.52));
  fillPoly(g, shift(inset(points, rim * 0.5), lx * rim * 1.15, ly * rim * 1.15), shade(shallow, 1.14));
  fillPoly(g, shift(inset(points, rim * 1.6), lx * rim * 0.9, ly * rim * 0.9), shallow);
  fillPoly(g, inset(points, rim * 4.5), deep);

  // The resting surface: a few long, flat streaks. This is the still frame only — the
  // moving highlights live in `motion.ts`, because a body of water drawn frozen is
  // exactly the artefact the language's fourth rule names.
  // Skipped when the recess holds no water — a sunken stone court is the same
  // primitive with the same inverted shading and no surface to catch the light.
  for (let i = 0; i < (opts.still === false ? 0 : 5); i += 1) {
    const a = inset(points, rim * 6 + jitter(id, i) * 22);
    if (a.length < 3) break;
    const p = a[Math.floor(jitter(id, i + 12) * a.length) % a.length];
    const w = 26 + jitter(id, i + 24) * 60;
    g.roundRect(p.x - w / 2, p.y, w, 2.4, 1.2).fill({ color: shade(deep, 1.5), alpha: 0.3 });
  }

  // The impassable line, last and outermost, exactly as a wall does it.
  g.poly(points.map((p) => ({ x: p.x, y: p.y }))).stroke({ color: shade(deep, 0.6), width: 1.4 });
}

// ---------------------------------------------------------------------------
// Rock
// ---------------------------------------------------------------------------

/** A boulder: an irregular extruded mass. `volumeShape` already handles the rest. */
export function boulder(g: Graphics, pad: ShadowPad, cx: number, cy: number, radius: number, id: string): void {
  const shape = blob(cx, cy, radius, id, 0.38, 11);
  const lift = Math.min(26, 5 + radius * 0.3);
  contactShape(pad, shape, lift);
  const top = volumeShape(g, shape, radius > 44 ? NAT.rock : NAT.rockDark, lift);
  // One fracture plane, so a boulder is a broken thing rather than a pebble.
  const a = top[1 % top.length];
  const b = top[Math.floor(top.length / 2)];
  g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: shade(NAT.rock.front, 0.9), width: 1 });
}

/**
 * An outcrop or cliff mass, with a cave mouth optionally cut into one face.
 *
 * A cave is the answer to the real problem with a wilderness region: this game's
 * loot, floors, stairs and interiors all live in buildings, and a forest has none. A
 * cave is a building — a polygon outline, a rock shell, one floor — so it needs no
 * new engine concept at all. The mouth is a doorway, and the compiler already cuts
 * genuine absences of collision into a wall path.
 */
export function outcrop(
  g: Graphics,
  pad: ShadowPad,
  points: Vec2[],
  id: string,
  mouth?: { at: Vec2; width: number; depth: number },
): void {
  const lift = 30;
  contactShape(pad, points, lift);
  const top = volumeShape(g, points, NAT.rock, lift);
  /**
   * Bedding planes as CONTOURS, following the perimeter inward.
   *
   * The first version joined vertex `i` to vertex `i+5`, which draws chords straight
   * across the interior — so an outcrop came out looking like a wireframe mesh rather
   * than like stone. Strata seen from above follow the shape of the mass, so an inset
   * contour is both more accurate and the only version that reads as rock.
   */
  let contour = top;
  for (let i = 0; i < 4; i += 1) {
    contour = inset(contour, 13 + i * 4);
    if (contour.length < 3) break;
    g.poly(contour.map((p) => ({ x: p.x, y: p.y })))
      .stroke({ color: shade(NAT.rock.top, i % 2 === 0 ? 0.9 : 1.06), width: 1.1, alpha: 0.55 });
  }
  if (!mouth) return;
  // The mouth: a void, drawn as the absence it is. Deepest value in the world, so it
  // cannot be mistaken for a surface you can stand on.
  const cave = blob(mouth.at.x, mouth.at.y, mouth.width / 2, `${id}-mouth`, 0.2, 11);
  fillPoly(g, cave, GROUND.abyss);
  fillPoly(g, shift(inset(cave, mouth.width * 0.14), 0, -mouth.depth * 0.35), shade(GROUND.abyss, 0.65));
  g.poly(cave.map((p) => ({ x: p.x, y: p.y }))).stroke({ color: shade(NAT.rock.edge, 0.8), width: 1.5 });
}

// ---------------------------------------------------------------------------
// Overhead: the category the city never needed
// ---------------------------------------------------------------------------

/**
 * Ground shade under a canopy. Drawn with the ground, before anything stands on it.
 *
 * Split from the crown because they belong in different layers, and that split is the
 * important part: shade lies on the floor with the other shadows, the crown floats
 * ABOVE the bots. Contract §3's "the silhouette is the footprint" holds for everything
 * in Downtown because Downtown contains nothing you walk under. A canopy, a veranda
 * over a boardwalk and a water tower on legs all break it — the drawn shape is
 * overhead and the collider is four posts or nothing at all.
 *
 * That is not a problem with the rule so much as the rule having only ever met one
 * case. Overhead cover is worth the work: it is concealment from the camera, which in
 * a top-down game is the only kind of concealment there is.
 */
export function canopyShade(g: Graphics, cx: number, cy: number, radius: number, id: string): void {
  fillPoly(g, blob(cx + radius * 0.1, cy + radius * 0.14, radius, `${id}-sh`, 0.3), 0x000000, 0.13);
  for (let i = 0; i < 5; i += 1) {
    const a = jitter(id, i + 5) * Math.PI * 2;
    const d = radius * (0.2 + jitter(id, i + 15) * 0.6);
    g.circle(cx + Math.cos(a) * d + radius * 0.1, cy + Math.sin(a) * d + radius * 0.14, radius * 0.2)
      .fill({ color: 0x000000, alpha: 0.07 });
  }
}

/**
 * The crown itself, in an overhead layer above the actors.
 *
 * Same value ramp as the shipped street tree in `modelGlyphs.foliageMass` — outer
 * dark, inner light, ramp running north-west — because a forest that lights
 * differently from the street trees two hundred units away has its own private sun.
 * The one addition is `see`: a crown that hides a bot completely is a bot the player
 * has lost, so the mass stays translucent enough to read movement through.
 */
export function canopyCrown(g: Graphics, cx: number, cy: number, radius: number, id: string, see = 0.86): void {
  /**
   * Values, and why they are not the street tree's.
   *
   * `modelGlyphs.foliageMass` ramps a street tree from 0.46 to 0.84 of `MAT.foliage`,
   * which tops out DARKER than the footway it stands on — correct there, because a tree
   * on bright paving is a dark object. Reused unchanged on a forest floor it produced
   * nine grey masses indistinguishable from the boulders next to them, which is exactly
   * what the first render looked like.
   *
   * A forest inverts the relationship: the floor is in shade and the crown is the thing
   * catching the light. So the ramp goes ABOVE the foliage tone, and the ground it sits
   * on goes darker to meet it.
   */
  const under = shade(MAT.foliage.top, 0.7);
  const body = shade(MAT.foliage.top, 0.88);
  const lit = MAT.foliage.top;

  // The mass under the leaves, so gaps read as depth rather than as holes.
  fillPoly(g, blob(cx, cy, radius, `${id}-u`, 0.22, 15), under, see);

  /**
   * Then lobes, not concentric rings.
   *
   * Rings give a smooth dome lit from directly overhead — the one thing the language
   * forbids — and no amount of value ramp fixes the silhouette. A canopy is a handful of
   * branch masses at different heights, so each lobe gets its own position and takes its
   * value from where it sits relative to the light: north-west lobes are the ones the
   * sun reaches.
   */
  /**
   * Lobes big enough to MERGE, and a value range narrow enough to stay one mass.
   *
   * The version before this one used discrete lobes at 0.66/0.94/1.14 with an extra
   * highlight pass on top, and it came out as popcorn: white clumps sitting on grey,
   * reading as cauliflower rather than as a tree. Two things were wrong and both are
   * about restraint. The lobes were small relative to the crown, so the silhouette was
   * lumpy instead of continuous; and the top of the ramp went well above the foliage
   * tone, so the brightest leaves stopped belonging to the same material as the rest.
   *
   * So: fewer, larger, overlapping lobes, and the ramp tops out AT `MAT.foliage`, never
   * above it. Light separates the lobes; it does not bleach them.
   */
  const lobes = Math.max(5, Math.round(radius / 30));
  for (let i = 0; i < lobes; i += 1) {
    const angle = (i / lobes) * Math.PI * 2 + jitter(id, i + 3) * 0.7;
    const dist = radius * (0.16 + jitter(id, i + 13) * 0.34);
    const lx = cx + Math.cos(angle) * dist;
    const ly = cy + Math.sin(angle) * dist;
    // How much this lobe faces the light, north-slightly-west, as a 0..1.
    const facing = (Math.cos(angle) * -0.33 + Math.sin(angle) * -0.94 + 1) / 2;
    const size = radius * (0.5 + jitter(id, i + 23) * 0.18);
    fillPoly(
      g,
      blob(lx, ly - size * 0.08, size, `${id}-l${i}`, 0.3, 11),
      facing > 0.58 ? lit : facing > 0.3 ? body : under,
      see,
    );
  }

  /**
   * Fray the rim.
   *
   * The lobes alone still gave a closed polygonal silhouette, and a closed polygonal
   * silhouette in this language means ROCK — which is why the crowns kept reading as
   * boulders however the values were tuned. Value was never the problem; the outline was.
   * Leaves break up at the edge, so a scatter of small discs across the rim is what
   * separates a tree from a stone.
   */
  for (let i = 0; i < 18; i += 1) {
    const angle = (i / 18) * Math.PI * 2 + jitter(id, i + 90) * 0.5;
    const reach = radius * (0.82 + jitter(id, i + 100) * 0.26);
    const facing = (Math.cos(angle) * -0.33 + Math.sin(angle) * -0.94 + 1) / 2;
    g.circle(
      cx + Math.cos(angle) * reach,
      cy + Math.sin(angle) * reach,
      radius * (0.09 + jitter(id, i + 110) * 0.1),
    ).fill({ color: facing > 0.55 ? lit : facing > 0.28 ? body : under, alpha: see });
  }
}

/** The trunk, on the ground layer, where the collider is. A crown with no trunk floats. */
export function trunk(g: Graphics, pad: ShadowPad, cx: number, cy: number, radius: number): void {
  contactRound(pad, cx, cy, radius, 14);
  cylinder(g, cx, cy, radius, NAT.timberDark, 5);
  // Root flare, inside the collider, so nothing that looks solid sits outside it.
  g.circle(cx, cy, radius * 0.62).stroke({ color: shade(NAT.timberDark.front, 0.85), width: 0.9 });
}

/**
 * A roof over public ground: a veranda, an awning, a rock overhang.
 *
 * Overhead like a canopy, but man-made, so it has an edge and posts. The posts are
 * the collider; the deck is not. Draw it in the overhead layer.
 */
export function overheadDeck(g: Graphics, r: Rect, id: string, see = 0.9): void {
  const m = NAT.timber;
  g.rect(r.x, r.y, r.w, r.h).fill({ color: shade(m.top, 0.86), alpha: see });
  // Boards run across the span, the way a veranda is actually framed.
  const boards = Math.max(3, Math.round(r.h / 13));
  for (let i = 1; i < boards; i += 1) {
    const y = r.y + (r.h / boards) * i;
    g.moveTo(r.x, y).lineTo(r.x + r.w, y).stroke({ color: shade(m.top, 0.72), width: 0.7, alpha: see });
  }
  // Its own shadow, cast onto whatever is below. This is what sells "over".
  g.rect(r.x + 5, r.y + r.h, r.w, 9).fill({ color: 0x000000, alpha: 0.12 * see });
  g.rect(r.x, r.y, r.w, r.h).stroke({ color: m.edge, width: 1.2, alpha: see });
  void id;
}

/** A post: small, solid, and the only part of an overhead thing you can bump into. */
export function post(g: Graphics, pad: ShadowPad, cx: number, cy: number, radius = 6): void {
  contactRound(pad, cx, cy, radius, 16);
  cylinder(g, cx, cy, radius, NAT.timber, 5);
}

// ---------------------------------------------------------------------------
// Passable, but not see-through: the other new category
// ---------------------------------------------------------------------------

/**
 * Thicket: walk through it, but you cannot see through it.
 *
 * The passable contract (§3, and #54) says a passable object must be see-through and
 * draw no lift and no shadow — written for coverings, decals, kerbs and spills, all
 * of which are harmless. Brush is passable and NOT harmless: it breaks line of sight,
 * which makes it the most interesting cover in a forest and the exact thing the city
 * has no vocabulary for.
 *
 * So it takes a third treatment: hazed like a passable object, because you can enter
 * it, but dense and edge-marked, because entering it has consequences. If a region
 * with brush is chosen, this needs a real rule in the contract, not a glyph.
 */
export function thicket(g: Graphics, points: Vec2[], id: string): void {
  fillPoly(g, points, GROUND.scrub, 0.9);
  const centre = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
  let extent = 0;
  for (const p of points) extent = Math.max(extent, Math.hypot(p.x - centre.x, p.y - centre.y));
  // Mass built from overlapping lobes at low alpha: it obscures without hiding, so a
  // bot inside is a shape you can half-see rather than a bot that vanished.
  for (let i = 0; i < 26; i += 1) {
    const a = jitter(id, i) * Math.PI * 2;
    const d = extent * Math.sqrt(jitter(id, i + 40)) * 0.92;
    const x = centre.x + Math.cos(a) * d;
    const y = centre.y + Math.sin(a) * d;
    if (!inPoly({ x, y }, points)) continue;
    const r = extent * (0.13 + jitter(id, i + 60) * 0.16);
    g.circle(x, y, r).fill({ color: shade(MAT.foliage.top, 0.58), alpha: 0.36 });
    g.circle(x - r * 0.2, y - r * 0.24, r * 0.6).fill({ color: shade(MAT.foliage.top, 0.78), alpha: 0.3 });
  }
  // A dashed edge: passable, so no closed dark line, but it has a boundary that
  // matters and a player must be able to see where it starts.
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 15));
    for (let s = 0; s < steps; s += 2) {
      const t0 = s / steps;
      const t1 = Math.min(1, (s + 1) / steps);
      g.moveTo(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0)
        .lineTo(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1)
        .stroke({ color: shade(MAT.foliage.top, 0.42), width: 1.3, alpha: 0.7 });
    }
  }
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * A stepped mass: terraces stacked to make real height out of ground.
 *
 * This is the primitive the engine most conspicuously lacks. Everything outdoors sits
 * on one plane, and building floors are the only place height exists — so a terrace,
 * a canyon rim, a levee and a temple platform are all currently unrepresentable.
 * Drawing it is easy; what it implies is not, because if a bot can STAND on a terrace
 * then the outdoor plane has become plural and vision, navigation and the physics
 * floor id all have to agree about which level a bot is on.
 *
 * `MAX_BLOCK_LIFT` is 124, so about five terraces of apparent height is the ceiling
 * before the plan starts drifting toward isometric.
 */
export function steppedMass(
  g: Graphics,
  pad: ShadowPad,
  base: Vec2[],
  id: string,
  opts: { steps: number; inset: number; lift: number; material?: Material },
): Vec2[] {
  const m = opts.material ?? NAT.stoneWorn;
  contactShape(pad, base, opts.lift * 1.4);
  let shape = base;
  for (let i = 0; i < opts.steps; i += 1) {
    // Each riser casts onto the terrace below it: that shadow is the only thing
    // that makes a step read as a step rather than as a concentric outline.
    fillPoly(g, shift(inset(shape, opts.inset), 3.5, 7), 0x000000, 0.1);
    shape = inset(shape, opts.inset);
    const tone = i === opts.steps - 1 ? m : mat(shade(m.top, 1 - i * 0.02));
    shape = volumeShape(g, shape, tone, opts.lift);
    void id;
  }
  return shape;
}

/**
 * A monumental stair: wide, outdoors, and part of the terrain rather than a building.
 *
 * Authored as a climb AXIS rather than a rectangle, so a flight can face any
 * direction. That is not gold-plating — a complex laid out on its own axis instead of
 * the sheet's is most of what makes it stop looking like a city block, and a
 * rect-only stair would have quietly forced the whole thing back onto the grid.
 *
 * Treads are drawn from the bottom up so a nearer tread overlaps the one behind it,
 * which is what stacks a flight instead of tiling it.
 */
export function grandStair(
  g: Graphics,
  pad: ShadowPad,
  foot: Vec2,
  head: Vec2,
  halfWidth: number,
  opts: { steps: number; lift: number; material?: Material },
): void {
  const m = opts.material ?? NAT.stoneWorn;
  const dx = head.x - foot.x;
  const dy = head.y - foot.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const quad = (t0: number, t1: number, half: number): Vec2[] => [
    { x: foot.x + ux * len * t0 + nx * half, y: foot.y + uy * len * t0 + ny * half },
    { x: foot.x + ux * len * t1 + nx * half, y: foot.y + uy * len * t1 + ny * half },
    { x: foot.x + ux * len * t1 - nx * half, y: foot.y + uy * len * t1 - ny * half },
    { x: foot.x + ux * len * t0 - nx * half, y: foot.y + uy * len * t0 - ny * half },
  ];
  contactShape(pad, quad(0, 1, halfWidth), opts.lift);

  const riser = Math.max(2.5, opts.lift / opts.steps);
  for (let i = opts.steps - 1; i >= 0; i -= 1) {
    const t0 = i / opts.steps;
    const t1 = (i + 1) / opts.steps;
    // A monumental flight narrows as it climbs; that taper is most of the height cue.
    volumeShape(g, quad(t0, t1 + 0.004, halfWidth * (1 - t0 * 0.12)), m, riser);
  }
  // Balustrades, so the flight has sides and the climb has a direction.
  for (const side of [-1, 1]) {
    const off = halfWidth + 7;
    volumeShape(g, [
      { x: foot.x + nx * off * side, y: foot.y + ny * off * side },
      { x: head.x + nx * (off - 3) * side, y: head.y + ny * (off - 3) * side },
      { x: head.x + nx * (off - 15) * side, y: head.y + ny * (off - 15) * side },
      { x: foot.x + nx * (off - 13) * side, y: foot.y + ny * (off - 13) * side },
    ], NAT.stone, 13);
  }
}

// ---------------------------------------------------------------------------
// Small natural solids
// ---------------------------------------------------------------------------

/** A fallen trunk. A capsule in the physics, so a capsule in the drawing. */
export function deadfall(g: Graphics, pad: ShadowPad, a: Vec2, b: Vec2, radius: number, id: string): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * radius;
  const ny = (dx / len) * radius;
  const shape = [
    { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
  ];
  contactShape(pad, shape, 12);
  const top = volumeShape(g, shape, NAT.timberDark, 12);
  // Bark split down the length, and the broken end lighter than the bark.
  const m0 = { x: (top[0].x + top[3].x) / 2, y: (top[0].y + top[3].y) / 2 };
  const m1 = { x: (top[1].x + top[2].x) / 2, y: (top[1].y + top[2].y) / 2 };
  g.moveTo(m0.x, m0.y).lineTo(m1.x, m1.y).stroke({ color: shade(NAT.timberDark.top, 0.86), width: 1.2 });
  g.circle(b.x, b.y, radius * 0.72).fill({ color: shade(NAT.timber.top, 1.04) });
  void id;
}

/** A rail-and-post fence: a corral, a paddock, a boundary. Posts collide; rails read. */
export function railFence(g: Graphics, pad: ShadowPad, points: Vec2[], closed: boolean, id: string): void {
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const spans = Math.max(1, Math.round(len / 96));
    for (let s = 0; s <= spans; s += 1) {
      if (s === spans && i !== count - 1) continue;
      const t = s / spans;
      post(g, pad, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 6.5);
    }
    // Two rails, drawn as thin volumes so they read as timber at play zoom.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const nx = (-dy / len) * 2.4;
    const ny = (dx / len) * 2.4;
    for (const off of [-3.5, 3.5]) {
      fillPoly(g, [
        { x: a.x + nx + (nx / 2.4) * off, y: a.y + ny + (ny / 2.4) * off },
        { x: b.x + nx + (nx / 2.4) * off, y: b.y + ny + (ny / 2.4) * off },
        { x: b.x - nx + (nx / 2.4) * off, y: b.y - ny + (ny / 2.4) * off },
        { x: a.x - nx + (nx / 2.4) * off, y: a.y - ny + (ny / 2.4) * off },
      ], off < 0 ? NAT.timber.top : NAT.timber.front);
    }
  }
  void id;
}

/** Wheel ruts worn into dust. Flat, so they mean passable, exactly like floor marks. */
export function ruts(g: Graphics, spine: Vec2[], gauge: number, id: string): void {
  for (const side of [-gauge / 2, gauge / 2]) {
    const line = spine.map((p, i) => ({ x: p.x + side + (jitter(id, i) - 0.5) * 7, y: p.y }));
    for (let i = 0; i < line.length - 1; i += 1) {
      g.moveTo(line[i].x, line[i].y).lineTo(line[i + 1].x, line[i + 1].y)
        .stroke({ color: shade(GROUND.earth, 0.9), width: 7, alpha: 0.55 });
    }
  }
}
