import { Container, Graphics } from "pixi.js";
import type { Item, PowerupType, Vec2 } from "@dotbot/game/types";
import { CORE_REACH } from "@dotbot/game/shields";
import {
  MAT,
  contact,
  contactRound,
  contactShape,
  cylinder,
  inlay,
  jitter,
  seam,
  shade,
  volume,
  volumeShape,
  type Rect,
  type ShadowPad,
} from "../../game/renderer/model/tone";
import { drawBodyOutline, drawChargedCore, drawPlates } from "../../game/renderer/bodies";
import { drawDotDisc, drawDotGloss, drawDotMark } from "../../game/renderer/dotArt";
import {
  GROUND,
  NAT,
  blob,
  boulder,
  canopyCrown,
  canopyShade,
  fillPoly,
  grandStair,
  groundPoly,
  inset,
  post,
  ribbon,
  ruts,
  shrink,
  speckle,
  steppedMass,
  thicket,
  trunk,
  water,
} from "./terrain";
import { drawDrift, drawStillWater } from "./motion";

/**
 * Three candidate regions, drawn in the production language.
 *
 * The second attempt, and the first one's failure is worth writing down: it was built out
 * of TERRAIN — a creek, a stepped mass, a dust street — and terrain does not make a
 * place. "They don't feel like anything in particular" was exactly right. A generic
 * wooded ravine says nothing, because what makes somewhere recognisable is not its ground
 * cover but its LANDMARKS: the specific, nameable objects you could not mistake for
 * anything else.
 *
 * So these are authored landmark-first. Each region is a short list of things you can
 * name at a glance, and the ground exists to hold them. A corollary showed up on its own
 * and is worth keeping: the forms that survive a strict overhead view are the RADIAL
 * ones — a turntable, a carousel, a roundhouse fan, a round observatory. A vertical wheel
 * seen from straight above is a line, and faking the circle would need a perspective this
 * language does not have and should not get.
 *
 * All three carry a strip of the city at one edge. A region you cannot walk into from
 * Downtown is a second game, and that seam is the hardest part of any of them.
 */

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type WorldLayers = {
  /** Ground regions and anything flat. Built once. */
  ground: Graphics;
  /** Cast shadow, between the ground and the things standing on it. Built once. */
  shadow: ShadowPad;
  /** Everything with height. Built once. */
  solids: Graphics;
  /** Cleared and redrawn every frame: water surfaces, drifting matter. */
  motion: Graphics;
  /** Bots and Dots. */
  actors: Graphics;
  /**
   * Above the actors: roofs over open ground, gantries, canopy.
   *
   * A `Container`, so each overhead mass is its own node. This is the category Downtown
   * never needed — the city has nothing you walk under — and all three regions lean on it
   * hard, which is the clearest single engine consequence of leaving the block.
   */
  overhead: Container;
};

export type Vignette = {
  id: string;
  title: string;
  strapline: string;
  width: number;
  height: number;
  /** The named things. If they cannot be listed, the region does not read. */
  landmarks: string[];
  /** What it asks the engine for that Downtown never did. */
  asks: string[];
  draw: (layers: WorldLayers) => void;
  animate?: (layers: WorldLayers, tMs: number) => void;
};

const SQUAD = 0x22b8cf;
const RIVAL = 0xe03131;
const HULL = 0x14171a;

function bot(g: Graphics, at: Vec2, facing: number, color: number, shields: number[] = [1, 1, 1]): void {
  const body = { position: at, radius: 24, facing, shieldSegments: shields };
  drawPlates(g, body, color, false);
  drawBodyOutline(g, body);
  drawChargedCore(g, at, 24 * CORE_REACH, 1, HULL);
}

function loot(g: Graphics, at: Vec2, type: PowerupType): void {
  const item: Item = { kind: "powerup", type };
  drawDotDisc(g, at, 16, 0x2f9e44);
  drawDotMark(g, item, at, 16);
  drawDotGloss(g, at, 16);
}

function poly(r: Rect): Vec2[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** A quad from a centre point, an axis and a half-width. Everything radial needs it. */
function bar(at: Vec2, dir: Vec2, halfLen: number, halfWide: number): Vec2[] {
  const nx = -dir.y;
  const ny = dir.x;
  return [
    { x: at.x + dir.x * halfLen + nx * halfWide, y: at.y + dir.y * halfLen + ny * halfWide },
    { x: at.x - dir.x * halfLen + nx * halfWide, y: at.y - dir.y * halfLen + ny * halfWide },
    { x: at.x - dir.x * halfLen - nx * halfWide, y: at.y - dir.y * halfLen - ny * halfWide },
    { x: at.x + dir.x * halfLen - nx * halfWide, y: at.y + dir.y * halfLen - ny * halfWide },
  ];
}

function rotator(pivot: Vec2, radians: number) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const one = (p: Vec2): Vec2 => {
    const dx = p.x - pivot.x;
    const dy = p.y - pivot.y;
    return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
  };
  return { one, many: (points: Vec2[]): Vec2[] => points.map(one) };
}

function overheadPiece(layers: WorldLayers, id: string, paint: (g: Graphics) => void): void {
  const piece = new Graphics();
  piece.label = id;
  paint(piece);
  layers.overhead.addChild(piece);
}

function tree(layers: WorldLayers, x: number, y: number, radius: number, id: string, see = 0.88): void {
  canopyShade(layers.ground, x, y, radius, id);
  trunk(layers.solids, layers.shadow, x, y, Math.max(9, radius * 0.088));
  overheadPiece(layers, id, (g) => canopyCrown(g, x, y, radius, id, see));
}

/**
 * A rail road: sleepers, then two running rails over them.
 *
 * Flat, so it means passable, exactly like a floor mark. The bright crown on each rail is
 * what makes it read as steel — a railway drawn as two dark lines reads as a kerb.
 */
function rails(g: Graphics, a: Vec2, b: Vec2, gauge = 46): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const nx = -uy;
  const ny = ux;
  const sleepers = Math.max(1, Math.round(len / 32));
  for (let s = 0; s < sleepers; s += 1) {
    const t = (s + 0.5) / sleepers;
    const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    fillPoly(g, bar(at, { x: ux, y: uy }, 5.5, gauge * 0.8), shade(NAT.timberDark.top, 0.84), 0.92);
  }
  for (const side of [-gauge / 2, gauge / 2]) {
    g.moveTo(a.x + nx * side, a.y + ny * side).lineTo(b.x + nx * side, b.y + ny * side)
      .stroke({ color: shade(MAT.steel.top, 1.14), width: 3.6 });
    g.moveTo(a.x + nx * side, a.y + ny * side).lineTo(b.x + nx * side, b.y + ny * side)
      .stroke({ color: shade(MAT.steelDeep.top, 0.78), width: 1.1 });
  }
}

/** Corrugated sheet across a roof polygon, plus a ridge down the middle. */
function corrugate(g: Graphics, quad: Vec2[], ribs: number, tone: number, ridge = true): void {
  for (let s = 1; s < ribs; s += 1) {
    const t = s / ribs;
    const p0 = { x: quad[0].x + (quad[1].x - quad[0].x) * t, y: quad[0].y + (quad[1].y - quad[0].y) * t };
    const p1 = { x: quad[3].x + (quad[2].x - quad[3].x) * t, y: quad[3].y + (quad[2].y - quad[3].y) * t };
    g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y).stroke({ color: tone, width: 1.1 });
  }
  if (!ridge) return;
  const mid0 = { x: (quad[0].x + quad[3].x) / 2, y: (quad[0].y + quad[3].y) / 2 };
  const mid1 = { x: (quad[1].x + quad[2].x) / 2, y: (quad[1].y + quad[2].y) / 2 };
  g.moveTo(mid0.x, mid0.y).lineTo(mid1.x, mid1.y).stroke({ color: shade(tone, 0.72), width: 6.5 });
}

// ---------------------------------------------------------------------------
// Shared: the city seam
// ---------------------------------------------------------------------------

function citySeam(
  layers: WorldLayers,
  opts: { asphalt: Rect; wall: Vec2[]; gap?: { at: Vec2; width: number } },
): void {
  const { ground, shadow, solids } = layers;
  ground.rect(opts.asphalt.x, opts.asphalt.y, opts.asphalt.w, opts.asphalt.h).fill({ color: 0xa4a8ad });
  ground.rect(opts.asphalt.x, opts.asphalt.y + opts.asphalt.h, opts.asphalt.w, 40).fill({ color: 0xd5d8db });

  const thickness = 24;
  for (let i = 0; i < opts.wall.length - 1; i += 1) {
    const a = opts.wall[i];
    const b = opts.wall[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = ((-(b.y - a.y)) / len) * (thickness / 2);
    const ny = ((b.x - a.x) / len) * (thickness / 2);
    let spans: [number, number][] = [[0, 1]];
    if (opts.gap) {
      const t = ((opts.gap.at.x - a.x) * (b.x - a.x) + (opts.gap.at.y - a.y) * (b.y - a.y)) / (len * len);
      const half = opts.gap.width / 2 / len;
      // A gap is a genuine absence of wall, the same thing `compileBuilding` cuts for a
      // doorway — not a door drawn on a continuous run.
      if (t > 0.02 && t < 0.98) spans = [[0, Math.max(0, t - half)], [Math.min(1, t + half), 1]];
    }
    for (const [t0, t1] of spans) {
      if (t1 - t0 < 0.01) continue;
      const run = [
        { x: a.x + (b.x - a.x) * t0 + nx, y: a.y + (b.y - a.y) * t0 + ny },
        { x: a.x + (b.x - a.x) * t1 + nx, y: a.y + (b.y - a.y) * t1 + ny },
        { x: a.x + (b.x - a.x) * t1 - nx, y: a.y + (b.y - a.y) * t1 - ny },
        { x: a.x + (b.x - a.x) * t0 - nx, y: a.y + (b.y - a.y) * t0 - ny },
      ];
      contactShape(shadow, run, 20);
      volumeShape(solids, run, { top: 0x33383d, front: 0x14171a, edge: 0x0d1013, lit: 0x4a4f55 }, 20);
    }
  }
}

// ---------------------------------------------------------------------------
// A — The Fairground
// ---------------------------------------------------------------------------

/**
 * A closed amusement park, going back to weeds.
 *
 * The strongest of the three from directly above, for a structural reason rather than a
 * thematic one: fairground rides are built about a vertical axis, so a carousel and a
 * waltzer are perfect circles in plan and unmistakable. The coaster is the opposite kind
 * of shape — a ribbon wandering the whole site — and between the radial and the linear
 * the place reads at a glance.
 *
 * The ferris wheel is drawn honestly, which is the most interesting decision here. A
 * vertical wheel seen from straight above is a LINE: gondolas strung between two A-frames.
 * Faking the circle would be the exact perspective cheat the language exists to refuse,
 * and the honest version is more distinctive anyway.
 */
const WALTZER = { x: 1180, y: 236, r: 128 };
const WALTZER_POOL = inset(blob(WALTZER.x, WALTZER.y, WALTZER.r, "waltzer", 0.06, 17), 24);

const FAIRGROUND: Vignette = {
  id: "fairground",
  title: "The Fairground",
  strapline: "A closed amusement park: rides seized, the midway splitting into weeds, the wheel still up.",
  landmarks: [
    "Carousel — a striped canopy on a centre pole, horses still on the ring",
    "The ferris wheel, drawn honestly: gondolas in a line between two A-frames",
    "Roller coaster — a track ribbon crossing the whole site on trestles",
    "The waltzer, its dished floor now holding rainwater",
    "The midway: kiosks on a rhythm under a dead bulb arch",
  ],
  asks: [
    "Ground as polygons — asphalt losing to weeds is not a rectangle",
    "A ribbon structure crossing everything overhead, with posts as the only collider",
    "Radial fixtures far bigger than anything in Downtown",
    "Decay as an authoring idea: the same object, minus three of its parts",
  ],
  width: 1600,
  height: 1000,
  draw(layers) {
    const { ground, shadow, solids, actors } = layers;

    // Old asphalt is the dark anchor, so every peeling-paint structure reads bright
    // against it — the same job the carriageway does in Downtown.
    ground.rect(0, 0, 1600, 1000).fill({ color: 0x9ea3a4 });

    /**
     * Weeds through the paving, as regions rather than as speckle.
     *
     * This is what makes abandonment read: the ground is not "rough asphalt", it is
     * paving LOSING to something. A texture says age; a torn region says nobody has been
     * here in years.
     */
    for (const [cx, cy, r] of [
      [130, 180, 185], [430, 80, 140], [1500, 250, 200], [1320, 640, 125],
      [240, 830, 195], [820, 950, 230], [1560, 890, 170], [640, 460, 90],
    ] as const) {
      const patch = blob(cx, cy, r, `w${cx}`, 0.5, 15);
      groundPoly(ground, patch, GROUND.grass);
      speckle(ground, patch, `ws${cx}`, { color: shade(GROUND.grass, 0.82), count: 44, size: [4, 13], alpha: 0.5 });
    }

    // The midway: worn concrete, still the clearest route across the site.
    const midway = ribbon([
      { x: -20, y: 470 }, { x: 300, y: 500 }, { x: 700, y: 520 },
      { x: 1100, y: 500 }, { x: 1620, y: 470 },
    ], () => 152);
    groundPoly(ground, midway, 0xc4c8c9);
    speckle(ground, midway, "mw", { color: 0xafb4b5, count: 90, size: [6, 20], alpha: 0.45 });

    citySeam(layers, {
      asphalt: { x: -20, y: -20, w: 320, h: 92 },
      wall: [{ x: -20, y: 148 }, { x: 292, y: 156 }, { x: 296, y: -20 }],
      gap: { at: { x: 148, y: 152 }, width: 100 },
    });

    /**
     * The carousel: platform, then horses, then a striped canopy overhead.
     *
     * The stripe is doing the identifying work. A big pale disc with a hub is a water
     * tank; the same disc with twelve alternating panels is a fairground ride and nothing
     * else. It is also why the canopy belongs overhead — you see it from above, and the
     * horses underneath it are what a player has to walk between.
     */
    const car = { x: 428, y: 296, r: 132 };
    contactRound(shadow, car.x, car.y, car.r, 48);
    cylinder(solids, car.x, car.y, car.r, NAT.timberDark, 8);
    for (let i = 0; i < 10; i += 1) {
      if (i === 4) continue; // one horse gone, because this park closed badly
      const a = (i / 10) * Math.PI * 2 + 0.2;
      const hx = car.x + Math.cos(a) * car.r * 0.7;
      const hy = car.y + Math.sin(a) * car.r * 0.7;
      fillPoly(solids, bar({ x: hx, y: hy }, { x: -Math.sin(a), y: Math.cos(a) }, 17, 6.5), shade(MAT.fibre.top, 1.03));
      solids.circle(hx, hy, 4.5).fill({ color: shade(MAT.steelDeep.top, 0.9) });
    }
    overheadPiece(layers, "carousel", (g) => {
      const panels = 12;
      for (let i = 0; i < panels; i += 1) {
        const a0 = (i / panels) * Math.PI * 2;
        const a1 = ((i + 1) / panels) * Math.PI * 2;
        const wedge: Vec2[] = [{ x: car.x, y: car.y }];
        for (let s = 0; s <= 4; s += 1) {
          const a = a0 + ((a1 - a0) * s) / 4;
          // Scalloped hem: the edge dips between panel seams, as a canopy does.
          const scallop = s === 2 ? 1 : 0.955;
          wedge.push({ x: car.x + Math.cos(a) * car.r * 0.92 * scallop, y: car.y + Math.sin(a) * car.r * 0.92 * scallop });
        }
        fillPoly(g, wedge, shade(NAT.iron.top, i % 2 === 0 ? 1.52 : 1.2));
      }
      g.circle(car.x, car.y, car.r * 0.92).stroke({ color: shade(NAT.iron.top, 0.66), width: 2.2 });
      g.circle(car.x, car.y, car.r * 0.2).fill({ color: shade(NAT.iron.top, 1.02) });
      g.circle(car.x, car.y, car.r * 0.2).stroke({ color: NAT.iron.edge, width: 1.6 });
      g.circle(car.x, car.y, car.r * 0.07).fill({ color: NAT.iron.edge });
      // Its shadow, cast onto the platform below. This is what sells "over".
      g.circle(car.x + 9, car.y + 17, car.r * 0.92).fill({ color: 0x000000, alpha: 0.1 });
    });

    /**
     * The waltzer: a dished floor, so it holds rainwater.
     *
     * The same recess primitive as a cenote. A ride that has become a pond is a whole
     * story told with one shape, and it costs nothing beyond reusing the shading.
     */
    const dish = blob(WALTZER.x, WALTZER.y, WALTZER.r, "waltzer", 0.06, 17);
    contactShape(shadow, dish, 17);
    volumeShape(solids, dish, NAT.iron, 17);
    // The pool goes into `solids`, after the dish rim that contains it. Drawn into
    // `ground` it was painted straight over, because ground renders under solids — the
    // water was there the whole time and simply invisible.
    water(solids, WALTZER_POOL, "waltzer-pool", { deep: GROUND.deep, shallow: GROUND.shallow, rim: 6 });
    for (let i = 0; i < 7; i += 1) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const cx = WALTZER.x + Math.cos(a) * 98;
      const cy = WALTZER.y + Math.sin(a) * 98;
      contactRound(shadow, cx, cy, 25, 13);
      cylinder(solids, cx, cy, 25, i === 3 ? NAT.timberDark : MAT.painted, 13);
      solids.circle(cx, cy, 15).fill({ color: shade(MAT.painted.front, 0.88) });
    }

    /**
     * The roller coaster: a track ribbon on trestle posts, crossing the whole site.
     *
     * The one non-radial structure, and the region needs it — a site made only of discs
     * has no direction. The posts are the collider and the track is overhead, so this is
     * the clearest walk-under case in any of the three regions.
     */
    const coaster: Vec2[] = [
      { x: -20, y: 764 }, { x: 210, y: 690 }, { x: 470, y: 734 }, { x: 690, y: 640 },
      { x: 880, y: 700 }, { x: 1058, y: 812 }, { x: 1290, y: 802 }, { x: 1424, y: 690 },
      { x: 1420, y: 520 }, { x: 1252, y: 430 },
    ];
    for (let i = 0; i < coaster.length; i += 2) post(solids, shadow, coaster[i].x, coaster[i].y, 12);
    // The coaster's own shadow on the ground, thrown south-east. Without it the track
    // read as a railway lying in the grass rather than as a structure overhead.
    for (let i = 0; i < coaster.length - 1; i += 1) {
      const a = coaster[i];
      const b = coaster[i + 1];
      ground.moveTo(a.x + 13, a.y + 26).lineTo(b.x + 13, b.y + 26)
        .stroke({ color: 0x000000, alpha: 0.13, width: 46, cap: "round" });
    }
    overheadPiece(layers, "coaster", (g) => {
      for (let i = 0; i < coaster.length - 1; i += 1) rails(g, coaster[i], coaster[i + 1], 40);
      // The train, stopped where it stopped, on the drop between points 4 and 5.
      const a = coaster[4];
      const b = coaster[5];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      for (let c = 0; c < 3; c += 1) {
        const t = 0.16 + c * 0.24;
        const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        fillPoly(g, bar(at, dir, 27, 18), shade(MAT.painted.top, 1.08));
        fillPoly(g, bar(at, dir, 21, 11), shade(MAT.painted.front, 0.92));
      }
    });

    /**
     * The ferris wheel, from directly above: a line, not a circle.
     *
     * Two A-frame legs on the ground, the rim edge-on as a narrow band between them, and
     * the gondolas hanging along it. Three are missing.
     */
    const wheel = { x: 828, y: 250, span: 424 };
    for (const side of [-1, 1]) {
      /**
       * Two legs per A-frame, not a solid trapezoid.
       *
       * The filled version read as a pair of ramps flanking the wheel, because a big
       * closed dark shape is a wall in this language whatever it is called. An A-frame is
       * mostly air, so it has to be drawn as two members.
       */
      for (const foot of [-1, 1]) {
        const legRun = [
          { x: wheel.x + side * 54 - 9, y: wheel.y - 8 },
          { x: wheel.x + side * 54 + 9, y: wheel.y - 8 },
          { x: wheel.x + side * 66 * 1 + foot * 0, y: wheel.y + foot * (wheel.span / 2 - 30) },
          { x: wheel.x + side * 42, y: wheel.y + foot * (wheel.span / 2 - 30) },
        ];
        contactShape(shadow, legRun, 26);
        volumeShape(solids, legRun, NAT.iron, 26);
      }
    }
    overheadPiece(layers, "wheel", (g) => {
      const rim: Rect = { x: wheel.x - 13, y: wheel.y - wheel.span / 2, w: 26, h: wheel.span };
      g.rect(rim.x, rim.y, rim.w, rim.h).fill({ color: shade(NAT.iron.top, 1.36) });
      g.rect(rim.x, rim.y, rim.w, rim.h).stroke({ color: NAT.iron.edge, width: 1.6 });
      for (let i = 0; i < 14; i += 1) {
        if (i === 3 || i === 8 || i === 9) continue;
        const y = wheel.y - wheel.span / 2 + 26 + (i * (wheel.span - 52)) / 13;
        g.roundRect(wheel.x - 27, y - 11, 54, 22, 5).fill({ color: shade(MAT.painted.top, 1.12) });
        g.roundRect(wheel.x - 27, y - 11, 54, 22, 5).stroke({ color: MAT.painted.edge, width: 1.2 });
        g.rect(wheel.x - 20, y - 3, 40, 6).fill({ color: shade(MAT.painted.front, 0.9) });
      }
      // The hub and its spoke bracing, which is what says "wheel" and not "fence".
      g.circle(wheel.x, wheel.y, 36).fill({ color: shade(NAT.iron.top, 1.14) });
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        g.moveTo(wheel.x, wheel.y).lineTo(wheel.x + Math.cos(a) * 34, wheel.y + Math.sin(a) * 34)
          .stroke({ color: shade(NAT.iron.top, 0.76), width: 2.4 });
      }
      g.circle(wheel.x, wheel.y, 36).stroke({ color: NAT.iron.edge, width: 1.8 });
      g.circle(wheel.x, wheel.y, 10).fill({ color: NAT.iron.edge });
      g.rect(wheel.x - 9, wheel.y + wheel.span / 2 - 20, 60, 12).fill({ color: 0x000000, alpha: 0.12 });
    });
    // A fallen gondola on the grass: the detail that dates the closure.
    const fallen: Rect = { x: 936, y: 430, w: 54, h: 25 };
    contact(shadow, fallen, 11, 5);
    volume(solids, fallen, MAT.paintedDark, 11, 5);

    // Kiosks along the midway, on a rhythm with a gap where the gate stood.
    for (let i = 0; i < 7; i += 1) {
      if (i === 3) continue;
      const r: Rect = { x: 132 + i * 208, y: 598, w: 94, h: 68 };
      contact(shadow, r, 27);
      const top = volume(solids, r, i % 2 ? MAT.fibre : MAT.wood, 27, 2);
      inlay(solids, { x: top.x + 6, y: top.y + 2, w: top.w - 12, h: 9 }, shade(MAT.steelDeep.top, 0.9));
      for (let s = 1; s < 5; s += 1) {
        seam(solids, top.x + (top.w / 5) * s, top.y + 14, top.x + (top.w / 5) * s, top.y + top.h - 4, shade(MAT.wood.front, 0.88));
      }
    }

    // The bulb arch over the midway: the way in, and another overhead piece.
    for (const x of [96, 266]) post(solids, shadow, x, 470, 14);
    overheadPiece(layers, "arch", (g) => {
      g.roundRect(72, 404, 218, 48, 8).fill({ color: shade(NAT.iron.top, 1.32) });
      g.roundRect(72, 404, 218, 48, 8).stroke({ color: NAT.iron.edge, width: 1.6 });
      g.rect(80, 450, 202, 9).fill({ color: 0x000000, alpha: 0.13 });
      for (let i = 0; i < 11; i += 1) {
        g.circle(88 + i * 20.4, 415, 3.6).fill({ color: shade(NAT.iron.top, 0.6) });
      }
      inlay(g, { x: 104, y: 424, w: 154, h: 20 }, shade(NAT.iron.top, 0.86));
    });

    // Trees that have come up through the site since it closed. Sparse, at the edges.
    for (const [x, y, r] of [[84, 902, 82], [556, 92, 68], [1524, 566, 74], [1012, 618, 62]] as const) {
      tree(layers, x, y, r, `ft${x}`);
    }
    thicket(ground, blob(300, 962, 116, "fth", 0.34), "fth");

    bot(actors, { x: 660, y: 506 }, 0, SQUAD);
    bot(actors, { x: 716, y: 542 }, 0, SQUAD);
    bot(actors, { x: 1162, y: 506 }, Math.PI, RIVAL, [1, 0, 1]);
    loot(actors, { x: 428, y: 296 }, "dashOvercharge");
    loot(actors, { x: 1180, y: 236 }, "radar");
    loot(actors, { x: 268, y: 632 }, "health");
  },

  animate({ motion }, tMs) {
    drawStillWater(motion, WALTZER_POOL, "waltzer-pool", tMs);
    drawDrift(motion, {
      id: "litter",
      count: 22,
      velocity: { x: 41, y: -9 },
      bounds: { x: -40, y: 60, w: 1680, h: 900 },
      size: [1.5, 3.4],
      color: shade(GROUND.grass, 0.66),
      alpha: 0.36,
      waver: 12,
    }, tMs);
  },
};

// ---------------------------------------------------------------------------
// B — The Roundhouse Yard
// ---------------------------------------------------------------------------

/**
 * A locomotive depot: turntable, roundhouse fan, sidings.
 *
 * The theme Mike said the first attempt came closest to, and it is worth being precise
 * about why: the frontier vignette had NAMED objects in it — rails, a water tower, a
 * loading dock — while the ravine and the temple had terrain. A trainyard is nothing but
 * named objects.
 *
 * It is also the best possible fit for a strict overhead view. A turntable is a circle
 * with one girder across it and cannot be mistaken for anything else; a roundhouse is a
 * fan of bays off that circle; a set of sidings is a fan of lines converging. Every
 * signature form of a railway is a plan-view form.
 */
const TURN = { x: 612, y: 520, r: 196 };
const TURN_PIT = blob(TURN.x, TURN.y, TURN.r, "turn", 0.012, 40);
const BAY0 = Math.PI * 0.6;
const BAY_SPAN = Math.PI * 0.56;
const BAYS = 7;

const YARD: Vignette = {
  id: "yard",
  title: "The Roundhouse Yard",
  strapline: "A locomotive depot: turntable, a seven-bay roundhouse, sidings, and a gantry you fight under.",
  landmarks: [
    "Turntable — a circle with one girder bridge, unmistakable from above",
    "Roundhouse — seven bays fanning off it, one with its roof fallen in",
    "The siding fan, converging east through the throat",
    "Coaling tower and gantry crane, both walked under",
    "Wagons standing in short rakes, and the water tower's swing arm",
  ],
  asks: [
    "A radial building: seven rooms about one centre, not one of them axis-aligned",
    "A rotating piece of FLOOR — the turntable is a moving collider, the smallest possible version of the hard netcode problem",
    "Overhead steel with legs as the only collider",
    "Tracks derived from a centre and a rhythm rather than hand-placed",
  ],
  width: 1600,
  height: 1000,
  draw(layers) {
    const { ground, shadow, solids, actors } = layers;

    // Ballast is the field and oily concrete the pads: both mid-value, so dark ironwork
    // and pale roofs each have somewhere to go.
    ground.rect(0, 0, 1600, 1000).fill({ color: 0xb2b4b0 });
    speckle(ground, poly({ x: 0, y: 0, w: 1600, h: 1000 }), "ballast", {
      color: 0x9da09b, count: 430, size: [3, 9], alpha: 0.42,
    });

    const apron = blob(TURN.x, TURN.y, TURN.r + 140, "apron", 0.1, 21);
    groundPoly(ground, apron, 0x9ea3a4);
    speckle(ground, apron, "oil", { color: 0x82878a, count: 140, size: [7, 26], alpha: 0.4 });

    citySeam(layers, {
      asphalt: { x: -20, y: -20, w: 1640, h: 70 },
      wall: [{ x: -20, y: 122 }, { x: 1620, y: 118 }],
      gap: { at: { x: 800, y: 120 }, width: 128 },
    });

    /**
     * The roundhouse: seven bays on a fan about the turntable's centre.
     *
     * Authored as an angle and two radii per bay rather than as seven rectangles, which is
     * the point — this is a building whose plan is polar. `outline` already takes an
     * arbitrary polygon so the SHAPE needs nothing new; what it needs is for a bay to be a
     * room with a door and for none of those rooms to line up with the sheet.
     */
    for (let i = 0; i < BAYS; i += 1) {
      const a = BAY0 + (i / (BAYS - 1)) * BAY_SPAN;
      const half = (BAY_SPAN / (BAYS - 1)) * 0.44;
      const inner = TURN.r + 30;
      const outer = TURN.r + 300;
      const at = (radius: number, angle: number): Vec2 => ({
        x: TURN.x + Math.cos(angle) * radius,
        y: TURN.y + Math.sin(angle) * radius,
      });
      const shell = [at(inner, a - half), at(outer, a - half), at(outer, a + half), at(inner, a + half)];

      // Shed floor, the road down it, and the inspection pit under the road.
      groundPoly(ground, shell, 0x969a9c);
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const mid = at((inner + outer) / 2, a);
      water(ground, bar(mid, dir, (outer - inner) / 2 - 44, 15), `pit${i}`, {
        deep: GROUND.abyss, shallow: 0x7e8385, rim: 4, still: false,
      });
      rails(ground, at(inner - 26, a), at(outer - 24, a));

      // Side walls between bays, so a bay is a genuine room and not a painted lane.
      if (i < BAYS - 1) {
        const nextA = BAY0 + ((i + 1) / (BAYS - 1)) * BAY_SPAN;
        const wallA = (a + nextA) / 2;
        const wallRun = [at(inner + 18, wallA), at(outer, wallA)];
        const wlen = Math.hypot(wallRun[1].x - wallRun[0].x, wallRun[1].y - wallRun[0].y);
        const wdir = { x: (wallRun[1].x - wallRun[0].x) / wlen, y: (wallRun[1].y - wallRun[0].y) / wlen };
        const wmid = { x: (wallRun[0].x + wallRun[1].x) / 2, y: (wallRun[0].y + wallRun[1].y) / 2 };
        const run = bar(wmid, wdir, wlen / 2, 9);
        contactShape(shadow, run, 22);
        volumeShape(solids, run, MAT.paintedDark, 22);
      }

      if (i === 4) continue; // the collapsed bay, which is what makes the other six read
      overheadPiece(layers, `bay${i}`, (g) => {
        const roof = [at(inner + 24, a - half), at(outer, a - half), at(outer, a + half), at(inner + 24, a + half)];
        fillPoly(g, roof, shade(NAT.iron.top, 1.44));
        corrugate(g, roof, 13, shade(NAT.iron.top, 1.18));
        g.poly(roof.map((p) => ({ x: p.x, y: p.y }))).stroke({ color: NAT.iron.edge, width: 1.8 });
        // Smoke hood over each road, where a loco stands to be worked on.
        const hoodAt = at(inner + 110, a);
        fillPoly(g, bar(hoodAt, dir, 46, 26), shade(NAT.iron.top, 0.92));
      });
    }

    /**
     * The turntable: a pit, a ring rail, one girder bridge, and the operator's cabin.
     *
     * The most recognisable plan-view object in industrial architecture, and the most
     * interesting thing in any of these regions from a systems point of view — it is a
     * piece of FLOOR that rotates. A bot standing on the bridge stands on a moving
     * collider, which is the hard netcode problem in its smallest possible form.
     */
    water(ground, TURN_PIT, "turnpit", { deep: 0x7a7f81, shallow: 0x8f9497, rim: 8, still: false });
    ground.circle(TURN.x, TURN.y, TURN.r).stroke({ color: shade(MAT.steelDeep.top, 0.78), width: 3 });
    ground.circle(TURN.x, TURN.y, TURN.r - 15).stroke({ color: shade(MAT.steel.top, 1.14), width: 3.4 });

    const bridgeA = BAY0 + (2 / (BAYS - 1)) * BAY_SPAN;
    const bdir = { x: Math.cos(bridgeA), y: Math.sin(bridgeA) };
    const bridge = bar(TURN, bdir, TURN.r, 30);
    contactShape(shadow, bridge, 15);
    volumeShape(solids, bridge, MAT.steelDark, 15);
    rails(solids, { x: TURN.x + bdir.x * (TURN.r - 8), y: TURN.y + bdir.y * (TURN.r - 8) },
      { x: TURN.x - bdir.x * (TURN.r - 8), y: TURN.y - bdir.y * (TURN.r - 8) });
    const cabin: Rect = { x: TURN.x + bdir.x * 76 - 23, y: TURN.y + bdir.y * 76 - 23, w: 46, h: 46 };
    contact(shadow, cabin, 32);
    const cabinTop = volume(solids, cabin, MAT.painted, 32, 3);
    inlay(solids, { x: cabinTop.x + 5, y: cabinTop.y + 5, w: cabinTop.w - 10, h: 14 }, 0xdae3e9);

    /**
     * The siding fan: five roads converging east through the throat.
     *
     * Spaced on a rhythm and derived from one point, not hand-placed — the same rule the
     * city's street furniture follows, and the reason a yard reads as engineered rather
     * than as scattered lines.
     */
    const throat = { x: 1580, y: 500 };
    for (let i = 0; i < 5; i += 1) {
      const y = 300 + i * 100;
      rails(ground, { x: TURN.x + TURN.r + 320, y }, { x: 1250, y });
      rails(ground, { x: 1250, y }, { x: throat.x, y: throat.y + (y - 500) * 0.14 });
    }

    // Wagons in short rakes with real gaps, standing on three of the roads.
    for (const [x, y, n] of [[1000, 300, 3], [1058, 400, 2], [980, 700, 4]] as const) {
      for (let w = 0; w < n; w += 1) {
        const r: Rect = { x: x + w * 134, y: y - 34, w: 120, h: 68 };
        contact(shadow, r, 31);
        const top = volume(solids, r, w % 2 ? MAT.paintedDark : MAT.painted, 31, 2);
        for (let s = 1; s < 7; s += 1) {
          seam(solids, top.x + (top.w / 7) * s, top.y + 3, top.x + (top.w / 7) * s, top.y + top.h - 3, shade(MAT.painted.front, 0.9));
        }
        inlay(solids, { x: top.x + top.w * 0.33, y: top.y + 3, w: top.w * 0.34, h: top.h - 6 }, shade(MAT.steelDark.top, 0.94));
        for (const bx of [r.x + 22, r.x + r.w - 36]) {
          inlay(solids, { x: bx, y: r.y + r.h - 5, w: 15, h: 7 }, MAT.rubber.top);
        }
      }
    }

    /**
     * The coaling tower: four legs, a bunker overhead, chutes out over two roads.
     *
     * The tallest thing in the yard and a real chokepoint — you fight underneath it.
     */
    for (const [x, y] of [[770, 790], [908, 790], [770, 908], [908, 908]] as const) {
      post(solids, shadow, x, y, 15);
    }
    ground.rect(770, 798, 160, 126).fill({ color: 0x000000, alpha: 0.15 });
    overheadPiece(layers, "coaler", (g) => {
      const r: Rect = { x: 748, y: 772, w: 202, h: 166 };
      g.rect(r.x, r.y, r.w, r.h).fill({ color: shade(NAT.iron.top, 1.26) });
      fillPoly(g, [
        { x: r.x + 26, y: r.y + 22 }, { x: r.x + r.w - 26, y: r.y + 22 },
        { x: r.x + r.w - 58, y: r.y + r.h - 26 }, { x: r.x + 58, y: r.y + r.h - 26 },
      ], shade(NAT.iron.top, 0.84));
      for (const cy of [r.y + 54, r.y + r.h - 54]) {
        g.rect(r.x - 48, cy - 13, 54, 26).fill({ color: shade(NAT.iron.top, 1.08) });
        g.rect(r.x - 48, cy - 13, 54, 26).stroke({ color: NAT.iron.edge, width: 1.4 });
      }
      g.rect(r.x, r.y, r.w, r.h).stroke({ color: NAT.iron.edge, width: 2 });
      g.rect(r.x + 9, r.y + r.h, r.w, 11).fill({ color: 0x000000, alpha: 0.12 });
    });

    /**
     * The gantry crane: a portal spanning four roads.
     *
     * Fighting under a gantry is a genuinely different kind of space from anything in
     * Downtown — open to shoot across, roofed against being seen from above.
     */
    for (const y of [266, 738]) post(solids, shadow, 1292, y, 16);
    overheadPiece(layers, "gantry", (g) => {
      g.rect(1254, 248, 78, 508).fill({ color: shade(MAT.steelDark.top, 1.22) });
      for (let i = 0; i < 16; i += 1) {
        const y0 = 252 + i * 31;
        g.moveTo(1256, y0).lineTo(1330, y0 + 31).stroke({ color: shade(MAT.steelDark.top, 0.84), width: 1.3 });
        g.moveTo(1330, y0).lineTo(1256, y0 + 31).stroke({ color: shade(MAT.steelDark.top, 0.84), width: 1.3 });
      }
      g.rect(1254, 248, 78, 508).stroke({ color: MAT.steelDeep.edge, width: 1.8 });
      // The crab, parked over the third road, with its hook block below.
      g.rect(1244, 468, 96, 64).fill({ color: shade(MAT.painted.top, 1.06) });
      g.rect(1244, 468, 96, 64).stroke({ color: MAT.painted.edge, width: 1.6 });
      g.rect(1262, 756, 62, 12).fill({ color: 0x000000, alpha: 0.12 });
    });

    // The water tower, with its swing arm out over the road.
    for (const [x, y] of [[198, 178], [286, 178], [198, 264], [286, 264]] as const) {
      post(solids, shadow, x, y, 12);
    }
    ground.circle(246, 234, 74).fill({ color: 0x000000, alpha: 0.14 });
    overheadPiece(layers, "watertower", (g) => {
      cylinder(g, 242, 221, 74, MAT.steelDark, 20);
      for (let i = 0; i < 20; i += 1) {
        const a = (i / 20) * Math.PI * 2;
        g.moveTo(242 + Math.cos(a) * 30, 221 + Math.sin(a) * 30)
          .lineTo(242 + Math.cos(a) * 72, 221 + Math.sin(a) * 72)
          .stroke({ color: shade(MAT.steelDark.top, 0.9), width: 0.9 });
      }
      for (const r of [68, 44] as const) {
        g.circle(242, 221, r).stroke({ color: shade(NAT.iron.top, 0.82), width: 2.4 });
      }
      g.circle(242, 221, 12).fill({ color: NAT.iron.edge });
      g.rect(240, 214, 130, 15).fill({ color: shade(MAT.steelDark.top, 1.12) });
      g.rect(240, 214, 130, 15).stroke({ color: MAT.steelDeep.edge, width: 1.2 });
    });

    // The signal box, overlooking the throat.
    const box: Rect = { x: 1398, y: 798, w: 134, h: 96 };
    contact(shadow, box, 42);
    const boxTop = volume(solids, box, MAT.wood, 42, 3);
    inlay(solids, { x: boxTop.x + 5, y: boxTop.y + 5, w: boxTop.w - 10, h: boxTop.h - 10 }, shade(MAT.wood.top, 1.06));
    inlay(solids, { x: boxTop.x + 10, y: boxTop.y + 8, w: boxTop.w - 20, h: 14 }, 0xdae3e9);

    // Weeds where nothing runs any more: how a yard shows what is still in use.
    for (const [cx, cy, r] of [[1494, 176, 128], [58, 884, 148], [702, 118, 94]] as const) {
      const patch = blob(cx, cy, r, `yw${cx}`, 0.44, 13);
      groundPoly(ground, patch, GROUND.scrub);
      speckle(ground, patch, `yws${cx}`, { color: shade(GROUND.scrub, 0.84), count: 34, size: [4, 12], alpha: 0.5 });
    }

    bot(actors, { x: 1292, y: 500 }, Math.PI, SQUAD);
    bot(actors, { x: 1226, y: 552 }, Math.PI, SQUAD);
    bot(actors, { x: 612, y: 520 }, -Math.PI / 2, RIVAL, [1, 1, 0]);
    bot(actors, { x: 840, y: 850 }, 0, RIVAL, [0, 1, 1]);
    loot(actors, { x: 1056, y: 700 }, "health");
    loot(actors, { x: 620, y: 300 }, "incognito");
    loot(actors, { x: 246, y: 234 }, "radar");
  },

  animate({ motion }, tMs) {
    drawStillWater(motion, TURN_PIT, "turnpit", tMs);
    drawDrift(motion, {
      id: "soot",
      count: 26,
      velocity: { x: -37, y: 13 },
      bounds: { x: -40, y: 60, w: 1680, h: 900 },
      size: [1.3, 3],
      color: 0x6e7378,
      alpha: 0.3,
      waver: 10,
    }, tMs);
  },
};

// ---------------------------------------------------------------------------
// C — The Temple
// ---------------------------------------------------------------------------

/**
 * A Mayan ceremonial centre, on its own axis, with the jungle at the fence line.
 *
 * Kept from the first attempt because the bones were right and the failure was purely
 * specificity: a "stepped stone mass" is not a temple, it is a shape. What makes this
 * place itself is a short list of very particular buildings — a steep pyramid with a
 * serpent balustrade, an I-plan ball court with ring stones, a ROUND observatory, a row of
 * carved stelae, a cenote with steps cut down one side. None of those is generic, and each
 * of them is the reason someone would remember the place.
 */
const CENOTE = blob(1380, 250, 146, "cenote", 0.18);

const TEMPLE: Vignette = {
  id: "temple",
  title: "The Temple",
  strapline: "A ceremonial centre on its own axis: pyramid, ball court, round observatory, cenote.",
  landmarks: [
    "The pyramid — five steep terraces, one grand stair, serpent heads at its foot",
    "Ball court in its real I-plan, with sloping benches and two ring stones",
    "The observatory: a round tower on a platform, off every grid on the sheet",
    "Stelae on a rhythm, carved, with the processional gap punched out",
    "The cenote — a flooded shaft with steps cut down into it",
  ],
  asks: [
    "Terrain elevation: a terrace a bot stands ON, so the outdoor plane goes plural",
    "Monumental outdoor stairs that belong to the ground, not to a building",
    "A whole complex rotated off the sheet's grid",
    "Rooms as voids cut into a mass rather than a shell around a space",
  ],
  width: 1600,
  height: 1000,
  draw(layers) {
    const { ground, shadow, solids, actors } = layers;
    const R = rotator({ x: 800, y: 500 }, -0.157);

    ground.rect(0, 0, 1600, 1000).fill({ color: GROUND.humus });
    const clearing = R.many(poly({ x: 130, y: 90, w: 1350, h: 830 }));
    groundPoly(ground, clearing, GROUND.earth);
    speckle(ground, clearing, "cl", { color: shade(GROUND.earth, 0.9), count: 150, size: [7, 22], alpha: 0.34 });

    /**
     * The plaza, and the plan the whole complex hangs off.
     *
     * Laid out the way a ceremonial centre actually is, which the first version was not:
     * the pyramid stands on the plaza's NORTH side with its stair facing in, the ball court
     * runs down the west flank, the observatory sits off the south-east corner, and the
     * altar is on the axis between the stair and the plaza's centre. Every building faces
     * the open ground rather than sitting where it fitted — which is the same rule the
     * city's "a building addresses a street" audit enforces, applied to a plaza.
     */
    const PLAZA: Rect = { x: 300, y: 250, w: 1000, h: 620 };
    const plaza = R.many(poly(PLAZA));
    groundPoly(ground, plaza, GROUND.flag);
    for (let i = 1; i < 12; i += 1) {
      const a = R.one({ x: PLAZA.x + (PLAZA.w * i) / 12, y: PLAZA.y });
      const b = R.one({ x: PLAZA.x + (PLAZA.w * i) / 12, y: PLAZA.y + PLAZA.h });
      seam(ground, a.x, a.y, b.x, b.y, shade(GROUND.flag, 0.92), 0.9);
    }
    for (let i = 1; i < 8; i += 1) {
      const a = R.one({ x: PLAZA.x, y: PLAZA.y + (PLAZA.h * i) / 8 });
      const b = R.one({ x: PLAZA.x + PLAZA.w, y: PLAZA.y + (PLAZA.h * i) / 8 });
      seam(ground, a.x, a.y, b.x, b.y, shade(GROUND.flag, 0.92), 0.9);
    }

    // The approach: a cut track in from the city, and a survey mast at the tree line.
    const approach = [{ x: -20, y: 96 }, { x: 170, y: 178 }, { x: 372, y: 236 }];
    groundPoly(ground, ribbon(approach, () => 96), GROUND.earth);
    ruts(ground, approach, 54, "track");
    ground.rect(-20, -20, 200, 92).fill({ color: 0xa4a8ad });
    for (const at of [{ x: 196, y: 78 }, { x: 288, y: 132 }] as const) {
      contact(shadow, { x: at.x - 7, y: at.y - 7, w: 14, h: 14 }, 34);
      volume(solids, { x: at.x - 7, y: at.y - 7, w: 14, h: 14 }, NAT.iron, 34, 2);
    }

    /**
     * The pyramid: SQUARE in plan, five terraces, one stair up the south face.
     *
     * Square because that is what the building is — the first version was 460×400 and read
     * as a lopsided wedding cake. And the stair now runs exactly the depth of the terraces
     * it climbs: foot on the base edge, head on the summit edge. Previously it was authored
     * 162 units long against a 130-unit climb, so it overshot onto the summit platform and
     * looked like a ladder lying across the top.
     */
    const PYR = { size: 420, cx: 800, top: 210, steps: 5, inset: 26 };
    const climb = PYR.steps * PYR.inset;
    const base = R.many(poly({ x: PYR.cx - PYR.size / 2, y: PYR.top, w: PYR.size, h: PYR.size }));
    const summit = steppedMass(solids, shadow, base, "pyr", { steps: PYR.steps, inset: PYR.inset, lift: 25 });
    const shrine = inset(summit, 12);
    contactShape(shadow, shrine, 36);
    const shrineTop = volumeShape(solids, shrine, NAT.stone, 36);
    fillPoly(solids, shrink(shrineTop, 0.44), shade(GROUND.abyss, 1.1));

    const stairFoot = PYR.top + PYR.size;
    grandStair(
      solids, shadow,
      R.one({ x: PYR.cx, y: stairFoot }),
      R.one({ x: PYR.cx, y: stairFoot - climb }),
      64,
      { steps: 9, lift: 96, material: NAT.stone },
    );
    /**
     * Serpent balustrades ending in heads at the FOOT of the stair, on the plaza.
     *
     * The one detail that turns a flight of steps into this building, and it has to sit
     * where a player walking up to it will pass between the two heads.
     */
    for (const side of [-1, 1]) {
      const hx = PYR.cx + side * 80;
      const head = R.many([
        { x: hx - 21, y: stairFoot + 4 }, { x: hx + 21, y: stairFoot + 4 },
        { x: hx + 27, y: stairFoot + 56 }, { x: hx - 27, y: stairFoot + 56 },
      ]);
      contactShape(shadow, head, 30);
      const headTop = volumeShape(solids, head, NAT.stone, 30);
      fillPoly(solids, shrink(headTop, 0.66), shade(NAT.stone.top, 0.85));
      const eye = R.one({ x: hx - side * 9, y: stairFoot + 20 });
      solids.circle(eye.x, eye.y, 4.5).fill({ color: shade(NAT.stone.edge, 1.15) });
      const jaw0 = R.one({ x: hx - 22, y: stairFoot + 46 });
      const jaw1 = R.one({ x: hx + 22, y: stairFoot + 46 });
      seam(solids, jaw0.x, jaw0.y, jaw1.x, jaw1.y, shade(NAT.stone.edge, 1.05), 1.6);
    }

    // The chamber mouth in the base, on the east flank: the way INTO the mass.
    const mouth = R.many(poly({ x: PYR.cx + PYR.size / 2 - 30, y: PYR.top + PYR.size - 150, w: 30, h: 92 }));
    fillPoly(solids, mouth, GROUND.abyss);
    solids.poly(mouth.map((p) => ({ x: p.x, y: p.y }))).stroke({ color: shade(NAT.stone.edge, 0.9), width: 1.6 });

    /**
     * The ball court down the plaza's west flank, in its real I-plan.
     *
     * Two long sloping benches, a sunken alley between, an open end zone at each end, and a
     * ring stone standing proud on each bench. The I is what makes it identifiable rather
     * than just two parallel walls.
     */
    const COURT = { x: 336, y: 430, alley: 200, bench: 62, len: 330 };
    const alley = R.many(poly({ x: COURT.x + COURT.bench, y: COURT.y, w: COURT.alley, h: COURT.len }));
    water(ground, alley, "alley", { deep: shade(GROUND.flag, 0.84), shallow: GROUND.flag, rim: 7, still: false });
    for (const endY of [COURT.y - 36, COURT.y + COURT.len + 2]) {
      groundPoly(
        ground,
        R.many(poly({ x: COURT.x - 26, y: endY, w: COURT.alley + COURT.bench * 2 + 52, h: 34 })),
        shade(GROUND.flag, 1.03),
      );
    }
    for (const bx of [COURT.x, COURT.x + COURT.bench + COURT.alley]) {
      const bench = R.many(poly({ x: bx, y: COURT.y, w: COURT.bench, h: COURT.len }));
      contactShape(shadow, bench, 36);
      const top = volumeShape(solids, bench, NAT.stoneWorn, 36);
      fillPoly(solids, inset(top, 8), shade(NAT.stoneWorn.top, 1.05));
      const ring = R.one({ x: bx + COURT.bench / 2, y: COURT.y + COURT.len / 2 });
      solids.circle(ring.x, ring.y, 21).fill({ color: shade(NAT.stone.top, 0.95) });
      solids.circle(ring.x, ring.y, 11).fill({ color: GROUND.abyss });
      solids.circle(ring.x, ring.y, 21).stroke({ color: NAT.stone.edge, width: 1.5 });
    }

    /**
     * The observatory, off the plaza's south-east corner: a round tower on a platform.
     *
     * A cylinder is the most valuable shape in a strict overhead view — it reads with no
     * interpretation at all — and a round building among rectilinear ones is a contrast the
     * city has nowhere to put.
     */
    const platform = R.many(poly({ x: 1050, y: 660, w: 250, h: 210 }));
    contactShape(shadow, platform, 22);
    volumeShape(solids, platform, NAT.stoneWorn, 22);
    const obs = R.one({ x: 1175, y: 765 });
    contactRound(shadow, obs.x, obs.y, 80, 58);
    cylinder(solids, obs.x, obs.y, 80, NAT.stone, 58);
    solids.circle(obs.x, obs.y, 60).stroke({ color: shade(NAT.stone.front, 0.9), width: 1.6 });
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      solids.circle(obs.x + Math.cos(a) * 70, obs.y + Math.sin(a) * 70, 8).fill({ color: GROUND.abyss });
    }
    solids.circle(obs.x, obs.y, 16).fill({ color: shade(NAT.stone.top, 1.07) });

    /**
     * Stelae along the plaza's SOUTH edge, on a rhythm, facing the pyramid.
     *
     * Moved off the west edge, where they were fighting the ball court for the same ground.
     * A rhythm with the processional gap punched out of it — the city's street-furniture
     * rule, unchanged.
     */
    for (let i = 0; i < 6; i += 1) {
      if (i === 3) continue;
      const at = R.one({ x: 640 + i * 118, y: PLAZA.y + PLAZA.h - 46 });
      contact(shadow, { x: at.x - 17, y: at.y - 17, w: 34, h: 34 }, 46);
      const top = volume(solids, { x: at.x - 17, y: at.y - 17, w: 34, h: 34 }, NAT.stone, 46, 2);
      inlay(solids, { x: top.x + 5, y: top.y + 5, w: top.w - 10, h: top.h - 10 }, shade(NAT.stone.top, 0.88));
      seam(solids, top.x + 4, top.y + top.h * 0.4, top.x + top.w - 4, top.y + top.h * 0.4, shade(NAT.stone.front, 0.88));
      seam(solids, top.x + 4, top.y + top.h * 0.68, top.x + top.w - 4, top.y + top.h * 0.68, shade(NAT.stone.front, 0.88));
    }

    // The altar, on the axis between the stair foot and the plaza centre.
    const altar = R.one({ x: PYR.cx, y: stairFoot + 150 });
    contactRound(shadow, altar.x, altar.y, 54, 14);
    cylinder(solids, altar.x, altar.y, 54, NAT.stoneWorn, 14);
    solids.circle(altar.x, altar.y, 38).stroke({ color: shade(NAT.stoneWorn.front, 0.9), width: 1.4 });
    solids.circle(altar.x, altar.y, 16).fill({ color: shade(NAT.stoneWorn.top, 0.9) });

    // --- The cenote, off the north-east, outside the plaza wall ---
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      boulder(solids, shadow, 1380 + Math.cos(a) * 176, 250 + Math.sin(a) * 164, 19 + jitter("rim", i) * 21, `cr${i}`);
    }
    water(ground, CENOTE, "cenote", { deep: GROUND.abyss, shallow: GROUND.deep, rim: 9 });
    grandStair(solids, shadow, { x: 1380, y: 396 }, { x: 1380, y: 306 }, 34, {
      steps: 6, lift: 34, material: NAT.stoneWorn,
    });

    // The jungle, at the tree line only. Sparse — foliage is the weakest thing this
    // language draws, and a wall of it is what killed the first attempt.
    for (const [x, y, r] of [
      [70, 940, 84], [228, 994, 74], [392, 954, 88], [560, 1000, 70],
      [1046, 990, 82], [1220, 1000, 72], [1390, 962, 86], [1548, 918, 78],
      [1560, 610, 80], [56, 610, 76], [78, 262, 68], [1524, 128, 72],
    ] as const) {
      tree(layers, x, y, r, `j${x}`);
    }
    thicket(ground, blob(180, 800, 112, "tt-a", 0.32), "tt-a");
    thicket(ground, blob(700, 966, 120, "tt-b", 0.32), "tt-b");

    bot(actors, { x: 800, y: 556 }, -Math.PI / 2, SQUAD);
    bot(actors, { x: 848, y: 604 }, -Math.PI / 2, SQUAD);
    bot(actors, { x: 800, y: 366 }, Math.PI / 2, RIVAL, [1, 1, 0]);
    bot(actors, { x: 500, y: 596 }, 0, RIVAL, [1, 0, 1]);
    loot(actors, { x: 800, y: 780 }, "incognito");
    loot(actors, { x: 1175, y: 765 }, "health");
    loot(actors, { x: 1122, y: 486 }, "dashOvercharge");
  },

  animate({ motion }, tMs) {
    drawStillWater(motion, CENOTE, "cenote", tMs);
  },
};

export const VIGNETTES: Vignette[] = [FAIRGROUND, YARD, TEMPLE];
