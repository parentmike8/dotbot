import { Container, Graphics } from "pixi.js";
import type { MapDocument, Rect, Surface } from "@dotbot/game/types";
import { pathOutline } from "@dotbot/game/geometry";
import { FLAT_KINDS } from "@dotbot/game/mapModel";
import { capsuleRuns } from "./modelFloor";
import { isAcross, outwardBand, perimeterEntrances } from "./entrances";
import { drawModelObject } from "./modelGlyphs";
import {
  AO_ALPHA,
  contact,
  contactShape,
  inlay,
  jitter,
  MAT,
  occlude,
  shade,
  SHADOW_ALPHA,
  V,
  volumeShape,
  type ShadowPad,
} from "./tone";

/**
 * The street, in the same language as the interiors.
 *
 * The one idea that makes an exterior work in a plan view is a **real level
 * change at the kerb**. Line work can only imply it; a lit kerb top with a
 * shaded riser and a shadow falling onto the asphalt states it, and the whole
 * street stops reading as a diagram.
 *
 * Riser shading follows the same single light as everything else: faces pointing
 * north or west are lit, faces pointing south or east are in shade. That rule
 * alone gives a street its rhythm — a dark line down one kerb, a bright line
 * down the other.
 */

export type OutdoorModel = {
  /** Ground plane: blocks, asphalt, kerbs, paint, pads. */
  ground: Container;
  /** Non-solid dressing a bot walks over. */
  detail: Container;
  /** Solid outdoor fixtures. */
  objects: Container;
};

/** Sidewalks sit this far above the carriageway. */
const KERB_RISE = 7;
/** Anything narrower is a service lane: no sidewalk, no centre line. */
const LANE_MAX = 90;

const OUT = {
  /**
   * Beyond the site.
   *
   * Much darker than it used to be. At the old 0xa8abaf it was within four steps
   * of `asphalt`, so the 26-unit border round the sheet read as a narrow road
   * running the whole way round — reported as "a really skinny grey line at the
   * bottom of the map that's supposed to be a road". It is not a road, and now it
   * cannot be mistaken for one.
   */
  void: 0x6e7378,
  /**
   * Site ground nothing has claimed.
   *
   * `auditCity` forbids leaving any, so this tone showing up on a finished map is
   * a defect you can see rather than one you have to measure.
   */
  unmade: 0xc4c8cb,
  /**
   * The ground scale, lightest to darkest: forecourt, footway, yard, asphalt,
   * verge, void. It follows real albedo — fresh paving, worn paving, old
   * hardstanding, tarmac, planting, off-site — and the steps are deliberately
   * wide. A first pass had yard at 0xb4b8bc and verge at 0xb0b5b1, four steps
   * apart, which is no difference at all: a service yard and a planted setback
   * are the least similar things on the sheet and have to look it.
   */
  block: 0xd5d8db,
  /** Saw-cut joints in the sidewalk. */
  blockJoint: 0xc7cacd,
  /** Paving that serves a door: a shade brighter than the public footway. */
  forecourt: 0xdee1e4,
  /** Service hardstanding. Coarser and darker than anything public. */
  yard: 0xbfc3c6,
  yardPatch: 0xb2b6ba,
  /** Unpaved planted setback. */
  verge: 0x9aa09b,
  /** Carriageway. The dark anchor the whole exterior is measured against. */
  asphalt: 0xa4a8ad,
  /** Worn crown down the middle of a lane. */
  asphaltCrown: 0xacb0b5,
  /** Gutter, where grit collects against the kerb. */
  gutter: 0x93989d,
  /** Kerb top, catching the light. */
  kerbLit: 0xe4e7ea,
  /** Riser in shade. */
  kerbShade: 0x8f949a,
  /** Road paint. */
  paint: 0xf4f6f7,
  paintWorn: 0xc2c6ca,
  /** Planting beds. Kept in step with `verge` — a park is planting with a kerb. */
  planting: 0x9aa09b,
  plantingDark: 0x878d88,
} as const;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function intersections(map: MapDocument): Rect[] {
  const horizontal = map.outdoor.roads.filter((road) => road.w >= road.h);
  const vertical = map.outdoor.roads.filter((road) => road.h > road.w);
  const found: Rect[] = [];
  for (const h of horizontal) {
    for (const v of vertical) {
      const x = Math.max(h.x, v.x);
      const y = Math.max(h.y, v.y);
      const right = Math.min(h.x + h.w, v.x + v.w);
      const bottom = Math.min(h.y + h.h, v.y + v.h);
      if (right > x && bottom > y) found.push({ x, y, w: right - x, h: bottom - y });
    }
  }
  return found;
}

/** Spans of `start..end` left once every gap is removed. */
function spans(start: number, end: number, gaps: Array<{ start: number; end: number }>): Array<[number, number]> {
  const sorted = [...gaps].filter((gap) => gap.end > start && gap.start < end).sort((a, b) => a.start - b.start);
  const out: Array<[number, number]> = [];
  let cursor = start;
  for (const gap of sorted) {
    if (gap.start > cursor) out.push([cursor, Math.min(gap.start, end)]);
    cursor = Math.max(cursor, gap.end);
  }
  if (cursor < end) out.push([cursor, end]);
  return out;
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/**
 * Saw-cut joints, clipped to one surface.
 *
 * Deliberately near-invisible: at full contrast this grid reads as tiling and
 * dominates the whole street, which is the opposite of what a scored slab does in
 * life — you notice it only when you look for it. Bays are struck off the world
 * origin rather than the rect's, so two footways meeting at a corner line up.
 */
function joints(g: Graphics, rect: Rect, bay: number, alpha: number): void {
  for (let x = Math.ceil(rect.x / bay) * bay; x < rect.x + rect.w; x += bay) {
    g.rect(x - 0.5, rect.y, 1, rect.h).fill({ color: OUT.blockJoint, alpha });
  }
  for (let y = Math.ceil(rect.y / bay) * bay; y < rect.y + rect.h; y += bay) {
    g.rect(rect.x, y - 0.5, rect.w, 1).fill({ color: OUT.blockJoint, alpha });
  }
}

/**
 * Ground, by what it is for.
 *
 * The previous version filled the entire sheet with one slab tone and scored a
 * single joint grid across all of it, then cut the roads in. That is why the map
 * read as a car park with buildings dropped on it: it *was* one, and no amount of
 * furniture on top would have fixed it. A footway, a service yard and a planted
 * setback are different materials underfoot, and drawing them as different
 * materials is what gives the block its structure.
 *
 * What each surface means lives in the map — see `SurfaceKind` — so this function
 * only decides how each use looks.
 */
function drawSurface(g: Graphics, surface: Surface): void {
  switch (surface.kind) {
    case "footway":
      g.rect(surface.x, surface.y, surface.w, surface.h).fill({ color: OUT.block });
      joints(g, surface, 64, 0.5);
      break;

    case "plaza":
      g.rect(surface.x, surface.y, surface.w, surface.h).fill({ color: OUT.block });
      joints(g, surface, 96, 0.55);
      break;

    case "forecourt":
      // Brighter and finer than the public footway, so stepping off the street
      // onto a building's own ground registers as a change.
      g.rect(surface.x, surface.y, surface.w, surface.h).fill({ color: OUT.forecourt });
      joints(g, surface, 48, 0.45);
      break;

    case "yard": {
      g.rect(surface.x, surface.y, surface.w, surface.h).fill({ color: OUT.yard });
      // Patch repairs rather than joints: hardstanding is poured and mended, not
      // laid in slabs, and the irregularity is what separates it from paving.
      const seed = `${surface.x},${surface.y}`;
      const count = Math.round((surface.w * surface.h) / 42000);
      for (let i = 0; i < count; i += 1) {
        const a = jitter(seed, i);
        const b = jitter(seed, i + 31);
        const c = jitter(seed, i + 67);
        g.rect(
          surface.x + a * (surface.w - 90),
          surface.y + b * (surface.h - 70),
          40 + c * 50,
          30 + a * 36,
        ).fill({ color: OUT.yardPatch, alpha: 0.5 });
      }
      break;
    }

    case "verge": {
      g.rect(surface.x, surface.y, surface.w, surface.h).fill({ color: OUT.verge });
      const seed = `v${surface.x},${surface.y}`;
      const count = Math.round((surface.w * surface.h) / 5200);
      for (let i = 0; i < count; i += 1) {
        const a = jitter(seed, i);
        const b = jitter(seed, i + 40);
        g.circle(
          surface.x + 6 + a * (surface.w - 12),
          surface.y + 6 + b * (surface.h - 12),
          4 + a * 9,
        ).fill({ color: b > 0.5 ? OUT.plantingDark : shade(OUT.verge, 1.05), alpha: 0.45 });
      }
      break;
    }
  }
}

/**
 * The site, then every named surface on it, then the carriageway cut through.
 *
 * Anything still showing `unmade` when this is done is ground the plan forgot,
 * which `auditCity` fails the map for — so the tone exists mostly as a way to see
 * the failure rather than read about it.
 */
function drawBlocks(g: Graphics, map: MapDocument): void {
  g.rect(0, 0, map.width, map.height).fill({ color: OUT.void });

  const edge = 26;
  g.rect(edge, edge, map.width - edge * 2, map.height - edge * 2).fill({ color: OUT.unmade });

  for (const surface of map.outdoor.surfaces ?? []) drawSurface(g, surface);
}

function drawCarriageway(g: Graphics, pad: ShadowPad, map: MapDocument): void {
  const inters = intersections(map);

  for (const road of map.outdoor.roads) {
    const horizontal = road.w >= road.h;
    const lane = Math.min(road.w, road.h) < LANE_MAX;

    inlay(g, road, OUT.asphalt);

    // Worn crown: the strip the wheels polish.
    const crown = Math.min(road.w, road.h) * 0.34;
    inlay(
      g,
      horizontal
        ? { x: road.x, y: road.y + (road.h - crown) / 2, w: road.w, h: crown }
        : { x: road.x + (road.w - crown) / 2, y: road.y, w: crown, h: road.h },
      OUT.asphaltCrown,
    );

    // Gutters against both kerbs.
    const gutter = 5;
    for (const near of [true, false]) {
      inlay(
        g,
        horizontal
          ? { x: road.x, y: near ? road.y : road.y + road.h - gutter, w: road.w, h: gutter }
          : { x: near ? road.x : road.x + road.w - gutter, y: road.y, w: gutter, h: road.h },
        OUT.gutter,
      );
    }

    const gaps = inters.map((inter) =>
      horizontal ? { start: inter.x, end: inter.x + inter.w } : { start: inter.y, end: inter.y + inter.h },
    );

    /**
     * Kerbs, and the asymmetry is the whole point.
     *
     * The sidewalk is higher than the carriageway and the camera sits slightly
     * south, so which riser you can even see depends on which edge you are at:
     *
     *  - North kerb: the drop faces south, straight at the viewer, and away from
     *    the light. A dark riser plus a shadow thrown onto the asphalt.
     *  - South kerb: the drop faces north, hidden behind the sidewalk itself.
     *    Nothing but a crisp lit kerb line.
     *  - West kerb: the drop faces east, seen nearly edge-on and shaded.
     *  - East kerb: the drop faces west, into the light, so it reads bright.
     *
     * Making all four identical is what flattened the first pass into a diagram.
     */
    for (const [from, to] of spans(
      horizontal ? road.x : road.y,
      horizontal ? road.x + road.w : road.y + road.h,
      gaps,
    )) {
      if (horizontal) {
        const riser: Rect = { x: from, y: road.y, w: to - from, h: 4 };
        contact(pad, { ...riser, h: KERB_RISE }, KERB_RISE);
        inlay(g, { x: from, y: road.y - 3, w: to - from, h: 3 }, OUT.kerbLit);
        inlay(g, riser, OUT.kerbShade);
        inlay(g, { x: from, y: road.y + road.h - 1.5, w: to - from, h: 1.5 }, shade(OUT.gutter, 0.9));
        inlay(g, { x: from, y: road.y + road.h, w: to - from, h: 3 }, OUT.kerbLit);
      } else {
        const riser: Rect = { x: road.x, y: from, w: 3, h: to - from };
        contact(pad, { ...riser, w: KERB_RISE }, KERB_RISE);
        inlay(g, { x: road.x - 3, y: from, w: 3, h: to - from }, OUT.kerbLit);
        inlay(g, riser, shade(OUT.kerbShade, 1.06));
        inlay(g, { x: road.x + road.w - 2, y: from, w: 2, h: to - from }, shade(OUT.kerbLit, 0.94));
        inlay(g, { x: road.x + road.w, y: from, w: 3, h: to - from }, OUT.kerbLit);
      }
    }

    // Centre line on a real street; a service lane gets none.
    if (!lane) {
      const dash = 46;
      const stride = 84;
      const start = horizontal ? road.x + 16 : road.y + 16;
      const end = horizontal ? road.x + road.w - 16 : road.y + road.h - 16;
      for (let at = start; at < end; at += stride) {
        const size = Math.min(dash, end - at);
        if (gaps.some((gap) => at + size > gap.start && at < gap.end)) continue;
        // Bright enough to read against the polished crown it sits on.
        inlay(
          g,
          horizontal
            ? { x: at, y: road.y + road.h / 2 - 2, w: size, h: 4 }
            : { x: road.x + road.w / 2 - 2, y: at, w: 4, h: size },
          shade(OUT.paint, 0.96),
        );
      }
    }
  }

  for (const inter of inters) {
    if (Math.min(inter.w, inter.h) >= LANE_MAX) drawCrossings(g, inter);
  }
}

/** Ladder crossings on all four approaches. */
function drawCrossings(g: Graphics, inter: Rect): void {
  const depth = 26;
  const bar = 8;
  const stride = 16;

  for (const side of ["N", "S", "W", "E"] as const) {
    const band: Rect = side === "N"
      ? { x: inter.x, y: inter.y - depth - 4, w: inter.w, h: depth }
      : side === "S"
        ? { x: inter.x, y: inter.y + inter.h + 4, w: inter.w, h: depth }
        : side === "W"
          ? { x: inter.x - depth - 4, y: inter.y, w: depth, h: inter.h }
          : { x: inter.x + inter.w + 4, y: inter.y, w: depth, h: inter.h };

    const across = side === "N" || side === "S";
    const span = across ? band.w : band.h;
    for (let at = 6; at < span - bar; at += stride) {
      inlay(
        g,
        across
          ? { x: band.x + at, y: band.y, w: bar, h: band.h }
          : { x: band.x, y: band.y + at, w: band.w, h: bar },
        OUT.paint,
      );
    }
  }
}

function drawPlanting(g: Graphics, pad: ShadowPad, map: MapDocument): void {
  for (const park of map.outdoor.parks) {
    // Raised bed: kerb all round, lit on top, riser shaded to the south.
    contact(pad, park, KERB_RISE);
    inlay(g, park, OUT.kerbLit);
    inlay(g, { x: park.x + 3, y: park.y + 3, w: park.w - 6, h: park.h - 6 }, OUT.planting);
    // Mottling so a bed reads as planting rather than a flat panel.
    for (let i = 0; i < 26; i += 1) {
      const a = jitter(`${park.x},${park.y}`, i);
      const b = jitter(`${park.x},${park.y}`, i + 40);
      const r = 5 + a * 11;
      g.circle(park.x + 8 + a * (park.w - 16), park.y + 8 + b * (park.h - 16), r)
        .fill({ color: b > 0.5 ? OUT.plantingDark : shade(OUT.planting, 1.05), alpha: 0.5 });
    }
    inlay(g, { x: park.x, y: park.y + park.h - 3, w: park.w, h: 3 }, OUT.kerbShade);
  }
}

/**
 * An extraction pad. The one place outdoors that may shout: it is the thing a
 * player navigates to under pressure, so it gets the strongest paint on the map
 * and a bay marked out like real ground equipment.
 */
function drawExtractionPads(g: Graphics, map: MapDocument): void {
  for (const point of map.extractionPoints) {
    const { x, y, w, h } = point.rect;
    inlay(g, { x: x - 6, y: y - 6, w: w + 12, h: h + 12 }, OUT.paintWorn);
    inlay(g, { x, y, w, h }, shade(OUT.block, 1.04));

    // Hazard border.
    const band = 7;
    for (const edge of [
      { x, y, w, h: band },
      { x, y: y + h - band, w, h: band },
      { x, y, w: band, h },
      { x: x + w - band, y, w: band, h },
    ]) inlay(g, edge, OUT.paint);

    // Corner brackets, then a target ring at the centre.
    const bracket = 18;
    for (const [bx, by, dx, dy] of [
      [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
    ] as Array<[number, number, number, number]>) {
      inlay(g, { x: Math.min(bx, bx + dx * bracket), y: by + (dy > 0 ? 0 : -4), w: bracket, h: 4 }, OUT.paintWorn);
      inlay(g, { x: bx + (dx > 0 ? 0 : -4), y: Math.min(by, by + dy * bracket), w: 4, h: bracket }, OUT.paintWorn);
    }
    const cx = x + w / 2;
    const cy = y + h / 2;
    g.circle(cx, cy, 20).stroke({ color: OUT.paint, width: 4 });
    g.circle(cx, cy, 11).stroke({ color: OUT.paintWorn, width: 3 });
    g.circle(cx, cy, 4).fill({ color: OUT.paint });
  }
}

/**
 * The ground outside a building's entrances.
 *
 * From the street a player has to be able to see where a building can be entered,
 * and in a lit model that cannot be a dashed annotation — the reveal itself is
 * hidden under the roof from out here. It has to be something really on the
 * ground: a concrete apron where the traffic lands.
 *
 * A vehicle door gets a wide slab with wheel tracks worn into it and a stop line;
 * a person door gets a small paved landing. Both are only *paint and paving*, so
 * nothing here implies collision the data does not declare.
 */
function drawEntranceAprons(g: Graphics, map: MapDocument): void {
  for (const building of map.buildings) {
    const fp = building.footprint;
    for (const entrance of perimeterEntrances(building)) {
      const { door, vehicle } = entrance;
      const across = isAcross(entrance.side);
      const apron = outwardBand(entrance, fp, vehicle ? 74 : 30, door.width / 2 + (vehicle ? 10 : 6));

      /**
       * A wash, not a fill.
       *
       * This used to be an opaque `block * 1.03`, which was a subtle lift back
       * when the whole sheet was one tone. Now that ground has a value scale, the
       * same fill over a service yard is nine steps brighter than everything
       * round it and the apron reads as a sheet of paper dropped on the site.
       * Washing the surface underneath lifts a yard apron and a footway apron by
       * the same *amount* instead of to the same value.
       */
      g.rect(apron.x, apron.y, apron.w, apron.h).fill({ color: 0xffffff, alpha: 0.16 });
      // A saw-cut joint around the slab, the way a real pour is separated.
      g.rect(apron.x, apron.y, apron.w, apron.h).stroke({ color: OUT.blockJoint, width: 1.2, alpha: 0.7 });
      if (!vehicle) continue;

      // Wheel tracks worn into the slab along the drive-in path. Kept close to
      // the apron's own value: these are wear, not painted lines, and at street
      // zoom a strong pair of bars reads as bollards standing in the doorway.
      const gauge = door.width * 0.3;
      for (const offset of [-gauge, gauge]) {
        const track = across
          ? { x: door.x + offset - 4, y: apron.y + 5, w: 8, h: apron.h - 10 }
          : { x: apron.x + 5, y: door.y + offset - 4, w: apron.w - 10, h: 8 };
        g.rect(track.x, track.y, track.w, track.h).fill({ color: 0x000000, alpha: 0.07 });
      }

      // Stop line, on the threshold end of the apron — the side against the wall.
      const stop = 5;
      const inset = 11;
      const atLowSide = entrance.side === "S" || entrance.side === "E";
      inlay(g, across
        ? { x: door.x - door.width / 2, y: atLowSide ? apron.y + inset : apron.y + apron.h - inset - stop, w: door.width, h: stop }
        : { x: atLowSide ? apron.x + inset : apron.x + apron.w - inset - stop, y: door.y - door.width / 2, w: stop, h: door.width },
        OUT.paintWorn);
    }
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildOutdoorModel(map: MapDocument): OutdoorModel {
  const ground = new Container();
  const detail = new Container();
  const objects = new Container();

  const blocks = new Graphics();
  const carriageway = new Graphics();
  const planting = new Graphics();
  const pads = new Graphics();

  const pad: ShadowPad = SHADOW_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
  const aoPad: ShadowPad = AO_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });

  drawBlocks(blocks, map);
  drawCarriageway(carriageway, pad, map);
  drawPlanting(planting, pad, map);
  drawEntranceAprons(pads, map);
  drawExtractionPads(pads, map);

  // Outdoor collision that isn't the sheet edge — hedges, site walls.
  const siteWalls = new Graphics();
  for (const wall of map.outdoor.walls) {
    const atEdge = wall.x <= 0 || wall.y <= 0 || wall.x + wall.w >= map.width || wall.y + wall.h >= map.height;
    if (atEdge) continue;
    occlude(aoPad, wall, 9);
    contact(pad, wall, 9);
    inlay(siteWalls, wall, V.wallCap);
    inlay(siteWalls, { x: wall.x, y: wall.y + wall.h - 4, w: wall.w, h: 4 }, V.wall);
  }

  /**
   * Outdoor barriers: sea walls, quaysides, cliff faces. Drawn with the same
   * extrusion as an interior wall, so a curved quay reads as the same material as
   * everything else standing on the sheet.
   */
  for (const barrier of map.outdoor.barriers ?? []) {
    // Shared with the interior path on purpose. This grouping was duplicated here,
    // and the copy carried the same unclosed-loop bug that left a step at one
    // corner of every closed shell; two implementations of one rule is how that
    // comes back.
    for (const run of capsuleRuns(barrier)) {
      const outline = pathOutline(run.points, run.thickness);
      if (outline.length < 3) continue;
      contactShape(pad, outline, 12);
      volumeShape(siteWalls, outline, { top: V.wallCap, front: V.wall, edge: 0x0b0e11, lit: 0x4d5359 }, 11);
    }
    for (const item of barrier.solids) {
      if (item.kind !== "poly") continue;
      contactShape(pad, item.points, 12);
      volumeShape(siteWalls, item.points, { top: V.wallCap, front: V.wall, edge: 0x0b0e11, lit: 0x4d5359 }, 11);
    }
  }

  /**
   * Ground markings first, then everything standing on the ground.
   *
   * The split matters as much as the sort. A parking stall is paint: it has no
   * height, so it cannot occlude and it must never draw over the thing parked in
   * it. Sorting the whole list by bottom edge put every stall (bottom 142) after
   * the car inside it (bottom 134), which laid the bay's markings straight across
   * the car — the lines that appeared to run through every parked vehicle on the
   * map. `modelFloor` already made this split for interiors with `FLAT_KINDS`;
   * outdoors never got it.
   */
  const markings: Graphics[] = [];
  const solid: Graphics[] = [];
  const passable: Graphics[] = [];
  for (const object of [...map.outdoor.objects].sort((a, b) => a.y + a.h - (b.y + b.h))) {
    const g = new Graphics();
    drawModelObject(g, pad, object);
    if (FLAT_KINDS.has(object.kind)) markings.push(g);
    else if (object.solid === false) passable.push(g);
    else {
      occlude(aoPad, object, 6);
      solid.push(g);
    }
  }

  ground.addChild(blocks, carriageway, planting, pads, ...markings, ...aoPad, ...pad, siteWalls);
  // Pixi throws on a zero-argument addChild, and a map may legitimately have no
  // passable dressing or no solid fixtures outdoors.
  if (passable.length) detail.addChild(...passable);
  if (solid.length) objects.addChild(...solid);
  return { ground, detail, objects };
}

/** Kerb rise, exported so building entrances can meet the sidewalk correctly. */
export { KERB_RISE, OUT };
