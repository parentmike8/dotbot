import { Container, Graphics } from "pixi.js";
import { isGroundFloor } from "@dotbot/game/mapModel";
import { insetPolygon } from "@dotbot/game/geometry";
import type { Building, Rect, Vec2 } from "@dotbot/game/types";
import { inwardBand, isAcross, outwardBand, perimeterEntrances, type PerimeterEntrance } from "./entrances";
import { drawModelObject } from "./modelGlyphs";
import { collectMovers, type AmbientMover } from "./modelMotion";
import { drawBarrier, drawWallRects, ROOF_BULKHEAD } from "./modelWalls";
import {
  AO_ALPHA,
  contact,
  contactBlock,
  contactBlockShape,
  inlay,
  jitter,
  LIFT,
  MAT,
  occlude,
  occludeShape,
  seam,
  shade,
  SHADOW_ALPHA,
  SHADOW_TOTAL,
  V,
  volume,
  volumeShape,
  type ShadowPad,
} from "./tone";

/**
 * A building seen from the street: its roof.
 *
 * The old language drew a blank concealment plate, which is why the exterior read
 * as a diagram of blocks. A roof is a real surface with a parapet standing above
 * it, a membrane laid in sheets, and equipment sitting where the building below
 * needs it — so it gets the same volume, light and shadow as everything else, and
 * the parapet's cast shadow on its own deck is what sells the building's height.
 */

/** A closed ring, filled flat. Nothing here lifts, so there is no face to light. */
function fillShape(g: Graphics, points: Vec2[], color: number): void {
  if (points.length < 3) return;
  g.poly(points.map((at) => [at.x, at.y]).flat()).fill({ color });
}

/** The axis-aligned extent of a ring, for sizing work that is then clipped to it. */
function shapeBounds(points: Vec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const at of points) {
    if (at.x < minX) minX = at.x;
    if (at.y < minY) minY = at.y;
    if (at.x > maxX) maxX = at.x;
    if (at.y > maxY) maxY = at.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Mirrors the floor model's layer contract, because a roof is reached two ways:
 * as a building's generated exterior, and as an authored ROOF plan a player can
 * actually walk on. Both must be the same surface.
 */
export type RoofModel = {
  view: Container;
  /**
   * Everything above ground level, which is everything that parallaxes. Clipped
   * to the footprint. The cast shadow and the wall plate stay behind in `view`:
   * a shadow that slid with the roof would be a building sliding rather than a
   * building standing up, and it has to spill onto the street, which a clipped
   * layer cannot do.
   */
  mass: Container;
  architecture: Container;
  furniture: Container;
  objectViews: Map<string, { object: import("@dotbot/game/types").MapObject; view: Graphics }>;
  /**
   * Ambient moving parts on an authored roof deck — see `modelMotion`.
   *
   * Empty today, and a roof is the one place where that is worth collecting anyway rather
   * than assuming: the planters and trees on a roof garden are exactly the subject that
   * sways, and a deck is authored the same way a floor is.
   */
  movers: AmbientMover[];
};

const ROOF = {
  /** Membrane field. Darker than the sidewalk so a block reads as raised. */
  membrane: 0xbcc0c4,
  membraneLit: 0xc6cacd,
  /** Sheet laps across the field. */
  lap: 0xb1b5ba,
  /**
   * Parapet coping: a lit cap on a dark upstand.
   *
   * This was 0xdfe2e5 — brighter than the pavement it sat against — and it ran
   * flush to the footprint, so every building in the city wore a near-white line
   * all the way round. It matches the site walls' lit edge now, because a parapet
   * and a yard wall are the same material in the same light.
   */
  coping: 0x4d5359,
  /** A small surface the light reaches square on: a walkway's edge, a soffit. */
  sunlit: 0xdfe2e5,
  /** Weathering that collects in the low corners. */
  soil: 0xadb1b6,
  /** Inside a doorway reveal, below the roof plane and out of the light. */
  reveal: 0x7f858b,
  /** A floor slab's edge in the south wall: the one horizontal in a vertical face. */
  slab: 0x2f353b,
} as const;

/** Where a roof's service zone is: over the deepest wall-backed strip. */
function serviceEdge(fp: Rect): Rect {
  return { x: fp.x + fp.w * 0.58, y: fp.y + 22, w: fp.w * 0.36, h: 54 };
}

/** Above-ground storeys. A basement adds no height and the roof is not a storey. */
export function aboveGroundStoreys(building: Building): number {
  const counted = building.floors.filter((floor) => floor.label !== "ROOF" && !floor.label.startsWith("B"));
  return Math.max(1, counted.length);
}

/**
 * Apparent height for the block's cast shadow, in the same units as `LIFT`.
 *
 * The ground floor keeps the figure every building used to have, so nothing
 * single-storey moves; each further storey adds a fraction of it rather than a
 * multiple, because shadow length is being used to rank buildings against each
 * other, not to measure them.
 */
const STOREY_BASE = LIFT.wall * 2.4;
const STOREY_STEP = LIFT.wall * 1.1;

export function storeyShadowLift(building: Building): number {
  return STOREY_BASE + (aboveGroundStoreys(building) - 1) * STOREY_STEP;
}

/**
 * How far a block's roof slides against its own footprint, per unit of apparent
 * height, per unit of distance from where the camera is looking.
 *
 * This is parallax, and it is the whole of what tells you a building is tall
 * besides its shadow. A static south face was tried first and cut: it commits
 * every building on the map to a permanent black band on one side, which is only
 * ever right for a camera sitting due south of it.
 *
 * Small on purpose: enough that the eye reads the mass as standing up, far too
 * little to argue with the collider underneath it. What the slide uncovers on the
 * trailing side is the building's own wall plate, and the mass is clipped to the
 * footprint on the leading side, so the silhouette drawn is exactly the rectangle
 * that blocks you — at every camera position, which is a promise this had to earn
 * rather than assert.
 */
const PARALLAX_PER_UNIT = 0.00028;

/**
 * Ceiling on the slide, however far off-axis a block sits.
 *
 * This was 7, and 7 was the reason a seven-storey tower barely moved: Civic hit
 * the ceiling at a third of the way across the sheet, so from there out it and a
 * two-storey clinic slid by exactly the same amount. A cap set below what the
 * tallest thing on the map wants does not restrain the effect, it deletes the
 * ranking the effect exists to show. It sits above Civic's reach now, so the cap
 * is a backstop for absurd geometry rather than a governor on the common case.
 */
const PARALLAX_MAX = 26;

/**
 * How far the roof of a block slides, given where it sits relative to the point
 * the camera is looking at and the shared production/lab strength.
 *
 * Real parallax: a point at height h over ground position P appears displaced
 * from P away from the camera's axis, in proportion to both the height and the
 * distance off-axis. Which is why the units are per-unit-of-each. Production passes
 * the restrained shared strength; `1` remains available for deliberate lab comparisons.
 */
export function roofParallax(building: Building, viewCenter: Vec2, strength = 1): Vec2 {
  const fp = building.footprint;
  const scale = storeyShadowLift(building) * PARALLAX_PER_UNIT * Math.max(0, strength);
  const dx = (fp.x + fp.w / 2 - viewCenter.x) * scale;
  const dy = (fp.y + fp.h / 2 - viewCenter.y) * scale;
  const distance = Math.hypot(dx, dy);
  if (distance <= PARALLAX_MAX) return { x: dx, y: dy };
  return { x: (dx / distance) * PARALLAX_MAX, y: (dy / distance) * PARALLAX_MAX };
}

export function buildRoofModel(building: Building): RoofModel {
  const fp = building.footprint;
  const roof: Rect = fp;
  /**
   * The building's real plan, when it has one.
   *
   * Everything below was written against `fp`, the axis-aligned bounding box, and for
   * a box that is the same thing. It is not the same thing for an L-plan, a chamfered
   * corner or an annular sector — and `modelFloor` has clipped its slab to the outline
   * since the format grew one, so the two halves of the same building disagreed:
   * inside you were in an L, and from the street you were looking at a rectangle. The
   * roundhouse is what forced it, because a fan drawn as its bounding box is a shed
   * lying across half the yard, but Quayside's L had been doing the quieter version of
   * the same thing all along.
   */
  const plan: Vec2[] = building.outline && building.outline.length >= 3 ? building.outline : [];
  const view = new Container();
  const mass = new Container();
  const plate = new Graphics();
  const clip = new Graphics();
  const wash = new Graphics();
  const entrances = new Graphics();
  const deck = new Graphics();
  const parapet = new Graphics();
  /** Structures standing on the deck: bulkheads, machine rooms, shaft heads. */
  const bulkheads = new Graphics();
  const equipment = new Container();

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

  /**
   * The whole block casts onto the street. This is what gives a building height —
   * and it was a constant, so a seven-storey tower cast exactly the shadow a
   * single-storey shop did and the skyline had no scale in it at all.
   *
   * Height is read off shadow length in any real top-down view, and the language
   * already scales every other shadow by apparent height: a tree carries
   * `LIFT.column + 4` and gets a shadow to match. Buildings were the one thing
   * opted out. Per-floor growth is deliberately small — the shadow falls across
   * the street, and a tower whose shadow swallows the block it stands on has
   * traded one unreadable thing for another.
   *
   * `contactBlock`, not `contact`: nine steps is a ramp for furniture, and the
   * moment this figure started scaling with storeys it stopped being one. See its
   * own comment — a tower drawn on the shared ramp comes out as a stack of
   * concentric rounded rectangles.
   */
  const blockShadow = new Graphics();
  if (plan.length >= 3) contactBlockShape(blockShadow, plan, storeyShadowLift(building));
  else contactBlock(blockShadow, fp, storeyShadowLift(building));

  const wall = 12;
  /**
   * Masonry has none of the systems a modern roof is made of.
   *
   * Every mark below this line belongs to a specific building system — a lapped
   * membrane, falls to an outlet, soiling where water sits — which is the rule the
   * contract states as "every roof element belongs to a named system such as access,
   * cooling, exhaust, daylight, drainage". A stone platform has none of those systems,
   * so it gets none of those marks, and drawing them anyway would be decoration in the
   * one place the contract names outright.
   */
  const masonry = building.kind === "monument";

  if (masonry) {
    /**
     * TERRACES, and this is the whole reason `monument` exists as a kind.
     *
     * A stepped pyramid from directly overhead IS a set of concentric rings, and drawn as
     * anything else it is a grey box: the first version laid stone flags across the whole
     * base and the temple read as a warehouse somebody had paved. Each ring is a real
     * prism, so each one gets `volumeShape` — which means every riser is lit by its own
     * normal rather than by a rule about which side of a pyramid is dark, and the same code
     * gives a square base four terraces and a round tower three setbacks.
     */
    const short = Math.min(roof.w, roof.h);
    const steps = Math.max(3, Math.min(6, Math.round(short / 120)));
    const tread = (short * 0.3) / steps;
    const base: Vec2[] = plan.length ? plan : [
      { x: roof.x, y: roof.y },
      { x: roof.x + roof.w, y: roof.y },
      { x: roof.x + roof.w, y: roof.y + roof.h },
      { x: roof.x, y: roof.y + roof.h },
    ];
    for (let step = 0; step < steps; step += 1) {
      const ring = insetPolygon(base, step * tread);
      if (ring.length < 3) break;
      // Higher courses are cleaner: rain and feet wear the bottom ones.
      volumeShape(deck, ring, step > steps - 2 ? MAT.stone : MAT.stoneWorn, LIFT.mass * 0.55);
    }
    // The summit platform's own flags, so the top is a surface rather than a small hole.
    const summit = insetPolygon(base, steps * tread);
    if (summit.length >= 3) {
      for (let i = 0; i < 8; i += 1) {
        const bounds = { x: roof.x, y: roof.y, w: roof.w, h: roof.h };
        const size = 30 + jitter(building.id, i) * 40;
        inlay(deck, {
          x: bounds.x + short * 0.34 + jitter(building.id, i + 20) * Math.max(1, roof.w - short * 0.7 - size),
          y: bounds.y + short * 0.34 + jitter(building.id, i + 40) * Math.max(1, roof.h - short * 0.7 - size),
          w: size,
          h: size * 0.72,
        }, shade(MAT.stone.top, i % 3 === 0 ? 1.05 : 0.96));
      }
    }

    /**
     * The grand stairway, cut through the terraces at the door that earns one.
     *
     * Derived, not decorated: it runs at a ground-floor entrance, in the direction that
     * entrance faces, as deep as the terraces are. Which means the pyramid's south arch —
     * the one at the foot of the real GROUND → ROOF flight inside — grows the flight of
     * steps a player can see from the plaza, while its 96-wide north arch into the tomb
     * does not, and the observatory's 84-wide door does not either. A wide ceremonial arch
     * is the map already saying "this is the way up".
     */
    for (const entrance of perimeterEntrances(building)) {
      if (entrance.door.width < 120) continue;
      const half = entrance.door.width / 2 + 4;
      const run = inwardBand(entrance, fp, short * 0.3 + tread, half);
      const across = isAcross(entrance.side);
      // A course lighter than the terraces it cuts through, so the flight reads from the
      // plaza. In `MAT.stone.top` against `MAT.stoneWorn.top` it was thirteen steps of
      // difference and vanished at region zoom.
      inlay(deck, run, shade(MAT.stone.top, 1.07));
      // Treads across the flight, and a balustrade down each flank.
      const span = across ? run.h : run.w;
      const pitch = Math.max(11, span / 12);
      for (let at = pitch; at < span - 1; at += pitch) {
        inlay(deck, across
          ? { x: run.x + 7, y: run.y + at - 1.5, w: run.w - 14, h: 3 }
          : { x: run.x + at - 1.5, y: run.y + 7, w: 3, h: run.h - 14 },
          shade(MAT.stone.front, 0.72));
      }
      for (const rail of across
        ? [{ x: run.x, y: run.y, w: 7, h: run.h }, { x: run.x + run.w - 7, y: run.y, w: 7, h: run.h }]
        : [{ x: run.x, y: run.y, w: run.w, h: 7 }, { x: run.x, y: run.y + run.h - 7, w: run.w, h: 7 }]
      ) {
        inlay(deck, rail, MAT.stoneWorn.front);
        inlay(deck, { ...rail, h: across ? rail.h : 2, w: across ? 2 : rail.w }, MAT.stone.lit);
      }
    }
  } else {
    inlay(deck, roof, ROOF.membrane);

    // Membrane laid in sheets, lapped north to south.
    const sheet = 92;
    for (let y = roof.y + sheet; y < roof.y + roof.h; y += sheet) {
      inlay(deck, { x: roof.x, y: y - 1, w: roof.w, h: 2 }, ROOF.lap);
      inlay(deck, { x: roof.x, y: y - 1, w: roof.w, h: 0.8 }, ROOF.membraneLit);
    }

    // Falls: the deck drains toward outlets, so it darkens away from the ridge.
    for (let i = 0; i < 4; i += 1) {
      const t = i / 4;
      inlay(
        deck,
        { x: roof.x + wall, y: roof.y + roof.h - wall - (roof.h * 0.34) * (1 - t), w: roof.w - wall * 2, h: 2 + t * 8 },
        shade(ROOF.membrane, 0.985),
      );
    }

    // Soiling in the corners, where nothing sweeps and water sits.
    for (const [cx, cy] of [
      [roof.x + wall, roof.y + wall],
      [roof.x + roof.w - wall - 60, roof.y + wall],
      [roof.x + wall, roof.y + roof.h - wall - 60],
      [roof.x + roof.w - wall - 60, roof.y + roof.h - wall - 60],
    ]) {
      inlay(deck, { x: cx, y: cy, w: 60, h: 60 }, ROOF.soil);
    }
  }

  /**
   * Parapet: a continuous upstand, standing back off the wall face, with its coping
   * inside. Its shadow falls onto its own deck along the north and west runs, which
   * is the cue that reads as "this surface is below that wall" rather than "this is
   * a drawn outline".
   *
   * Two things were wrong here, and both came of building the ring out of four runs
   * and lighting each one along its own north and west edge. The coping landed on
   * the *inner* face of the south and east runs, and it landed flush to the
   * building's outer edge on the north and west ones — so what a bot rested against
   * outdoors was a bright line, not a wall. Contract §3 settles that: dark, closed
   * outlines mean solid, so the wall top stays dark to the very edge and the coping
   * sits inboard of it. Which is how a parapet is built anyway — the stone is set
   * back off the face, with the wall below it in shadow.
   *
   * And because each run lit its own north edge, the side runs each put a
   * `wall` x 3.5 block of coping under the north parapet: a bright step at all four
   * corners of a line that should be continuous. One ring, drawn once, has no
   * corners to get wrong.
   */
  const inner: Rect = { x: roof.x + wall, y: roof.y + wall, w: roof.w - wall * 2, h: roof.h - wall * 2 };
  const reveal = 2.5; // the wall face below the coping: dark, and the building's edge
  const stone = 4.5;
  if (plan.length) {
    /**
     * A parapet on a plan of any shape, drawn as two strokes rather than four runs.
     *
     * A ring stroked along `insetPolygon(plan, wall / 2)` at width `wall` lands exactly
     * inside the outline however many corners it has, so the upstand follows a curve
     * without anyone having to decide which of four sides a diagonal edge belongs to.
     * Same two values as the rect version, in the same order — dark to the very edge,
     * coping set back inboard of it.
     */
    ringStroke(parapet, insetPolygon(plan, wall / 2), wall, V.wallCap);
    ringStroke(parapet, insetPolygon(plan, reveal + stone / 2), stone, ROOF.coping);
  } else {
    for (const run of [
      { x: roof.x, y: roof.y, w: roof.w, h: wall },
      { x: roof.x, y: roof.y + roof.h - wall, w: roof.w, h: wall },
      { x: roof.x, y: roof.y + wall, w: wall, h: roof.h - wall * 2 },
      { x: roof.x + roof.w - wall, y: roof.y + wall, w: wall, h: roof.h - wall * 2 },
    ]) {
      inlay(parapet, run, V.wallCap);
    }
    // The coping is a horizontal top surface, so it takes one value all the way
    // round: under a single light, only faces that turn differ.
    const cap: Rect = { x: roof.x + reveal, y: roof.y + reveal, w: roof.w - reveal * 2, h: roof.h - reveal * 2 };
    for (const band of [
      { x: cap.x, y: cap.y, w: cap.w, h: stone },
      { x: cap.x, y: cap.y + cap.h - stone, w: cap.w, h: stone },
      { x: cap.x, y: cap.y, w: stone, h: cap.h },
      { x: cap.x + cap.w - stone, y: cap.y, w: stone, h: cap.h },
    ]) {
      inlay(parapet, band, ROOF.coping);
    }
  }
  // Inner shadow cast by the north and west parapet onto the deck.
  for (let i = 0; i < 5; i += 1) {
    const t = i / 5;
    const reach = 14 * (1 - t) + 2;
    parapet.rect(inner.x, inner.y, inner.w, reach).fill({ color: 0x000000, alpha: 0.035 });
    parapet.rect(inner.x, inner.y, reach, inner.h).fill({ color: 0x000000, alpha: 0.028 });
  }

  // Roof access over the service zone, plus drainage outlets at the low corners.
  // Both are building systems, so masonry gets neither: the way onto a platform is
  // the stair up its own face, and it drains off the edge.
  const service = serviceEdge(roof);
  const hatch: Rect = { x: service.x, y: service.y, w: 54, h: 44 };
  if (!masonry) {
    occlude(aoPad, hatch, 7);
    contact(pad, hatch, LIFT.cabinet);
    const lid = volume(equipmentGraphics(equipment), hatch, MAT.steelDark, LIFT.cabinet, 2);
    seam(
      equipmentGraphics(equipment),
      lid.x + lid.w * 0.5, lid.y + 2, lid.x + lid.w * 0.5, lid.y + lid.h - 2,
      MAT.steelDeep.top, 1.1,
    );

    for (const [ox, oy] of [
      [roof.x + wall + 26, roof.y + roof.h - wall - 26],
      [roof.x + roof.w - wall - 26, roof.y + roof.h - wall - 26],
    ]) {
      const g = equipmentGraphics(equipment);
      // A dished sump with a straight-barred leaf grate. Bars, not radial spokes:
      // spokes read as a swirl, and nothing that moves gets a static mark.
      g.circle(ox, oy, 10).fill({ color: shade(ROOF.membrane, 0.9) });
      g.circle(ox, oy, 6.5).fill({ color: MAT.steelDeep.front });
      for (const off of [-3.2, 0, 3.2]) {
        g.rect(ox - 5.6, oy + off - 0.6, 11.2, 1.2).fill({ color: MAT.steelDark.top });
      }
    }
  }

  // Any authored ROOF plan's own objects still draw; otherwise derive a small
  // plant run along the service edge so the roof belongs to the building below.
  const objectViews = new Map<string, { object: import("@dotbot/game/types").MapObject; view: Graphics }>();
  const movers: AmbientMover[] = [];
  const authored = building.floors.find((floor) => floor.label === "ROOF");
  if (authored) {
    /**
     * The plan's own walls: bulkheads, machine rooms, the shaft that carries on up.
     *
     * These had no drawing path at all. The compiler turns authored path walls into
     * `barriers`, physics and line-of-sight both consume them, and this function read
     * neither — so Civic's machine room and its NE stair shaft were colliders and
     * sight-blockers that put nothing on screen. Play reported the exact symptom from
     * the deck: "there's a room over to the left. You can see the shadows, but I don't
     * actually see the walls that are creating the shadows", and the stair behind them
     * "just a slightly see-through grey box" — the grey being the fog these invisible
     * walls were casting, with the flight legitimately hidden behind it.
     *
     * Which makes it the same defect as every other one this map has had: the collider
     * and the silhouette came from different code. There is one wall drawing path now,
     * shared with every interior floor.
     */
    drawWallRects(bulkheads, pad, authored.walls, ROOF_BULKHEAD);
    for (const barrier of authored.barriers ?? []) {
      // The shell is the parapet's job; drawing it again would double the upstand.
      if (barrier.id === "ROOF-shell") continue;
      drawBarrier(bulkheads, pad, barrier, ROOF_BULKHEAD);
    }
    for (const object of [...authored.objects].sort((a, b) => a.y + a.h - (b.y + b.h))) {
      const g = new Graphics();
      occlude(aoPad, object, 6);
      drawModelObject(g, pad, object);
      equipment.addChild(g);
      objectViews.set(object.id, { object, view: g });
      movers.push(...collectMovers(g, object));
    }
  } else if (!masonry && building.kind === "retail") {
    /**
     * A hall gets a LANTERN, not a plant deck.
     *
     * The derived roof below fits an office block, a warehouse or a hospital, because all
     * three really do carry air handling on the roof. A pleasure pavilion does not: what
     * is on top of a single-span hall is the rooflight that lights the floor under it, and
     * an air handler up there is a system the building below has none of — the one thing
     * the roof rules forbid outright.
     */
    const light: Rect = {
      x: roof.x + roof.w * 0.5 - roof.w * 0.17,
      y: roof.y + roof.h * 0.5 - roof.h * 0.17,
      w: roof.w * 0.34,
      h: roof.h * 0.34,
    };
    const g = new Graphics();
    /**
     * The lantern is the SHAPE OF THE HALL, not a square on top of one.
     *
     * A rooflight lights the span beneath it, so it is concentric with that span
     * and follows its edges — an octagonal pavilion carries an octagonal lantern,
     * the way every real one does. Drawn as a rect it read, in Mike's words, as a
     * full square around a building that is a circle: the single loudest mark on
     * the region contradicting the one form the region is built around.
     *
     * The glazing bars stay PARALLEL rather than radiating from the centre. Radial
     * line work on a round object reads as a dial — the failure recorded three
     * times over in `modelLandmarks` — and a real lantern is glazed in straight
     * runs anyway. They are clipped to the glass, so they stop on the facets.
     */
    if (plan.length >= 3) {
      const short = Math.min(roof.w, roof.h);
      const ring = insetPolygon(plan, short * 0.33);
      const glass = ring.length >= 3 ? insetPolygon(ring, 3) : [];
      if (glass.length >= 3) {
        occludeShape(aoPad, ring, 8);
        fillShape(g, ring, MAT.steelDark.top);
        fillShape(g, glass, V.glass);

        const bars = new Graphics();
        const bounds = shapeBounds(glass);
        const across = bounds.w >= bounds.h;
        const lights = Math.max(2, Math.round((across ? bounds.w : bounds.h) / 22));
        for (let i = 1; i < lights; i += 1) {
          const at = ((across ? bounds.w : bounds.h) / lights) * i;
          inlay(
            bars,
            across
              ? { x: bounds.x + at, y: bounds.y, w: 1.4, h: bounds.h }
              : { x: bounds.x, y: bounds.y + at, w: bounds.w, h: 1.4 },
            V.glassFrame,
          );
        }
        const barMask = new Graphics();
        fillShape(barMask, glass, 0xffffff);
        bars.mask = barMask;
        g.addChild(barMask);
        g.addChild(bars);
      }
    } else {
      occlude(aoPad, light, 8);
      drawModelObject(g, pad, { id: `${building.id}-lantern`, kind: "skylight", ...light });
    }
    equipment.addChild(g);
  } else if (!masonry && fp.w * fp.h >= 150_000) {
    /**
     * A derived roof still has to belong to the building underneath it.
     *
     * Plant alone was not enough: Mercy Clinic's roof is 620 x 440 and had five
     * air handlers in one corner, so from the street it read as an empty grey
     * field — half the block's buildings looked unfinished next to the two with
     * authored roofs. Two systems fix it and both are real, which is what keeps
     * them inside the contract's "no decoration" rule.
     *
     * A **walkway** from the hatch along the plant run, because somebody has to
     * service those units without walking on the membrane. And **rooflights** over
     * the span, which are the most characteristic thing on a long-span roof —
     * three rows for a warehouse, two for a hospital, none where the floor below
     * is cellular and would not take them.
     */
    const walk: Rect = { x: inner.x + 20, y: service.y + service.h + 26, w: inner.w - 40, h: 22 };
    inlay(deck, walk, shade(ROOF.membrane, 1.05));
    inlay(deck, { x: walk.x, y: walk.y, w: walk.w, h: 1.6 }, ROOF.sunlit);
    // Duckboard slats, so the strip reads as a laid walkway rather than a stripe.
    for (let x = walk.x + 12; x < walk.x + walk.w - 4; x += 26) {
      inlay(deck, { x, y: walk.y + 2, w: 2, h: walk.h - 4 }, shade(ROOF.membrane, 0.94));
    }
    // Spur up to the access hatch.
    inlay(deck, {
      x: hatch.x + hatch.w / 2 - 11,
      y: hatch.y + hatch.h,
      w: 22,
      h: Math.max(0, walk.y - (hatch.y + hatch.h)),
    }, shade(ROOF.membrane, 1.05));

    const rows = building.kind === "warehouse" ? 3 : building.kind === "hospital" ? 2 : 0;
    const lightW = 120;
    const lightH = 64;
    const cols = Math.max(1, Math.floor((inner.w - 80) / (lightW + 46)));
    const startY = walk.y + walk.h + 34;
    const pitch = rows > 0 ? (inner.y + inner.h - 40 - startY) / rows : 0;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const light: Rect = {
          x: inner.x + 40 + col * (lightW + 46),
          y: startY + row * pitch,
          w: lightW,
          h: lightH,
        };
        if (light.y + light.h > inner.y + inner.h - 30) continue;
        if (light.x + light.w > inner.x + inner.w - 20) continue;
        const g = new Graphics();
        drawModelObject(g, pad, {
          id: `${building.id}-roof-light-${row}-${col}`,
          kind: "skylight",
          ...light,
        });
        equipment.addChild(g);
      }
    }

    const units = Math.max(1, Math.round(service.w / 90));
    for (let i = 0; i < units; i += 1) {
      const unit: Rect = {
        x: service.x + 64 + i * 86,
        y: service.y + 4 + jitter(building.id, i) * 6,
        w: 70,
        h: 50,
      };
      if (unit.x + unit.w > roof.x + roof.w - wall - 8) break;
      const g = new Graphics();
      occlude(aoPad, unit, 6);
      drawModelObject(g, pad, { id: `${building.id}-roof-hvac-${i}`, kind: "hvac", ...unit });
      equipment.addChild(g);
    }
  }

  /**
   * The wall plate: the building's own mass, at the footprint, under everything
   * that slides.
   *
   * This is what makes the parallax safe. The roof rides a few units off-centre,
   * and whatever it uncovers on the far side has to be *something* — without the
   * plate it would be a sliver of the site surface showing through, which reads as
   * a gap under the building. With it, the sliver is wall, which is what is
   * actually there. The silhouette stays the footprint at every camera position,
   * so the contract's promise that the drawn shape is the collider survives a
   * moving camera.
   */
  /**
   * At the PLAN, not the bounding box.
   *
   * At the box, four of the world's nine buildings rendered as solid black rectangles with
   * a lighter shape inside: the plate filled the whole bbox in `V.wall`, the mass on top of
   * it was correctly clipped to the outline, and everything the mass did not cover stayed
   * wall. A roundhouse fan, an octagonal pavilion and a round tower each lost half their
   * bbox to it.
   *
   * The plate is the last thing in the roof pass that was reading a rectangle as a plan.
   * `modelFloor`, `connectivityIssues`, `contactBlockShape` and the parapet all had the same
   * defect and all had it for the same reason — the format grew arbitrary outlines and every
   * consumer that predated them kept using `footprint` because for a box the two agree.
   */
  if (plan.length) fillPolygon(plate, plan, V.wall);
  else inlay(plate, fp, V.wall);

  /**
   * The block's shadow rides with the mass rather than staying on the ground.
   *
   * Which is not what a shadow does, and is still right here. This shadow has a
   * second job nobody designed: it is drawn over the deck, so a roof's apparent
   * tone is its membrane value *under* the wash, and `ROOF.membrane` was picked by
   * eye that way — "darker than the sidewalk so a block reads as raised". Pinning
   * the shadow to the ground meant the wall plate blocked it, every roof in the
   * city went pale, and buildings stopped sitting above the pavement at all.
   *
   * The alternative was to restyle the whole roof palette to bake the wash in.
   * That is the better end state and a much larger change than parallax has any
   * business dragging in. Riding along costs at most `PARALLAX_MAX` units of drift
   * on a soft gradient, which is not visible; a flat city is.
   */
  /**
   * Doorways are at ground level, so they are cut last and they do not move.
   *
   * They used to be drawn into the parapet, which put them inside the mass — and
   * the moment the mass started sliding, every door slid with it and stopped
   * meeting the apron painted on the pavement outside. Worse, the wall plate then
   * showed *through* the gap between them, so an entrance read as an opening onto
   * the roof rather than a way into the building.
   *
   * Above the mass rather than under it, because that is what an opening is: the
   * building is missing here, all the way down. Painting it last is the cheapest
   * true statement of that.
   */
  drawEntranceRecesses(entrances, building);

  /**
   * The mass is clipped to the footprint, and the cast shadow is not.
   *
   * Parallax slides the mass, and a comment here used to claim it "never leaves
   * the footprint". It does — on the leading side. The plate covers the trailing
   * side, so the silhouette came out as the union of two offset rectangles: a
   * clean right-angle jog in what should be one straight wall, at the corner of
   * every building on the map.
   *
   * Clipping the mass to the footprint fixes it exactly, and forces something
   * that was already overdue. The block shadow had been riding inside the mass
   * because it doubles as the wash that darkens the roof deck — but a shadow has
   * to spill onto the *street*, and a clipped shadow cannot. So the two jobs are
   * finally separated: a real cast shadow outside, and an explicit deck wash at
   * the exact composite the shadow used to deliver, so no roof changes value.
   */
  if (plan.length) clip.poly(plan.map((point) => ({ x: point.x, y: point.y }))).fill({ color: 0xffffff });
  else inlay(clip, fp, 0xffffff);
  // The deck wash follows the same plan: inside the mask it makes no difference, and it
  // means every surface in this pass is measured off one shape.
  if (plan.length) wash.poly(plan.map((point) => ({ x: point.x, y: point.y }))).fill({ color: 0x000000, alpha: SHADOW_TOTAL });
  else wash.rect(fp.x, fp.y, fp.w, fp.h).fill({ color: 0x000000, alpha: SHADOW_TOTAL });

  const architecture = new Container();
  architecture.addChild(deck, wash, ...aoPad, ...pad, parapet, bulkheads);
  mass.addChild(architecture, equipment);
  mass.mask = clip;
  view.addChild(blockShadow, plate, mass, clip, entrances);
  return { view, mass, architecture, furniture: equipment, objectViews, movers };
}

/**
 * The step or ramp standing out from a doorway onto the pavement.
 *
 * The apron already painted outside every door says "the way in is here" and says
 * it flat on the ground, which is fine for a plan and not enough for a world with
 * parallax in it: the mass above now visibly stands up, and the one place you
 * actually enter it stayed a rectangle of lighter paving.
 *
 * A person door gets a step, a vehicle door gets a ramp — a ramp because a
 * roll-up takes wheels, and a step across it would be a lie a player finds out
 * about by driving at it. Both are low and walkable, and both sit *outside* the
 * footprint, which the silhouette rule allows: only solids owe their outline to a
 * collider. Nothing here blocks anything, and nothing here is drawn dark enough
 * to claim it does.
 */
function drawThreshold(g: Graphics, entrance: PerimeterEntrance, fp: Rect, half: number): void {
  const { vehicle } = entrance;
  const across = isAcross(entrance.side);
  const reach = vehicle ? 15 : 10;
  const pad = outwardBand(entrance, fp, reach, half + (vehicle ? 4 : 3));
  const lift = vehicle ? LIFT.flat : LIFT.low;

  // `contactBlock`, not `contact`: the pad form carries its opacity on each
  // layer's container, so handing it one shared Graphics nine times paints a
  // solid black blob rather than a shadow.
  contactBlock(g, pad, lift, 1);
  const top = volume(g, pad, MAT.steel, lift, 1);

  if (vehicle) {
    // A ramp is one surface running down to the road, so it takes a gradient
    // rather than the tread lines a step gets.
    for (let i = 0; i < 4; i += 1) {
      const t = (i + 1) / 5;
      const band = across
        ? { x: top.x, y: entrance.side === "N" ? top.y : top.y + top.h * (1 - t), w: top.w, h: top.h * 0.25 }
        : { x: entrance.side === "W" ? top.x : top.x + top.w * (1 - t), y: top.y, w: top.w * 0.25, h: top.h };
      inlay(g, band, shade(MAT.steel.top, 0.98 - i * 0.015));
    }
    return;
  }

  // Two treads, so a step reads as a step and not as a plate lying in the street.
  for (const at of [0.38, 0.72]) {
    inlay(g, across
      ? { x: top.x + 2, y: top.y + top.h * at, w: top.w - 4, h: 1 }
      : { x: top.x + top.w * at, y: top.y + 2, w: 1, h: top.h - 4 }, MAT.steel.edge);
  }
}

/**
 * Entrances, cut through the roof.
 *
 * From the street a player only ever sees a building's roof, so a continuous
 * parapet says "no way in" all the way round — which is exactly what the depot
 * looked like: a solid slab with two roll-ups the player had no way to find. The
 * apron painted on the ground outside points at the door, but the wall above it
 * still has to open.
 *
 * So each ground-floor perimeter door becomes a real recess: the parapet stops,
 * the reveal drops into shadow, the head of the opening catches light on its
 * soffit, and a roll-up shows its curtain box. It reads as a doorway set back
 * under the building mass — which is what it is.
 */
function drawEntranceRecesses(g: Graphics, building: Building): void {
  const fp = building.footprint;
  const wall = 12;

  for (const entrance of perimeterEntrances(building)) {
    const half = entrance.door.width / 2;
    const depth = (entrance.door.thickness ?? wall) + 8;
    const reveal = inwardBand(entrance, fp, depth, half);
    const across = isAcross(entrance.side);

    drawThreshold(g, entrance, fp, half);

    // Clear the parapet out of the opening, then drop the reveal into shadow.
    inlay(g, reveal, ROOF.reveal);
    for (let i = 0; i < 4; i += 1) {
      const t = i / 4;
      const inset = 1 + t * (depth * 0.42);
      g.rect(reveal.x + (across ? 0 : inset), reveal.y + (across ? inset : 0),
        reveal.w - (across ? 0 : inset * 2), reveal.h - (across ? inset * 2 : 0))
        .fill({ color: 0x000000, alpha: 0.09 });
    }

    // Soffit: the head of the opening, lit where it faces the light.
    const lip = 3;
    const soffit: Rect = entrance.side === "S"
      ? { x: reveal.x, y: reveal.y + reveal.h - lip, w: reveal.w, h: lip }
      : entrance.side === "E"
        ? { x: reveal.x + reveal.w - lip, y: reveal.y, w: lip, h: reveal.h }
        : { x: reveal.x, y: reveal.y, w: across ? reveal.w : lip, h: across ? lip : reveal.h };
    inlay(g, soffit, ROOF.sunlit);

    // Jambs, standing full height either side of the opening.
    for (const jamb of across
      ? [{ x: reveal.x - lip, y: reveal.y, w: lip, h: reveal.h }, { x: reveal.x + reveal.w, y: reveal.y, w: lip, h: reveal.h }]
      : [{ x: reveal.x, y: reveal.y - lip, w: reveal.w, h: lip }, { x: reveal.x, y: reveal.y + reveal.h, w: reveal.w, h: lip }]
    ) inlay(g, jamb, V.wall);

    if (!entrance.vehicle) continue;

    // Roll-up curtain box, parked in the head of the opening.
    const box = 7;
    const curtain: Rect = entrance.side === "N"
      ? { x: reveal.x, y: reveal.y + lip, w: reveal.w, h: box }
      : entrance.side === "S"
        ? { x: reveal.x, y: reveal.y + reveal.h - lip - box, w: reveal.w, h: box }
        : entrance.side === "W"
          ? { x: reveal.x + lip, y: reveal.y, w: box, h: reveal.h }
          : { x: reveal.x + reveal.w - lip - box, y: reveal.y, w: box, h: reveal.h };
    inlay(g, curtain, V.wallCap);
    const span = across ? curtain.w : curtain.h;
    for (let at = 9; at < span - 4; at += 9) {
      inlay(g, across
        ? { x: curtain.x + at, y: curtain.y, w: 1.2, h: curtain.h }
        : { x: curtain.x, y: curtain.y + at, w: curtain.w, h: 1.2 }, ROOF.reveal);
    }
  }
}

/** Fill a polygon. Pixi wants plain objects, and the ring may be any shape. */
function fillPolygon(g: Graphics, points: Vec2[], color: number): void {
  if (points.length < 3) return;
  g.poly(points.map((point) => ({ x: point.x, y: point.y }))).fill({ color });
}

/** A band of constant width laid along a closed ring. */
function ringStroke(g: Graphics, points: Vec2[], width: number, color: number): void {
  if (points.length < 3) return;
  g.poly(points.map((point) => ({ x: point.x, y: point.y })), true)
    .stroke({ color, width, alignment: 0.5 });
}

/** One shared Graphics for small roof furniture, appended lazily. */
function equipmentGraphics(container: Container): Graphics {
  const last = container.children.at(-1);
  if (last instanceof Graphics) return last;
  const g = new Graphics();
  container.addChild(g);
  return g;
}
