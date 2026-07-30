import { FillGradient, type Graphics } from "pixi.js";
import type { MapObject, Vec2 } from "@dotbot/game/types";
import { stadiumAxis } from "@dotbot/game/mapModel";
import { drawWater, GRD, fillPoly } from "./modelGround";
import { movingPart } from "./modelMotion";
import {
  contact,
  contactBlock,
  contactRound,
  contactShape,
  cylinder,
  faceLight,
  inlay,
  jitter,
  LIFT,
  MAT,
  shade,
  volume,
  volumeShape,
  type Rect,
  type ShadowPad,
} from "./tone";

/**
 * The objects a region is recognised by.
 *
 * `modelGlyphs` draws furniture — the things inside and beside a building. These are
 * the other half of a world, and they exist because of a specific failure worth
 * keeping written down: three non-city regions were first drawn as ground cover
 * (rock, scrub, water, canopy) and the verdict was that they "don't feel like
 * anything in particular". They didn't. A place is recognised by its landmarks. One
 * turntable says railway in a single glance and no amount of ballast does.
 *
 * Four rules, all of them learned by looking at renders rather than by reasoning:
 *
 *  - RADIAL FORMS SURVIVE THIS CAMERA. A strict overhead view flattens rectilinear
 *    structure into stripes and leaves round things fully legible — a turntable, a
 *    carousel, a ball court, a water tank. Lean on that.
 *
 *  - A SUBJECT WHOSE PLAN IS NOT ITS IDENTITY CANNOT BE DRAWN HERE. A ferris wheel
 *    seen from directly above is a LINE, and every one of four attempts to make that
 *    line read as a wheel was an attempt to borrow the side view this camera does not
 *    have. A carousel works because a carousel genuinely IS a disc of pie segments
 *    from above. That is the test to apply BEFORE drawing: if the honest plan does not
 *    name the thing, pick a different thing.
 *
 *    This is a rule about the CAMERA and nothing else. It is not rule 4, and the two
 *    got tangled once: a chairoplane was cut alongside the wheel on the grounds that
 *    its identity is motion and a ride at rest has none. That was wrong — the answer
 *    to a chairoplane is swinging seats, and a chairoplane in plan is a legible ring
 *    of seats round a mast. Motion is wanted; see `docs/world-motion.md`. Only fail a
 *    subject here if it fails from OVERHEAD however it is moving.
 *
 *  - OUTLINE CARRIES MATERIAL AT LEAST AS HARD AS VALUE DOES. Foliage kept reading
 *    as rock through three value passes; what fixed it was fraying the silhouette. A
 *    closed polygonal outline means STONE in this language whatever tone it is.
 *
 *  - RADIAL LINE WORK READS AS A DIAL. Staves on a tank and thin panel seams on a
 *    canopy both came out as clock faces. Bands run *around* a round thing, and where
 *    something really is panelled the panels are wide alternating wedges, which reads
 *    as stripes instead of spokes.
 */

export type LandmarkFn = (g: Graphics, pad: ShadowPad, o: MapObject) => void;

function rect(o: MapObject): Rect {
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

function centre(o: MapObject): Vec2 {
  return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
}

function inset(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, w: r.w - by * 2, h: r.h - by * 2 };
}

function circlePoly(cx: number, cy: number, radius: number, steps = 32): Vec2[] {
  return Array.from({ length: steps }, (_, index) => {
    const angle = (index / steps) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
}

/** True when the object is longer east-west than north-south. */
function acrossAxis(o: MapObject): boolean {
  return o.w >= o.h;
}

/**
 * The outline of a stadium: a semicircle round each end of a segment, joined.
 *
 * The drawn twin of the capsule `objectSolids` builds for a `STADIUM_KIND`, off the
 * same `stadiumAxis`, which is the only way the two stay equal through an edit.
 * `steps` is per end cap.
 */
function stadiumPoly(ax: number, ay: number, bx: number, by: number, r: number, steps: number): Vec2[] {
  const axis = Math.atan2(by - ay, bx - ax);
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = axis - Math.PI / 2 + (i / steps) * Math.PI;
    points.push({ x: bx + Math.cos(a) * r, y: by + Math.sin(a) * r });
  }
  for (let i = 0; i <= steps; i += 1) {
    const a = axis + Math.PI / 2 + (i / steps) * Math.PI;
    points.push({ x: ax + Math.cos(a) * r, y: ay + Math.sin(a) * r });
  }
  return points;
}

/** An irregular closed ring: a boulder, a thicket, a pool. */
function blob(cx: number, cy: number, rx: number, ry: number, id: string, wobble = 0.3, count = 13): Vec2[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    const k = 1 - wobble / 2 + jitter(id, i) * wobble;
    return { x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k };
  });
}

// ---------------------------------------------------------------------------
// Wild ground
// ---------------------------------------------------------------------------

const boulderGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const shape = blob(cx, cy, o.w / 2 - 0.5, o.h / 2 - 0.5, o.id, 0.4, 11);
  const size = Math.min(o.w, o.h);
  const lift = Math.min(LIFT.mass, 5 + size * 0.22);
  contactShape(pad, shape, lift);
  const top = volumeShape(g, shape, size > 88 ? MAT.rock : MAT.rockDark, lift);

  /**
   * Bedding planes, drawn as contours following the perimeter.
   *
   * A first pass joined `top[i]` to `top[i+5]` — chords straight across the interior
   * — and every boulder came out as a wireframe. Rock is layered, and a layer
   * follows the surface it is in.
   */
  for (const step of [4, 9]) {
    const ring = top.map((p) => ({
      x: cx + (p.x - cx) * (1 - step / (size / 2 + step)),
      y: cy + (p.y - cy) * (1 - step / (size / 2 + step)),
    }));
    g.poly(ring.map((p) => ({ x: p.x, y: p.y })))
      .stroke({ color: shade(MAT.rock.front, 0.92), width: 0.8, alpha: 0.6 });
  }
};

/**
 * Impenetrable vegetation, and the one place a region says *go round*.
 *
 * Drawn as merged lobes with a deliberately frayed rim. Two earlier attempts bracket the
 * value answer: a ramp topping out four steps DARK of the ground made a thicket read as a
 * boulder, and a ramp pushed 1.14 above it made popcorn. What actually separates leaves from
 * stone is the broken outline.
 *
 * ## IT MUST NOT LOOK LIKE A TREE, and for a while it did
 *
 * Reported from play: "there are a bunch of trees on the map that aren't built like this, so
 * it's weird having some that I can go under and others I can't." Those are these — fifty-six
 * of them against fifty trees, and BIGGER than most trees at 104–140 units. They were reading
 * as trees because after the canopy rebuild the two glyphs used literally the same value ramp
 * (0.62 / 0.84 / `MAT.foliage.top`), so the only thing telling them apart was a trunk parting
 * a player would have to go looking for.
 *
 * That is a affordance bug, not a decoration one. The two are opposite promises: a tree's
 * collider is its trunk, so you walk UNDER it and its canopy is drawn above you; a thicket
 * collides across its whole footprint, so you walk AROUND it and it never covers you. A player
 * has to be able to tell which is which before committing to a route in a fight.
 *
 * So the thicket is now the DARK DENSE one and the tree is the light open one:
 *
 * - the ramp tops out well below `MAT.foliage.top` instead of at it — dark reads as dense,
 *   which is the same reasoning the slab uses to make lit things able to look lit;
 * - no bright lobes at all. A tree gets a lit crown; a thicket is undergrowth in its own shade;
 * - more, tighter lobes, so there is no gap in it to read as a way through;
 * - a low contact shadow. A thicket is chest height, and shadow length is height here.
 *
 * The frayed rim stays exactly as it was: it is what keeps this vegetation rather than rock,
 * and darkening the mass is precisely the change that would resurrect the boulder reading if
 * the rim ever went.
 */
const thicketGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const rx = o.w / 2;
  const ry = o.h / 2;
  const size = Math.min(rx, ry);
  // Low, not landmark-scale: a thicket is something you push against, not something you
  // stand under. A tree's shadow now scales up to `LIFT.tower`; this stays near a bench.
  contactRound(pad, cx, cy, size * 0.82, LIFT.bench + 3);

  const under = shade(MAT.foliage.top, 0.44);
  const body = shade(MAT.foliage.top, 0.6);
  const crest = shade(MAT.foliage.top, 0.74);

  fillPoly(g, blob(cx, cy, rx, ry, `${o.id}u`, 0.24, 17), under);

  // Denser than it was — a thicket with visible gaps between its lobes reads as a stand of
  // bushes you could slip between, which is the opposite of what it does.
  const lobes = Math.max(7, Math.round(Math.max(rx, ry) / 17));
  for (let i = 0; i < lobes; i += 1) {
    const a = (i / lobes) * Math.PI * 2 + jitter(o.id, i) * 0.7;
    const d = 0.3 + jitter(o.id, i + 20) * 0.38;
    const px = cx + Math.cos(a) * rx * d;
    const py = cy + Math.sin(a) * ry * d;
    // Still lit by the same north-slightly-west light as everything else — but the bright end
    // of this ramp is the tree's MID tone, so a thicket never has a highlight on it.
    const facing = (Math.cos(a) * -0.33 + Math.sin(a) * -0.94 + 1) / 2;
    const r = size * (0.4 + jitter(o.id, i + 40) * 0.2);
    g.circle(px, py, r).fill({ color: facing > 0.62 ? crest : body });
  }

  // The frayed rim. This, not the value ramp, is what makes it vegetation.
  for (let i = 0; i < 22; i += 1) {
    const a = (i / 22) * Math.PI * 2;
    const k = 0.86 + jitter(o.id, i + 60) * 0.2;
    g.circle(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k, size * (0.1 + jitter(o.id, i + 80) * 0.13))
      .fill({ color: jitter(o.id, i + 90) > 0.55 ? body : under });
  }
};

/** A fallen trunk: an extruded cylinder along its own length, with cut ends. */
const logGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  const across = acrossAxis(o);
  const thick = across ? r.h : r.w;
  contact(pad, r, LIFT.seat, thick / 2);
  const top = volume(g, r, MAT.woodDark, LIFT.seat, thick / 2);

  // Grain along the length, plus a bright end grain where it snapped.
  for (let i = 1; i < 4; i += 1) {
    const t = i / 4;
    inlay(g, across
      ? { x: top.x + 3, y: top.y + top.h * t - 0.5, w: top.w - 6, h: 1 }
      : { x: top.x + top.w * t - 0.5, y: top.y + 3, w: 1, h: top.h - 6 },
      shade(MAT.woodDark.front, 0.94));
  }
  const cap = across
    ? { x: top.x, y: top.y, w: thick * 0.42, h: top.h }
    : { x: top.x, y: top.y, w: top.w, h: thick * 0.42 };
  inlay(g, cap, shade(MAT.wood.top, 1.04), thick / 3);
};

// ---------------------------------------------------------------------------
// The rail yard
// ---------------------------------------------------------------------------

/**
 * Track: sleepers on ballast with two rails on top.
 *
 * Flat, and it has to be. Track is the one landmark that is genuinely LONG — a
 * siding crosses a whole region — so as a collider it would fence the yard into
 * strips. It is also ground: you walk along it, and a rail standing proud of the
 * ballast is not cover for anybody.
 */
const trackGlyph: LandmarkFn = (g, _pad, o) => {
  const r = rect(o);
  const across = acrossAxis(o);
  const span = across ? r.w : r.h;
  const width = across ? r.h : r.w;

  // Sleepers on a fixed pitch, struck off the world origin so two lengths of the
  // same siding line up rather than each starting its own count.
  const pitch = 26;
  const start = Math.ceil((across ? r.x : r.y) / pitch) * pitch;
  for (let at = start; at < (across ? r.x + r.w : r.y + r.h); at += pitch) {
    const sleeper = across
      ? { x: at - 5, y: r.y + width * 0.06, w: 10, h: width * 0.88 }
      : { x: r.x + width * 0.06, y: at - 5, w: width * 0.88, h: 10 };
    inlay(g, sleeper, shade(MAT.woodDark.top, 0.86));
    inlay(g, across
      ? { x: sleeper.x, y: sleeper.y, w: sleeper.w, h: 1.6 }
      : { x: sleeper.x, y: sleeper.y, w: 1.6, h: sleeper.h },
      shade(MAT.woodDark.top, 1.04));
  }

  /**
   * The rails, and the running face is the whole read.
   *
   * A rail head is polished steel — the brightest narrow thing in a yard — and the
   * web beside it is in shade. Two bright lines a fixed gauge apart is what says
   * railway from any zoom; without the dark web they read as painted lines.
   */
  const gauge = width * 0.46;
  const mid = across ? r.y + r.h / 2 : r.x + r.w / 2;
  for (const side of [-1, 1]) {
    const at = mid + side * gauge / 2;
    inlay(g, across ? { x: r.x, y: at - 2, w: span, h: 4 } : { x: at - 2, y: r.y, w: 4, h: span },
      shade(MAT.iron.front, 0.8));
    inlay(g, across ? { x: r.x, y: at - 1.4, w: span, h: 1.8 } : { x: at - 1.4, y: r.y, w: 1.8, h: span },
      shade(MAT.steelLit.top, 1.02));
  }
};

/**
 * A locomotive turntable: a pit, a ring rail, and the bridge across it.
 *
 * The strongest single image a rail yard has, and it is flat because a turntable
 * deck is something you walk over. Everything about it is round, which is why it
 * survives this camera when a shed roof does not.
 */
const turntableGlyph: LandmarkFn = (g, _pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2;

  // The pit: a recess, so it takes the inverted shading water does — dark on the
  // near wall, lit on the far one, because the light passes over the near rim.
  g.circle(cx, cy, radius).fill({ color: shade(GRD.cinder, 0.72) });
  g.circle(cx + radius * 0.05, cy + radius * 0.07, radius * 0.94).fill({ color: shade(GRD.cinder, 1.06) });
  g.circle(cx, cy, radius * 0.9).fill({ color: shade(GRD.cinder, 0.94) });

  // Ring rail against the pit wall, and the pit floor's drainage fall to the centre.
  g.circle(cx, cy, radius * 0.9).stroke({ color: shade(MAT.steelLit.top, 1.0), width: 2.4 });
  g.circle(cx, cy, radius * 0.52).fill({ color: shade(GRD.cinder, 0.88) });

  /**
   * The bridge. A deep plate girder either side of the deck, and the deck between
   * them — so the bridge reads as a structure spanning a hole rather than as a line
   * across a disc. Held at 15° off the axis, because a turntable parked square is
   * the one position that reads as a diagram.
   */
  const angle = 0.26;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;
  const half = radius * 0.94;
  const deck = radius * 0.17;
  const girder = (offset: number, thick: number, color: number): void => {
    fillPoly(g, [
      { x: cx + dx * half + nx * (offset - thick), y: cy + dy * half + ny * (offset - thick) },
      { x: cx + dx * half + nx * (offset + thick), y: cy + dy * half + ny * (offset + thick) },
      { x: cx - dx * half + nx * (offset + thick), y: cy - dy * half + ny * (offset + thick) },
      { x: cx - dx * half + nx * (offset - thick), y: cy - dy * half + ny * (offset - thick) },
    ], color);
  };
  girder(0, deck, shade(MAT.woodDark.top, 0.94));
  girder(-deck, 2.6, shade(MAT.iron.top, 1.12));
  girder(deck, 2.6, MAT.iron.front);
  // Running rails on the bridge deck, at the same gauge as the sidings that feed it.
  girder(-deck * 0.42, 1.5, shade(MAT.steelLit.top, 1.02));
  girder(deck * 0.42, 1.5, shade(MAT.steelLit.top, 1.02));
  // The centre pivot, the one thing the whole bridge turns on.
  g.circle(cx, cy, radius * 0.11).fill({ color: MAT.iron.front });
  g.circle(cx, cy, radius * 0.07).fill({ color: shade(MAT.iron.top, 1.16) });
};

/** A railway wagon: a long ribbed body with buffers at each end. */
const wagonGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  const across = acrossAxis(o);
  contact(pad, r, LIFT.mass);
  const top = volume(g, r, MAT.iron, LIFT.mass);

  // Planked or ribbed body, run across the length the way real sheeting is.
  const ribs = Math.max(4, Math.round((across ? top.w : top.h) / 34));
  for (let i = 1; i < ribs; i += 1) {
    const t = i / ribs;
    inlay(g, across
      ? { x: top.x + top.w * t - 1, y: top.y + 2, w: 2, h: top.h - 4 }
      : { x: top.x + 2, y: top.y + top.h * t - 1, w: top.w - 4, h: 2 },
      shade(MAT.iron.top, 0.84));
  }
  // A pale interior, so an open wagon reads as open and a van reads as closed.
  if (jitter(o.id, 7) > 0.45) {
    inlay(g, inset(top, Math.min(top.w, top.h) * 0.2), shade(MAT.iron.top, 1.2));
  }
  // Solebar and buffers, drawn inside the collider: nothing solid-looking may sit
  // outside the authored rect.
  for (const end of [true, false]) {
    const beam = across
      ? { x: end ? top.x : top.x + top.w - 4, y: top.y, w: 4, h: top.h }
      : { x: top.x, y: end ? top.y : top.y + top.h - 4, w: top.w, h: 4 };
    inlay(g, beam, shade(MAT.iron.front, 0.86));
  }
};

/** A buffer stop: two rail ends into a timber baulk. */
const bufferStopGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  const across = acrossAxis(o);
  contact(pad, r, LIFT.bench);
  const top = volume(g, r, MAT.woodDark, LIFT.bench);
  // The face that takes the hit gets the paint: a buffer stop is the one thing in a
  // yard that is deliberately conspicuous.
  const face = across
    ? { x: top.x + top.w - Math.max(4, top.w * 0.3), y: top.y, w: Math.max(4, top.w * 0.3), h: top.h }
    : { x: top.x, y: top.y + top.h - Math.max(4, top.h * 0.3), w: top.w, h: Math.max(4, top.h * 0.3) };
  inlay(g, face, shade(MAT.steelLit.top, 0.98));
  for (let i = 0; i < 3; i += 1) {
    inlay(g, across
      ? { x: face.x, y: face.y + face.h * (i + 0.5) / 3 - 1.4, w: face.w, h: 2.8 }
      : { x: face.x + face.w * (i + 0.5) / 3 - 1.4, y: face.y, w: 2.8, h: face.h },
      shade(MAT.iron.front, 0.9));
  }
};

/**
 * A water tower: a hooped tank on a frame, with a swing arm.
 *
 * The hoops are the fix for the first version, which drew radial staves and came out
 * as a clock face — reported in exactly those words. A barrel's staves run vertically
 * and are invisible from above; what you see from up here are the iron hoops running
 * *around* it, and the arm breaking the circle is what makes it a water tower rather
 * than a tank.
 */
const waterTankGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.tower);

  cylinder(g, cx, cy, radius, MAT.iron, LIFT.tower);
  /**
   * TWO hoops, and they are the second attempt at not drawing a dial.
   *
   * Radial staves came out as a clock face, so they became concentric hoops — and three
   * hoops plus a radial arm came out as a SPIRAL, which is worse. What separates a tank
   * from a dial is having few enough marks that the eye reads a lid rather than a
   * mechanism: two hoops, one bold arm all the way across, one manhole off-centre.
   */
  for (const k of [0.86, 0.52]) {
    g.circle(cx, cy, radius * k).stroke({ color: shade(MAT.iron.front, 0.84), width: 3 });
    g.circle(cx, cy, radius * k - 1.6).stroke({ color: shade(MAT.iron.top, 1.16), width: 1 });
  }
  g.circle(cx - radius * 0.34, cy - radius * 0.3, radius * 0.17).fill({ color: shade(MAT.iron.top, 1.22) });
  g.circle(cx - radius * 0.34, cy - radius * 0.3, radius * 0.17).stroke({ color: MAT.iron.edge, width: 1 });

  /**
   * The swing arm, hanging over the road it fills engines from. Drawn inside the
   * tank's own footprint on its outer half only, so the silhouette stays the
   * collider — an arm sticking out past the rect would be solid-looking geometry
   * outside the collision, which is the ghost problem in reverse.
   */
  const arm = { x: cx - 5, y: cy - radius * 0.9, w: 10, h: radius * 1.8 };
  inlay(g, arm, shade(MAT.iron.front, 0.78));
  inlay(g, { x: arm.x + 1.5, y: arm.y, w: 3, h: arm.h }, shade(MAT.iron.top, 1.12));
  g.circle(cx, cy + radius * 0.78, 8).fill({ color: shade(MAT.iron.front, 0.72) });
};

/**
 * A coaling stage: the tallest thing in a rail yard, and a chute down one flank.
 *
 * Concrete rather than iron, because it is a structure rather than a machine, and
 * because a yard of uniformly dark iron has no scale in it.
 */
const coalingTowerGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  const stageLift = LIFT.tower + 10;
  // The whole pad, not one layer of it: handed a single Graphics the block form paints a
  // hard black slab, and the stage came out flat as paper on the ballast.
  contact(pad, r, stageLift);
  const top = volume(g, r, MAT.stoneWorn, stageLift);

  // The bunker's own division: two bins over the track, which is what a coaling
  // stage is, plus the hoist housing on the north end where it catches the light.
  const across = acrossAxis(o);
  const buttressDepth = Math.max(5, Math.min(top.w, top.h) * 0.08);
  for (const side of [0.08, 0.84]) {
    const buttress = across
      ? { x: top.x + top.w * side, y: top.y + 2, w: top.w * 0.08, h: top.h - 4 }
      : { x: top.x + 2, y: top.y + top.h * side, w: top.w - 4, h: top.h * 0.08 };
    inlay(g, buttress, shade(MAT.stoneWorn.top, side < 0.5 ? 1.06 : 0.77));
  }
  inlay(g, across
    ? { x: top.x + top.w / 2 - 1.5, y: top.y + 2, w: 3, h: top.h - 4 }
    : { x: top.x + 2, y: top.y + top.h / 2 - 1.5, w: top.w - 4, h: 3 },
    shade(MAT.stoneWorn.front, 0.86));
  const hoist = across
    ? { x: top.x + top.w * 0.06, y: top.y + top.h * 0.16, w: top.w * 0.22, h: top.h * 0.68 }
    : { x: top.x + top.w * 0.16, y: top.y + top.h * 0.06, w: top.w * 0.68, h: top.h * 0.22 };
  const hoistTop = volume(g, hoist, MAT.iron, buttressDepth, 1);
  inlay(g, inset(hoistTop, 2), shade(MAT.iron.top, 0.78));

  // The chute mouth: the darkest hole on the sheet, and the thing that says coal.
  const chute = across
    ? { x: top.x + top.w * 0.42, y: top.y + top.h * 0.58, w: top.w * 0.3, h: top.h * 0.3 }
    : { x: top.x + top.w * 0.58, y: top.y + top.h * 0.42, w: top.w * 0.3, h: top.h * 0.3 };
  inlay(g, chute, GRD.abyss);
  inlay(g, { x: chute.x, y: chute.y, w: chute.w, h: 1.6 }, shade(MAT.stoneWorn.top, 1.08));
};

// ---------------------------------------------------------------------------
// The fairground
// ---------------------------------------------------------------------------

/**
 * A carousel: a striped canopy with a scalloped hem, and horses on a ring.
 *
 * Stripes, not seams. Thin radial lines on a round canopy read as a dial — the same
 * defect as the water tank's staves — so the panels are wide alternating wedges,
 * which reads as a striped tent, and a striped tent under a scalloped hem is a
 * carousel and nothing else.
 *
 * AND IT TURNS. Everything above the deck goes into one moving part (`modelMotion`),
 * because on a carousel that is one rigid assembly: canopy, crown and horses all ride
 * the same platform. The deck stays put, which costs nothing to look at — it is a plain
 * cylinder, so it is rotationally symmetric, and all that shows of it is the ring at the
 * hem. The cast shadow stays put for the same reason: it is a disc.
 */
const carouselGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.tower);

  // Deck first, showing at the hem, so the ride reads as a platform under a roof.
  cylinder(g, cx, cy, radius, MAT.woodDark, LIFT.mass);

  const ride = movingPart(g, "spin", { x: cx, y: cy });

  const canopy = radius * 0.94;
  const panels = 12;
  for (let i = 0; i < panels; i += 1) {
    const a0 = (i / panels) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / panels) * Math.PI * 2 - Math.PI / 2;
    const wedge: Vec2[] = [{ x: cx, y: cy }];
    for (let s = 0; s <= 4; s += 1) {
      const a = a0 + (a1 - a0) * (s / 4);
      wedge.push({ x: cx + Math.cos(a) * canopy, y: cy + Math.sin(a) * canopy });
    }
    // The light still comes from the north-west, so a stripe on that side is bright
    // whichever of the two alternating tones it is.
    const mid = (a0 + a1) / 2;
    const facing = (Math.cos(mid) * -0.33 + Math.sin(mid) * -0.94 + 1) / 2;
    const base = i % 2 === 0 ? MAT.canvas.top : shade(MAT.canvas.top, 0.78);
    fillPoly(ride, wedge, shade(base, 0.9 + facing * 0.22));
  }

  // The scalloped hem: the fairground's own signature, and it breaks the disc.
  const scallops = panels * 2;
  for (let i = 0; i < scallops; i += 1) {
    const a = (i / scallops) * Math.PI * 2;
    ride.circle(cx + Math.cos(a) * canopy, cy + Math.sin(a) * canopy, radius * 0.075)
      .fill({ color: shade(MAT.canvas.top, 0.84) });
  }
  ride.circle(cx, cy, canopy).stroke({ color: MAT.canvas.edge, width: 1.1 });

  // The crown boss, then the horses on their ring — one gap, because an abandoned
  // carousel is missing a horse and that absence is worth more than the twelve.
  //
  // The gap is also what makes the turn legible. A ring of twelve identical horses
  // rotating is indistinguishable from a ring of twelve identical horses standing
  // still; the missing one is the mark the eye tracks.
  ride.circle(cx, cy, radius * 0.2).fill({ color: shade(MAT.canvas.top, 1.06) });
  ride.circle(cx, cy, radius * 0.2).stroke({ color: MAT.canvas.edge, width: 0.9 });
  const ring = radius * 0.62;
  for (let i = 0; i < 10; i += 1) {
    if (i === 6) continue;
    const a = (i / 10) * Math.PI * 2 + 0.2;
    const px = cx + Math.cos(a) * ring;
    const py = cy + Math.sin(a) * ring;
    ride.circle(px, py, radius * 0.09).fill({ color: shade(MAT.painted.top, 0.94) });
    ride.circle(px, py, radius * 0.055).fill({ color: shade(MAT.painted.top, 1.16) });
  }
};

/**
 * A chairoplane whose moving ring supplies the read its old frozen dots could not.
 *
 * The seats are deliberately large enough to carry a back and a pair of short
 * suspension links at play zoom. One missing chair gives the rotating ring a mark
 * the eye can track. Everything stays inside the circular deck, so the authored
 * disc remains both silhouette and collider.
 */
const swingRideGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.tower);
  cylinder(g, cx, cy, radius, MAT.iron, LIFT.mass);

  const ride = movingPart(g, "spin", { x: cx, y: cy });
  const canopy = radius * 0.34;
  ride.circle(cx, cy, canopy).fill(typeof document === "undefined"
    ? { color: MAT.canvas.top }
    : new FillGradient({
      type: "radial",
      center: { x: 0.36, y: 0.32 },
      innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.54,
      textureSpace: "local",
      colorStops: [
        { offset: 0, color: MAT.canvas.lit },
        { offset: 0.54, color: MAT.canvas.top },
        { offset: 1, color: shade(MAT.canvas.top, 0.72) },
      ],
    }));
  ride.circle(cx, cy, canopy).stroke({ color: MAT.canvas.edge, width: 1 });
  ride.circle(cx, cy, radius * 0.08).fill({ color: MAT.iron.edge });

  const seats = 10;
  const ring = radius * 0.72;
  const seatWidth = radius * 0.24;
  const seatDepth = radius * 0.15;
  for (let index = 0; index < seats; index += 1) {
    if (index === 7) continue;
    const angle = (index / seats) * Math.PI * 2 + 0.16;
    const radial = { x: Math.cos(angle), y: Math.sin(angle) };
    const tangent = { x: -radial.y, y: radial.x };
    const px = cx + radial.x * ring;
    const py = cy + radial.y * ring;
    const corners = (width: number, depth: number, inward = 0): Vec2[] => {
      const at = { x: px - radial.x * inward, y: py - radial.y * inward };
      return [
        { x: at.x - tangent.x * width / 2 - radial.x * depth / 2, y: at.y - tangent.y * width / 2 - radial.y * depth / 2 },
        { x: at.x + tangent.x * width / 2 - radial.x * depth / 2, y: at.y + tangent.y * width / 2 - radial.y * depth / 2 },
        { x: at.x + tangent.x * width / 2 + radial.x * depth / 2, y: at.y + tangent.y * width / 2 + radial.y * depth / 2 },
        { x: at.x - tangent.x * width / 2 + radial.x * depth / 2, y: at.y - tangent.y * width / 2 + radial.y * depth / 2 },
      ];
    };

    const link = ring - canopy - seatDepth;
    for (const side of [-0.32, 0.32]) {
      ride.moveTo(
        cx + radial.x * canopy + tangent.x * seatWidth * side,
        cy + radial.y * canopy + tangent.y * seatWidth * side,
      ).lineTo(
        cx + radial.x * (canopy + link * 0.72) + tangent.x * seatWidth * side,
        cy + radial.y * (canopy + link * 0.72) + tangent.y * seatWidth * side,
      ).stroke({ color: shade(MAT.iron.top, 0.78), width: 1.1 });
    }
    fillPoly(ride, corners(seatWidth, seatDepth), MAT.canvas.edge);
    fillPoly(ride, corners(seatWidth * 0.86, seatDepth * 0.72, seatDepth * 0.02), shade(MAT.canvas.top, 0.94));
    const back = corners(seatWidth * 0.9, seatDepth * 0.28, -seatDepth * 0.36);
    fillPoly(ride, back, shade(MAT.canvas.top, 0.7));
  }
};

/**
 * A helter-skelter: a timber tower with its slide spiralling down round it.
 *
 * The one fairground form whose PLAN is unmistakably itself. A spiral is the single
 * piece of line work that survives a round object in this language, and it survives
 * for a reason worth stating: the failure mode here is always the dial, and a dial is
 * made of marks that all share a centre. A spiral crosses every radius exactly once,
 * so there is no ring of coincident ends for the eye to read as a clock face.
 *
 * It briefly replaced the chairoplane on the fairground site. That was the wrong
 * resolution to frozen seats and the animated ride is restored there, but this glyph
 * remains valid for any map that authors a helter-skelter: the slide is the structure.
 */
const helterSkelterGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.tower);

  /**
   * The tower's mass first, so the glyph has a lit south face and a cast shadow that is
   * exactly its collider. What shows between the turns of the slide is this.
   *
   * DARK, and that is the whole legibility of the spiral. In `woodDark` the drum sat two
   * steps off the slide's canvas and the ride came out as a set of concentric rings — a
   * washer, which is the same failure the waltzer's cars had for the same reason. A pale
   * ribbon needs a dark ground to be a ribbon. Weathered iron also happens to be what is
   * left of a fifty-year-old tower nobody has painted.
   */
  cylinder(g, cx, cy, radius, MAT.iron, LIFT.tower);
  // The drum's own boarding, as a ring of tone falling away to the hem: a plain flat
  // cylinder top is a disc, and the slide is wrapped round something round.
  g.circle(cx, cy, radius - 1).fill(new FillGradient({
    type: "radial",
    center: { x: 0.42, y: 0.4 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    textureSpace: "local",
    colorStops: [
      { offset: 0, color: shade(MAT.iron.top, 1.16) },
      { offset: 0.7, color: MAT.iron.top },
      { offset: 1, color: shade(MAT.iron.top, 0.82) },
    ],
  }));

  const towerR = radius * 0.3;
  /**
   * 1.85 turns, and the number is the whole legibility of the glyph.
   *
   * The radial pitch has to be wider than the slide, or the turns touch and the spiral
   * closes into a plain annulus — which is a washer, not a ride. At 1.85 turns the
   * pitch is about 50 units against a 28-unit slide, so the timber shows through in two
   * clean gaps and the eye follows the band round. It ends nearly half a turn off where
   * it started, which is what says spiral rather than circle.
   */
  const turns = 1.85;
  const sweep = turns * Math.PI * 2;
  const outerR = radius * 0.94;
  const pitch = (outerR - towerR) / turns;
  const band = pitch * 0.56;

  // Wound clockwise from the SOUTH, so the slide's foot faces the promenade: the way
  // out of a helter-skelter is the side people queue on.
  const at = (t: number): { a: number; r: number } => ({
    a: Math.PI / 2 + t * sweep,
    r: outerR - band / 2 - t * (outerR - band - towerR),
  });

  /**
   * The slide, as a run of quads rather than one long ribbon.
   *
   * Segmented so each piece can take its own value off its own facing, which is what
   * makes the band read as a helix descending rather than as a flat spiral drawn on the
   * top of a drum. One fill for the whole ribbon came out as a decal.
   */
  const segments = 30;
  for (let i = 0; i < segments; i += 1) {
    const s0 = at(i / segments);
    const s1 = at((i + 1) / segments);
    const quad: Vec2[] = [
      { x: cx + Math.cos(s0.a) * (s0.r + band / 2), y: cy + Math.sin(s0.a) * (s0.r + band / 2) },
      { x: cx + Math.cos(s1.a) * (s1.r + band / 2), y: cy + Math.sin(s1.a) * (s1.r + band / 2) },
      { x: cx + Math.cos(s1.a) * (s1.r - band / 2), y: cy + Math.sin(s1.a) * (s1.r - band / 2) },
      { x: cx + Math.cos(s0.a) * (s0.r - band / 2), y: cy + Math.sin(s0.a) * (s0.r - band / 2) },
    ];
    // The light is still north-west, so a run facing that way is the bright one.
    const mid = (s0.a + s1.a) / 2;
    const facing = (Math.cos(mid) * -0.33 + Math.sin(mid) * -0.94 + 1) / 2;
    // Higher turns are paler: the top of a tower catches more light than its foot, and
    // it is the only cue in a plan that tells the two apart.
    const height = 0.9 + (i / segments) * 0.14;
    fillPoly(g, quad, shade(MAT.canvas.top, (0.82 + facing * 0.3) * height));
  }

  // The rails: bright on the outside edge, dark where the slide meets the tower. Two
  // strokes, and between them they are what makes the band a chute rather than a stripe.
  for (const side of [1, -1]) {
    const edge: Vec2[] = [];
    for (let i = 0; i <= segments * 2; i += 1) {
      const s = at(i / (segments * 2));
      const r = s.r + (band / 2) * side;
      edge.push({ x: cx + Math.cos(s.a) * r, y: cy + Math.sin(s.a) * r });
    }
    g.moveTo(edge[0].x, edge[0].y);
    for (const point of edge.slice(1)) g.lineTo(point.x, point.y);
    g.stroke({ color: side > 0 ? shade(MAT.canvas.top, 1.2) : shade(MAT.woodDark.edge, 0.94), width: 1.5 });
  }

  /**
   * The RUN-OUT at the slide's foot: the chute flaring wider as it levels off.
   *
   * A floating rounded rectangle was the first attempt at this and read as a detached
   * tile lying beside the tower. A helter-skelter's foot is not an object next to the
   * ride, it is the last few feet of the slide going flat and getting wider — so it is
   * drawn as part of the same ribbon, and it says which end of the spiral is the bottom
   * without adding anything the eye has to account for separately.
   */
  const foot = at(0);
  const flare = band * 0.9;
  const lip: Vec2[] = [];
  for (let i = 0; i <= 8; i += 1) {
    const a = foot.a - (i / 8) * 0.5;
    const w = band / 2 + (i / 8) * (flare - band) / 2;
    lip.push({ x: cx + Math.cos(a) * (foot.r + w), y: cy + Math.sin(a) * (foot.r + w) });
  }
  for (let i = 8; i >= 0; i -= 1) {
    const a = foot.a - (i / 8) * 0.5;
    const w = band / 2 + (i / 8) * (flare - band) / 2;
    lip.push({ x: cx + Math.cos(a) * (foot.r - w), y: cy + Math.sin(a) * (foot.r - w) });
  }
  fillPoly(g, lip, shade(MAT.canvas.top, 0.92));
  fillPoly(g, lip.slice(0, 9).concat(lip.slice(9).map((p) => ({
    x: p.x + (cx - p.x) * 0.12,
    y: p.y + (cy - p.y) * 0.12,
  }))), shade(MAT.canvas.top, 1.06));

  /**
   * The tower head and its conical cap.
   *
   * A radial gradient rather than eight alternating wedges, which is the second attempt:
   * pie slices this small came out as a pinwheel, and a pinwheel is a dial with fewer
   * hands. A cone from directly above is a point of light with the tone falling away all
   * round it, and that is one gradient. The seams then read as seams because they are
   * laid on a curved surface rather than being the only thing describing it.
   */
  cylinder(g, cx, cy, towerR, MAT.wood, LIFT.tower);
  g.circle(cx, cy, towerR * 0.94).fill(new FillGradient({
    type: "radial",
    center: { x: 0.4, y: 0.38 },
    innerRadius: 0,
    outerCenter: { x: 0.5, y: 0.5 },
    outerRadius: 0.5,
    textureSpace: "local",
    colorStops: [
      { offset: 0, color: MAT.canvas.lit },
      { offset: 0.5, color: MAT.canvas.top },
      { offset: 1, color: shade(MAT.canvas.top, faceLight({ x: 0.3, y: 1 })) },
    ],
  }));
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    g.moveTo(cx + Math.cos(a) * towerR * 0.24, cy + Math.sin(a) * towerR * 0.24)
      .lineTo(cx + Math.cos(a) * towerR * 0.92, cy + Math.sin(a) * towerR * 0.92)
      .stroke({ color: shade(MAT.canvas.edge, 1.12), width: 0.7, alpha: 0.7 });
  }
  g.circle(cx, cy, towerR * 0.94).stroke({ color: MAT.canvas.edge, width: 1 });
  // The finial, off-centre toward the light like every pole head in the kit.
  g.circle(cx + towerR * 0.06, cy + towerR * 0.08, towerR * 0.16).fill({ color: MAT.iron.edge });
  g.circle(cx + towerR * 0.03, cy + towerR * 0.04, towerR * 0.08)
    .fill({ color: shade(MAT.iron.top, 1.12) });
};

/**
 * A waltzer: a dished platform with cars round its inside edge.
 *
 * Dished, so it holds rainwater — which is the one detail that says *abandoned* about
 * a ride rather than about the ground it stands on. The water goes on after the rim,
 * never before: drawn first, the dish's own extrusion paints straight over it.
 *
 * AND IT TURNS — but only the CARS, where the carousel turns everything above its deck.
 * Two reasons, and neither is a shortcut. The dish's lit inner wall is offset toward the
 * light like every other recess in this language, so turning it would give the waltzer its
 * own private sun going round; and the water is standing in the bottom of it, which a
 * platform creeping round once every three minutes does not carry with it. What is left to
 * turn is the ring of cars, which is the only part of a waltzer anybody watches anyway.
 */
const waltzerGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.mass);

  cylinder(g, cx, cy, radius, MAT.painted, LIFT.mass);
  g.circle(cx, cy, radius * 0.86).fill({ color: shade(MAT.painted.top, 0.8) });

  // The dish, as a recess: dark near wall, lit far wall, the same inversion water uses.
  g.circle(cx, cy, radius * 0.72).fill({ color: shade(MAT.painted.top, 0.6) });
  g.circle(cx + radius * 0.04, cy + radius * 0.06, radius * 0.68).fill({ color: shade(MAT.painted.top, 0.88) });
  // Standing water in the bottom of it, using the world's shared recess language.
  drawWater(
    g,
    circlePoly(cx, cy + radius * 0.04, radius * 0.42),
    `${o.id}-dish-water`,
    Math.max(4, radius * 0.045),
  );

  // Cars round the inside of the rim, tipped where they came to rest.
  const cars = movingPart(g, "spin", { x: cx, y: cy });
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2 + 0.4;
    const d = radius * 0.79;
    const size = radius * 0.2;
    const px = cx + Math.cos(a) * d;
    const py = cy + Math.sin(a) * d;
    // A car, not a washer: a mass with its own catch light on the lit side, rather than
    // a disc with a darker disc inside it, which is a ring however the values run.
    //
    // The catch light is offset the same way on every car, so it goes round with them
    // rather than staying north-west. On seven small discs at this speed that is under a
    // pixel of error and it buys the cars a top, which is worth more.
    cars.circle(px, py, size).fill({ color: shade(MAT.canvas.top, 0.68) });
    cars.circle(px - size * 0.16, py - size * 0.2, size * 0.72).fill({ color: MAT.canvas.top });
    cars.circle(px, py, size).stroke({ color: MAT.canvas.edge, width: 0.9 });
  }
};

/**
 * A big top: a two-pole tent, and its plan is a stadium.
 *
 * That is not a simplification made to fit a capsule collider — it is what a two-pole
 * tent IS. The canvas is a cone round each mast with straight runs of sheeting between
 * them, so the hem is a semicircle at each end joined by two parallel sides, and both
 * the drawn shape and the collider come off the same `stadiumAxis`.
 *
 * Distinguished from the carousel deliberately, because the two stand in the same
 * region and a scalloped round canopy is the carousel's own signature: this one is a
 * STADIUM rather than a disc, it has TWO crowns rather than one, and its panels change
 * direction — fanned at the ends, running across the middle — which is how a tent of
 * this size is actually cut. Sharing the scalloped hem is on purpose. They came from
 * the same works, and the hem is the fairground's material rather than one ride's mark.
 *
 * TWO THINGS THIS GOT WRONG FIRST, and both were about VALUE rather than shape.
 *
 * The panels were shaded by their own stripe colour with only a whisper of facing on
 * top, so the tent came out as a striped oval lying flat on the ground — the drawing had
 * no idea which way the canvas sloped. Every panel is a FACE, and a face in this
 * language is shaded by `faceLight(normal)` like every other face in the world. The
 * stripe is now a small multiplier on top of that, not the other way round, so the pitch
 * dominates and the tent reads as a roof.
 *
 * And the crowns read as EYES: two large light discs with dark centres, joined by a bar,
 * on a symmetrical face-shaped mass. Reported on sight. They are small, off-centre and
 * gradient-lit now, and the bar between them has become a proper ridge.
 */
const bigTopGlyph: LandmarkFn = (g, pad, o) => {
  const { ax, ay, bx, by, r } = stadiumAxis(o);
  const across = acrossAxis(o);
  const hem = stadiumPoly(ax, ay, bx, by, r, 22);
  contactShape(pad, hem, LIFT.tower);

  /**
   * The south face, as a crescent: the hem polygon shifted along the pull and drawn in
   * the front tone before anything else. This is `cylinder`'s own trick, and without it
   * the tent had no apparent height at all — the whole point of a big top is that it is
   * the tallest thing on the site.
   */
  const lift = LIFT.tower * 0.5;
  fillPoly(g, hem.map((p) => ({ x: p.x, y: p.y + lift })), MAT.canvas.front);
  // Then the canvas as one field, so a seam between panels shows canvas, not ground.
  fillPoly(g, hem, shade(MAT.canvas.top, 0.86));

  const peaks: Vec2[] = [{ x: ax, y: ay }, { x: bx, y: by }];
  const PANELS = 9;
  /** How much a stripe darkens its panel. Small, because the PITCH is the value story. */
  const stripeOf = (dark: boolean): number => (dark ? 0.93 : 1);

  /**
   * The end cones: wedges fanned from each mast out to its own half of the hem.
   *
   * Wide alternating wedges rather than seams, which is the kit's standing answer to
   * the dial — a thin radial line on a round thing is a clock hand, and a wide one is
   * a stripe. Half a turn each, so the fans meet the cross-bands square.
   *
   * Each wedge is a sloping face whose outward normal is its own bearing from the mast,
   * so `faceLight` shades it: the north side of each cone is bright, the south side is in
   * shade, and a cone reads as a cone with no gradient needed.
   */
  peaks.forEach((peak, end) => {
    const base = across ? (end === 0 ? Math.PI / 2 : -Math.PI / 2) : (end === 0 ? Math.PI : 0);
    for (let i = 0; i < PANELS; i += 1) {
      const a0 = base + (i / PANELS) * Math.PI;
      const a1 = base + ((i + 1) / PANELS) * Math.PI;
      const wedge: Vec2[] = [peak];
      for (let s = 0; s <= 3; s += 1) {
        const a = a0 + (a1 - a0) * (s / 3);
        wedge.push({ x: peak.x + Math.cos(a) * r, y: peak.y + Math.sin(a) * r });
      }
      const mid = (a0 + a1) / 2;
      const slope = faceLight({ x: Math.cos(mid), y: Math.sin(mid) });
      fillPoly(g, wedge, shade(MAT.canvas.top, slope * stripeOf((i + end) % 2 === 1)));
    }
  });

  /**
   * The middle: sheeting across the ridge between the two masts, split at the ridge so
   * each half is its own face.
   *
   * Bands rather than a fan, because there is no single centre here to fan from — and
   * that change of direction is the strongest single cue that this is a tent with two
   * poles in it rather than a very large round canopy. Splitting at the ridge is what
   * stops the middle reading as a floor: the two halves land two full steps of value
   * apart, which is a roofline.
   */
  const runLength = Math.hypot(bx - ax, by - ay);
  const bands = Math.max(2, Math.round(runLength / ((r / PANELS) * 2.6)));
  for (let i = 0; i < bands; i += 1) {
    const t0 = i / bands;
    const t1 = (i + 1) / bands;
    for (const side of [-1, 1]) {
      const strip: Vec2[] = across
        ? [
          { x: ax + (bx - ax) * t0, y: ay }, { x: ax + (bx - ax) * t1, y: ay },
          { x: ax + (bx - ax) * t1, y: ay + r * side }, { x: ax + (bx - ax) * t0, y: ay + r * side },
        ]
        : [
          { x: ax, y: ay + (by - ay) * t0 }, { x: ax, y: ay + (by - ay) * t1 },
          { x: ax + r * side, y: ay + (by - ay) * t1 }, { x: ax + r * side, y: ay + (by - ay) * t0 },
        ];
      const normal: Vec2 = across ? { x: 0, y: side } : { x: side, y: 0 };
      fillPoly(g, strip, shade(MAT.canvas.top, faceLight(normal) * stripeOf(i % 2 === 1)));
    }
  }

  /**
   * The ridge: the line the canvas is pulled along, drawn as a tapered highlight rather
   * than a stroke.
   *
   * A gradient across it, which is the first use of one in this kit and the reason to
   * reach for it here: a ridge is not a line, it is the brightest part of a curved
   * surface falling away both ways, and two flat halves meeting at a hard seam is a
   * folded card. `textureSpace: "local"` maps the stops across the shape's own bounds, so
   * the same code works whichever axis the tent is authored on.
   */
  const spine = r * 0.13;
  const ridge: Vec2[] = across
    ? [{ x: ax, y: ay - spine }, { x: bx, y: by - spine }, { x: bx, y: by + spine }, { x: ax, y: ay + spine }]
    : [{ x: ax - spine, y: ay }, { x: ax + spine, y: ay }, { x: bx + spine, y: by }, { x: bx - spine, y: by }];
  g.poly(ridge.map((p) => [p.x, p.y]).flat()).fill(new FillGradient({
    type: "linear",
    start: across ? { x: 0, y: 0 } : { x: 0, y: 0 },
    end: across ? { x: 0, y: 1 } : { x: 1, y: 0 },
    textureSpace: "local",
    colorStops: [
      { offset: 0, color: shade(MAT.canvas.top, faceLight({ x: 0, y: -1 })) },
      { offset: 0.46, color: MAT.canvas.lit },
      { offset: 1, color: shade(MAT.canvas.top, faceLight({ x: 0, y: 1 })) },
    ],
  }));

  /**
   * SAG: the one mark that says this tent has been standing for fifty years.
   *
   * Canvas between two poles holds water halfway down each slope, and a damp patch on
   * canvas is darker than the canvas. Laid over the panels rather than between them, so
   * it crosses the stripes — which is what makes it read as something ON the surface
   * rather than as another panel.
   *
   * SECOND ATTEMPT. The first drew each pool in `GRD.deep` at full opacity, sized from
   * `runLength * 0.34` against `r * 0.3` — and since this tent's poles are only 140 apart
   * against a 160 radius, "wide and shallow" came out as a circle. Two hard blue-grey
   * discs on a pale tent, one per slope. It read as a swimming pool, and it is a good
   * example of the thing to distrust: a detail sized off the wrong dimension, in a
   * material from the wrong family, at an opacity chosen by not choosing one.
   *
   * A stain is a low-alpha wash of the surface's OWN tone, and its shape comes off the
   * radius, which is the dimension that is always there.
   */
  for (const side of [-1, 1]) {
    const long = r * 0.78;
    const short = r * 0.2;
    const pool: Vec2[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i += 1) {
      const angle = (i / steps) * Math.PI * 2;
      const u = Math.cos(angle) * long;
      const v = Math.sin(angle) * short + r * 0.52 * side;
      pool.push(across
        ? { x: (ax + bx) / 2 + u, y: ay + v }
        : { x: ax + v, y: (ay + by) / 2 + u });
    }
    fillPoly(g, pool, shade(MAT.canvas.top, 0.56), 0.32);
  }

  /**
   * The entrance, on the side the tent addresses.
   *
   * Placed GEOMETRICALLY rather than by an index into the hem, because the first version
   * counted points round the outline and landed 45° off south the moment the tent was
   * authored on its other axis. Where the way in is depends on where the crowd comes
   * from, so it comes off `facing` and defaults south — which is the promenade.
   */
  const facing = o.facing ?? "S";
  const dir: Vec2 = facing === "N"
    ? { x: 0, y: -1 }
    : facing === "S"
      ? { x: 0, y: 1 }
      : facing === "E" ? { x: 1, y: 0 } : { x: -1, y: 0 };
  // Where on the ridge the doorway hangs off: the end the tent faces, or the middle of
  // the run when the ridge is square to the way in.
  const along = (bx - ax) * dir.x + (by - ay) * dir.y;
  const t = along > 0 ? 1 : along < 0 ? 0 : 0.5;
  const doorAt: Vec2 = {
    x: ax + (bx - ax) * t + dir.x * r,
    y: ay + (by - ay) * t + dir.y * r,
  };

  // The hem: a scalloped edge all the way round, with the run at the doorway left plain.
  // Drawn from the hem polygon itself, so it can never sit outside the collider.
  const scallops = stadiumPoly(ax, ay, bx, by, r * 0.985, 34);
  const doorGap = r * 0.42;
  for (const point of scallops) {
    if (Math.hypot(point.x - doorAt.x, point.y - doorAt.y) < doorGap) continue;
    g.circle(point.x, point.y, r * 0.075).fill({ color: shade(MAT.canvas.top, 0.8) });
  }
  g.poly(hem.map((p) => [p.x, p.y]).flat()).stroke({ color: MAT.canvas.edge, width: 1.2 });

  /**
   * The doorway: the two canvas flaps tied back, and the dark of the tent behind them.
   *
   * Drawn INWARD from the hem, never out — a porch past the collider would be canvas you
   * could walk through. It is also the one mark on the glyph at a bot's own scale, which
   * is what stops a tent this large reading as a marquee-shaped rock.
   *
   * The first version was a light trapezoid with a dark one inside it and read as a hatch
   * cut in the roof, because a symmetrical shape with a dark middle is a hole. What a tent
   * door looks like from above is TWO flaps, held open at an angle, with the black of the
   * inside between them — an asymmetric pair, not a rectangle.
   */
  const perp: Vec2 = { x: -dir.y, y: dir.x };
  // Shallow, and the number matters. At r * 0.36 the mouth reached a third of the way to
  // the ridge and read as a hatch cut in the roof; a door seen from directly above a tent
  // is a NOTCH IN THE HEM, because the canvas overhangs almost all of it.
  const half = r * 0.22;
  const depth = r * 0.17;
  const step = (from: number, spread: number): Vec2 => ({
    x: doorAt.x - dir.x * from + perp.x * spread,
    y: doorAt.y - dir.y * from + perp.y * spread,
  });
  // The mouth, first and darkest: the inside of a tent in daylight is nearly black.
  fillPoly(g, [
    step(0, -half * 0.72), step(0, half * 0.72),
    step(depth, half * 0.44), step(depth, -half * 0.44),
  ], shade(GRD.abyss, 1.24));
  // Then a flap either side, each drawn back to the hem and each catching the light on
  // its own face — which is what makes them flaps rather than a frame round a hole.
  for (const side of [-1, 1]) {
    fillPoly(g, [
      step(0, side * half * 0.66), step(0, side * half * 1.5),
      step(depth * 0.62, side * half * 1.16), step(depth * 0.5, side * half * 0.5),
    ], shade(MAT.canvas.top, side < 0 ? faceLight({ x: -0.6, y: -0.8 }) : faceLight({ x: 0.7, y: 0.4 })));
  }

  /**
   * The crowns, one per mast: the ring the canvas is laced to, and the pole head in it.
   * TWO of them, and that is the count that names the building — one crown is a
   * roundabout, two is a big top.
   *
   * THE SECOND ATTEMPT, and the first was reported on sight: at r * 0.2 with a bright
   * flat fill and a dark disc dead centre, two of them on a symmetrical mass read as a
   * pair of EYES with a bar between them. Three things were wrong and all three are the
   * same mistake — drawing a diagram of a mast head rather than a mast head.
   *
   *  - SIZE. Two-fifths of the tent's half-width is not a fitting, it is a feature. 0.12.
   *  - THE OUTLINE. A dark ring round a light disc IS an iris, and it was the single
   *    strongest part of the effect. There is no stroke here at all now — the apex is
   *    lighter than the canvas around it, and that is enough to be an apex.
   *  - FLATNESS. A radial gradient from the pole outward makes the apex a dome. This is
   *    what a gradient is FOR, and the kit had never used one.
   *
   * What replaces the ring is the LACING: six short ticks where the canvas is tied to the
   * crown hoop. Radial line work on something round is normally the dial trap, but a dial
   * needs marks long enough to sweep — at a tenth of the tent's radius these read as
   * stitching, and they are what says mast rather than blob.
   */
  for (const peak of peaks) {
    const crown = r * 0.12;
    g.circle(peak.x, peak.y, crown).fill(new FillGradient({
      type: "radial",
      center: { x: 0.38, y: 0.36 },
      innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.5,
      textureSpace: "local",
      colorStops: [
        { offset: 0, color: MAT.canvas.lit },
        { offset: 0.62, color: MAT.canvas.top },
        { offset: 1, color: shade(MAT.canvas.top, faceLight({ x: 0.4, y: 1 })) },
      ],
    }));
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      g.moveTo(peak.x + Math.cos(a) * crown * 0.5, peak.y + Math.sin(a) * crown * 0.5)
        .lineTo(peak.x + Math.cos(a) * crown * 1.05, peak.y + Math.sin(a) * crown * 1.05)
        .stroke({ color: shade(MAT.canvas.edge, 1.1), width: 0.7, alpha: 0.65 });
    }
    // The pole head: small, dark, and pushed south-east off the crown's centre, so it
    // sits at the foot of the lit slope instead of dead centre of a shape.
    const pole = crown * 0.24;
    g.circle(peak.x + crown * 0.18, peak.y + crown * 0.22, pole).fill({ color: MAT.iron.edge });
  }
};

// ---------------------------------------------------------------------------
// The temple
// ---------------------------------------------------------------------------

/** A stele: a carved standing slab. Narrow, tall, and it repeats on a rhythm. */
const steleGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  contact(pad, r, LIFT.tower);
  const top = volume(g, r, MAT.stone, LIFT.tower);

  // Carved registers stacked up the face. Bands, not a picture: at play zoom the
  // rhythm of the courses is what reads, and the rhythm IS the carving.
  const bands = Math.max(3, Math.round(Math.max(top.w, top.h) / 22));
  const across = acrossAxis(o);
  for (let i = 0; i < bands; i += 1) {
    const t = (i + 0.5) / bands;
    const cut = across
      ? { x: top.x + top.w * t - 2, y: top.y + 3, w: 4, h: top.h - 6 }
      : { x: top.x + 3, y: top.y + top.h * t - 2, w: top.w - 6, h: 4 };
    inlay(g, cut, shade(MAT.stone.front, 0.88));
    inlay(g, across ? { ...cut, w: 1.4 } : { ...cut, h: 1.4 }, shade(MAT.stone.top, 1.1));
  }
  // Weathering down one flank, so a row of them is not a row of identical slabs.
  if (jitter(o.id, 3) > 0.4) {
    inlay(g, across
      ? { x: top.x, y: top.y, w: top.w * 0.3, h: top.h }
      : { x: top.x, y: top.y, w: top.w, h: top.h * 0.3 },
      shade(MAT.stoneWorn.top, 0.94));
  }
};

/** An altar: a low broad block with a heavy cap. */
const altarGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  contact(pad, r, LIFT.bench);
  const top = volume(g, r, MAT.stoneWorn, LIFT.bench);
  // The cap overhangs the plinth. Drawn as an inset ring rather than an outset one,
  // because nothing solid-looking may sit outside the collider.
  inlay(g, inset(top, 4), shade(MAT.stone.top, 1.04));
  g.rect(top.x + 4, top.y + 4, top.w - 8, top.h - 8).stroke({ color: MAT.stone.front, width: 1 });
  // A shallow basin worn into the middle.
  const bowl = Math.min(top.w, top.h) * 0.26;
  g.circle(top.x + top.w / 2, top.y + top.h / 2, bowl).fill({ color: shade(MAT.stoneWorn.front, 0.86) });
  g.circle(top.x + top.w / 2 + 1.5, top.y + top.h / 2 + 2, bowl * 0.86)
    .fill({ color: shade(MAT.stoneWorn.top, 0.96) });
};

/**
 * A serpent head at the foot of a stair.
 *
 * Two of them flanking a flight is the single most recognisable thing a Mesoamerican
 * temple has, which is why a blocky carving earns its own kind. Drawn as a wedge —
 * broad at the jaw, tapered at the snout — because the taper is what reads at zoom.
 */
const serpentHeadGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  // The snout points the way the object faces; default south, out from the stair.
  const facing = o.facing ?? "S";
  const shape: Vec2[] = facing === "S"
    ? [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x + r.w * 0.78, y: r.y + r.h }, { x: r.x + r.w * 0.22, y: r.y + r.h },
    ]
    : facing === "N"
      ? [
        { x: r.x + r.w * 0.22, y: r.y }, { x: r.x + r.w * 0.78, y: r.y },
        { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
      ]
      : facing === "E"
        ? [
          { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h * 0.22 },
          { x: r.x + r.w, y: r.y + r.h * 0.78 }, { x: r.x, y: r.y + r.h },
        ]
        : [
          { x: r.x, y: r.y + r.h * 0.22 }, { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h * 0.78 },
        ];
  contactShape(pad, shape, LIFT.mass);
  volumeShape(g, shape, MAT.stone, LIFT.mass);

  /**
   * The muzzle and the eye, as compact blocky detail scaled from the centroid.
   *
   * Insetting these was the first attempt and it turned every head into a little
   * arrow: an inset past a shape's own inradius does not shrink it, it turns it
   * inside out. Scaling toward the centre cannot degenerate.
   */
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const scaled = (k: number): Vec2[] => shape.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
  fillPoly(g, scaled(0.62), shade(MAT.stone.top, 0.9));
  const eye = Math.min(r.w, r.h) * 0.13;
  for (const side of [-1, 1]) {
    const at = facing === "S" || facing === "N"
      ? { x: cx + side * r.w * 0.24, y: cy - r.h * 0.14 }
      : { x: cx - r.w * 0.14, y: cy + side * r.h * 0.24 };
    g.circle(at.x, at.y, eye).fill({ color: shade(MAT.stone.front, 0.7) });
    g.circle(at.x - eye * 0.2, at.y - eye * 0.2, eye * 0.5).fill({ color: shade(MAT.stone.top, 1.1) });
  }
};

/**
 * A brazier: a stone bowl on a plinth, cold.
 *
 * No flame, no smoke, because a frozen flame is an artefact — and on an abandoned
 * court a cold brazier is the truth about the place anyway, so nothing is lost. If
 * the temple ever gets an inhabited quarter, the answer there is a LIT brazier with
 * real flicker, not a painted one.
 */
const brazierGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.mass);
  cylinder(g, cx, cy, radius, MAT.stoneWorn, LIFT.mass);
  g.circle(cx, cy, radius * 0.88).stroke({ color: shade(MAT.stone.front, 0.9), width: 1.4 });
  // The bowl, as a recess with ash in the bottom of it.
  g.circle(cx, cy, radius * 0.62).fill({ color: shade(MAT.stoneWorn.front, 0.66) });
  g.circle(cx + radius * 0.06, cy + radius * 0.08, radius * 0.56)
    .fill({ color: shade(MAT.stoneWorn.top, 0.9) });
  g.circle(cx, cy + radius * 0.04, radius * 0.4).fill({ color: shade(GRD.abyss, 1.28) });
  g.circle(cx - radius * 0.1, cy - radius * 0.06, radius * 0.14)
    .fill({ color: shade(GRD.abyss, 1.7), alpha: 0.6 });
};

export const landmarkGlyphs: Partial<Record<MapObject["kind"], LandmarkFn>> = {
  boulder: boulderGlyph,
  thicket: thicketGlyph,
  log: logGlyph,
  track: trackGlyph,
  turntable: turntableGlyph,
  wagon: wagonGlyph,
  bufferStop: bufferStopGlyph,
  waterTank: waterTankGlyph,
  coalingTower: coalingTowerGlyph,
  carousel: carouselGlyph,
  swingRide: swingRideGlyph,
  waltzer: waltzerGlyph,
  helterSkelter: helterSkelterGlyph,
  bigTop: bigTopGlyph,
  stele: steleGlyph,
  altar: altarGlyph,
  serpentHead: serpentHeadGlyph,
  brazier: brazierGlyph,
};
