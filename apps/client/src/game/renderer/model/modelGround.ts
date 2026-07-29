import { Graphics } from "pixi.js";
import type { GroundRegion, Vec2 } from "@dotbot/game/types";
import { insetPolygon, polygonBounds, polygonContains } from "@dotbot/game/geometry";
import { jitter, shade } from "./tone";

/**
 * Ground that is not a rectangle, and the values a world outside a city runs on.
 *
 * `modelOutdoor` draws the five urban surface kinds; this draws the rest, and the
 * split is by shape rather than by subject. A city block IS a rectangle, so a rect
 * is the honest primitive for one. A clearing, a shoreline, the apron of ballast
 * round a turntable and the weeds coming up through a midway are not, and drawing
 * them as rectangles is exactly how the first pass at three non-city regions came
 * out looking like a recoloured city.
 *
 * One value scale for the whole world. `modelOutdoor`'s runs forecourt → footway →
 * yard → asphalt → verge → void, lightest to darkest, following real albedo; these
 * slot into the same ramp rather than starting a second one. Dry dust is bright like
 * fresh paving, wet rock is dark like tarmac, standing water is nearly the void.
 */

export const GRD = {
  /** Dry dust and sand. The brightest ground in the game — dry land reads hot. */
  dust: 0xd9d5cb,
  /** Beaten earth: a trail, a clearing, a court worn back to soil. */
  earth: 0xc9c4b9,
  /** River gravel and shingle, cool where dust is warm. */
  gravel: 0xcfd0cd,
  /** Cut stone, worn. Between footway and yard, because that is what it is. */
  flag: 0xcbccc8,
  /**
   * Wild vegetation under its own shade: leaf litter, bramble, forest floor.
   *
   * The dark end, and this is the value a whole region hangs off. A first pass had
   * it at 0xb6b4a9, a few steps from the tree crowns and the boulders standing on
   * it, and the sheet came out as one beige field with grey lumps in it.
   * Undergrowth is genuinely in shade — that is what a canopy does — and giving the
   * ground the dark end is what lets a sunlit crown be the bright thing.
   */
  humus: 0x8f8d84,
  /** Ballast: crushed stone, sharp and dry, a touch darker than a public footway. */
  ballast: 0xc3c5c4,
  /** Cinders and ash trodden into a track bed. */
  cinder: 0x9fa1a0,
  /** Scrub and low brush, matching the city's verge so planting reads the same. */
  scrub: 0x99a09a,
  /** Shallow water over a bright bed. */
  shallow: 0x9ba4a9,
  /**
   * Water with depth under it.
   *
   * Darker than the city's asphalt on purpose. At 0x6f777d it sat four steps from
   * `OUT.asphalt` and a straight reach of creek read as a carriageway: the shape
   * said river, the value said road, and the value won.
   */
  deep: 0x565e64,
  /** A sinkhole, a well, a flooded shaft: the darkest value the world contains. */
  abyss: 0x474d52,
} as const;

// ---------------------------------------------------------------------------
// Polygon drawing
// ---------------------------------------------------------------------------

export function fillPoly(g: Graphics, points: Vec2[], color: number, alpha = 1): void {
  if (points.length < 3) return;
  g.poly(points.map((p) => ({ x: p.x, y: p.y }))).fill({ color, alpha });
}

/**
 * Scatter marks over a region: gravel, litter, tussocks, patch repairs.
 *
 * The same idea `modelOutdoor` already uses per surface kind — a yard gets patch
 * repairs, a verge gets planting blobs — because no raster ships and a texture is
 * not available. Marks are held inside an inset copy of the region so nothing spills
 * over an edge; that is cheaper than a mask and exact enough while a speck is small
 * next to the shape holding it.
 */
export function speckle(
  g: Graphics,
  points: Vec2[],
  id: string,
  opts: { color: number; count: number; size: [number, number]; alpha?: number },
): void {
  const held = insetPolygon(points, opts.size[1]);
  if (held.length < 3) return;
  const bounds = polygonBounds(points);
  for (let i = 0; i < opts.count; i += 1) {
    const x = bounds.x + jitter(id, i) * bounds.w;
    const y = bounds.y + jitter(id, i + 91) * bounds.h;
    if (!polygonContains(held, { x, y })) continue;
    const r = opts.size[0] + jitter(id, i + 37) * (opts.size[1] - opts.size[0]);
    g.circle(x, y, r).fill({ color: opts.color, alpha: opts.alpha ?? 0.5 });
  }
}

/**
 * A frayed edge, so a natural region does not end on a drawn line.
 *
 * This is the single cheapest thing that separates ground from a diagram. A polygon
 * filled and left alone has a hard vector boundary, and a hard boundary in this
 * language means SOLID — a closed dark outline is the one way the world says
 * impassable. The same lesson landed the other way round on foliage: crowns kept
 * reading as boulders until their outlines were broken up, whatever value they were.
 */
function fray(g: Graphics, points: Vec2[], id: string, color: number, size: number, alpha = 1): void {
  const count = points.length;
  let index = 0;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % count];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.round(span / (size * 1.35)));
    for (let s = 0; s < steps; s += 1) {
      const t = (s + 0.5) / steps;
      const r = size * (0.5 + jitter(id, index += 1) * 0.85);
      g.circle(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r).fill({ color, alpha });
    }
  }
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * Water, and the reason it is not just a dark polygon.
 *
 * The language has exactly one way of saying impassable — a dark closed outline —
 * and it was written for things that stand UP. Water goes DOWN, and borrowing the
 * raised treatment makes a pond read as a low black plinth. So the shading inverts:
 * a raised solid is lit on its north face and casts to the south-east, while a
 * recess is dark on its near (north-west) inner wall and lit on its far (south-east)
 * one, because the light passes over the near rim and lands on the far one.
 *
 * That inversion is a genuinely new category in the language and it is worth having
 * on its own: once a recess reads as a recess, a cenote, a well, a flooded shaft and
 * a quarry are all one primitive.
 *
 * What it does NOT do is imply collision. `SurfaceKind`'s note on `water` carries
 * the reasoning: a bot wades, and anything that must stop one is authored as visible
 * solid geometry beside the water.
 */
export function drawWater(g: Graphics, points: Vec2[], id: string, rim = 7): void {
  // North-west light, so it lands on the far inner wall.
  const toward = { x: 0.33, y: 0.94 };

  fillPoly(g, points, shade(GRD.shallow, 0.58));
  fillPoly(g, shift(insetPolygon(points, rim * 0.5), toward, rim * 1.15), shade(GRD.shallow, 1.14));
  fillPoly(g, shift(insetPolygon(points, rim * 1.6), toward, rim * 0.9), GRD.shallow);
  fillPoly(g, insetPolygon(points, rim * 3.8), GRD.deep);

  /**
   * The resting surface: a few short, curved, sparse streaks.
   *
   * Short and broken because long straight highlights down the middle of a dark
   * channel are lane markings — which is precisely what the first render of a creek
   * looked like. What separates water from asphalt is that the highlight is broken,
   * not that it is bright.
   */
  const held = insetPolygon(points, rim * 5);
  if (held.length >= 3) {
    const bounds = polygonBounds(held);
    for (let i = 0; i < 9; i += 1) {
      const at = {
        x: bounds.x + jitter(id, i + 3) * bounds.w,
        y: bounds.y + jitter(id, i + 61) * bounds.h,
      };
      if (!polygonContains(held, at)) continue;
      const w = 14 + jitter(id, i + 24) * 30;
      const lean = (jitter(id, i + 44) - 0.5) * 9;
      g.moveTo(at.x - w / 2, at.y + lean * 0.4)
        .quadraticCurveTo(at.x, at.y - lean, at.x + w / 2, at.y + lean * 0.4)
        .stroke({ color: shade(GRD.deep, 1.62), width: 1.5, alpha: 0.28, cap: "round" });
    }
  }
}

function shift(points: Vec2[], dir: Vec2, by: number): Vec2[] {
  return points.map((p) => ({ x: p.x + dir.x * by, y: p.y + dir.y * by }));
}

// ---------------------------------------------------------------------------
// Regions, by what the ground is for
// ---------------------------------------------------------------------------

/**
 * One region.
 *
 * Same contract as `drawSurface` in `modelOutdoor`: the map says what the ground is
 * FOR and this decides how that use LOOKS. The five urban kinds are handled there
 * and fall through to a plain fill here, because a plaza authored as a polygon is
 * still a plaza and should not acquire a second treatment by changing shape.
 */
export function drawRegion(g: Graphics, region: GroundRegion): void {
  const { points, id } = region;
  if (points.length < 3) return;

  switch (region.kind) {
    case "ballast": {
      /**
       * A track bed reads as a bed rather than as a path because of its SHOULDERS.
       * Ballast is dumped and graded, so it is proud of the ground either side and
       * falls away at the edges — which is what the frayed dark rim is. Without it
       * a siding apron is a grey polygon.
       */
      fillPoly(g, points, GRD.cinder);
      fillPoly(g, insetPolygon(points, 7), GRD.ballast);
      speckle(g, points, `${id}-stone`, { color: shade(GRD.ballast, 1.1), count: 190, size: [1.6, 4.4], alpha: 0.55 });
      speckle(g, points, `${id}-oil`, { color: GRD.cinder, count: 26, size: [7, 20], alpha: 0.32 });
      fray(g, points, `${id}-shoulder`, GRD.cinder, 5, 0.75);
      break;
    }

    case "clearing": {
      // Bare trodden earth. Brighter than the undergrowth it is cut out of, because
      // that difference IS the clearing: light gets in where the growth stops.
      fillPoly(g, points, GRD.earth);
      speckle(g, points, `${id}-worn`, { color: shade(GRD.earth, 1.07), count: 42, size: [10, 34], alpha: 0.4 });
      speckle(g, points, `${id}-grit`, { color: shade(GRD.earth, 0.87), count: 90, size: [1.4, 3.6], alpha: 0.45 });
      fray(g, points, `${id}-edge`, GRD.scrub, 7, 0.5);
      break;
    }

    case "undergrowth": {
      fillPoly(g, points, GRD.humus);
      /**
       * Two sizes of mass, and the LIGHT one is the smaller of the two.
       *
       * The first pass had it the other way round — 120 large blobs at 1.14 of the base
       * with 46 more at 1.3 on top — and the whole southern half of the world came out as
       * pale dirt with grey lumps on it. Undergrowth is the darkest ground in the world;
       * what the highlights are for is the odd leaf catching the light through a canopy,
       * and there are not many of those. Most of the marks are darker than the floor.
       */
      /**
       * DENSE and SMALL. At 150 marks of radius 18-52 the forest floor came out as a flat
       * field with soft blotches on it, and a blotch reads as a stain — something spilled
       * on a surface rather than the surface itself. Leaf litter is thousands of small
       * things, so the count goes up an order of magnitude and the size comes down.
       */
      speckle(g, points, `${id}-mass`, { color: shade(GRD.humus, 0.9), count: 340, size: [7, 20], alpha: 0.3 });
      speckle(g, points, `${id}-leaf`, { color: shade(GRD.humus, 0.76), count: 620, size: [2, 7], alpha: 0.4 });
      speckle(g, points, `${id}-lit`, { color: shade(GRD.humus, 1.22), count: 90, size: [2, 6], alpha: 0.3 });
      fray(g, points, `${id}-edge`, shade(GRD.humus, 0.9), 9, 0.85);
      break;
    }

    case "court": {
      /**
       * Dressed stone laid for ceremony. Flags rather than joints: a saw-cut slab
       * grid is a modern pour, and the difference between the two is the difference
       * between a plaza and a temple court.
       */
      fillPoly(g, points, GRD.flag);
      const bounds = polygonBounds(points);
      const bay = 88;
      for (let x = Math.ceil(bounds.x / bay) * bay; x < bounds.x + bounds.w; x += bay) {
        g.rect(x - 1, bounds.y, 2, bounds.h).fill({ color: shade(GRD.flag, 0.9), alpha: 0.4 });
      }
      for (let y = Math.ceil(bounds.y / bay) * bay; y < bounds.y + bounds.h; y += bay) {
        g.rect(bounds.x, y - 1, bounds.w, 2).fill({ color: shade(GRD.flag, 0.9), alpha: 0.4 });
      }
      /**
       * Flags lift and sink over centuries, and moss gets into every joint.
       *
       * RECTANGLES, on the bay grid, because a flag is rectangular and a round mark on a
       * flagged court reads as a stain on it. The first pass used circles at radius 20-52
       * and the plaza came out as pale concrete with something spilled all over it.
       */
      for (let i = 0; i < 90; i += 1) {
        const col = Math.floor(jitter(`${id}f`, i) * (bounds.w / bay));
        const row = Math.floor(jitter(`${id}f`, i + 71) * (bounds.h / bay));
        const at = {
          x: Math.ceil(bounds.x / bay) * bay + col * bay,
          y: Math.ceil(bounds.y / bay) * bay + row * bay,
        };
        if (!polygonContains(points, { x: at.x + bay / 2, y: at.y + bay / 2 })) continue;
        const lift = jitter(`${id}f`, i + 33);
        g.rect(at.x + 2, at.y + 2, bay - 4, bay - 4)
          .fill({ color: shade(GRD.flag, lift > 0.7 ? 1.05 : 0.92), alpha: 0.42 });
      }
      speckle(g, points, `${id}-moss`, { color: GRD.scrub, count: 260, size: [3, 11], alpha: 0.34 });
      break;
    }

    case "water":
      drawWater(g, points, id);
      break;

    // The urban five keep their own treatment in `modelOutdoor`; a polygon does not
    // earn a plaza a second look.
    case "footway":
    case "plaza":
      fillPoly(g, points, 0xd5d8db);
      break;
    case "forecourt":
      fillPoly(g, points, 0xdee1e4);
      break;
    case "yard":
      fillPoly(g, points, 0xbfc3c6);
      speckle(g, points, `${id}-patch`, { color: 0xb2b6ba, count: 30, size: [16, 44], alpha: 0.5 });
      break;
    case "verge":
      fillPoly(g, points, 0x9aa09b);
      speckle(g, points, `${id}-plant`, { color: 0x878d88, count: 80, size: [4, 13], alpha: 0.45 });
      break;
  }
}

/** Every region on the map, in order, so a later one may lap over an earlier one. */
export function drawRegions(g: Graphics, regions: readonly GroundRegion[]): void {
  for (const region of regions) drawRegion(g, region);
}
