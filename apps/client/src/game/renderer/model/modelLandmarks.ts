import type { Graphics } from "pixi.js";
import type { MapObject, Vec2 } from "@dotbot/game/types";
import { GRD, fillPoly } from "./modelGround";
import {
  contact,
  contactBlock,
  contactRound,
  contactShape,
  cylinder,
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
 *  - A VERTICAL WHEEL IS A LINE. Seen from directly above, a ferris wheel is a
 *    narrow band with gondolas along it. Drawing the circle would be exactly the
 *    perspective cheat this language exists to refuse, so it is drawn as the line it
 *    is and the A-frames carry the scale.
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

/** True when the object is longer east-west than north-south. */
function acrossAxis(o: MapObject): boolean {
  return o.w >= o.h;
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
 * Drawn as merged lobes with a deliberately frayed rim, at values that top out AT
 * `MAT.foliage.top` rather than below it. Two earlier attempts bracket the answer: a
 * ramp topping out four steps DARK of the ground made a thicket read as a boulder,
 * and a ramp pushed 1.14 above it made popcorn. What actually separates leaves from
 * stone is the broken outline.
 */
const thicketGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const rx = o.w / 2;
  const ry = o.h / 2;
  const size = Math.min(rx, ry);
  contactRound(pad, cx, cy, size * 0.82, LIFT.mass);

  const under = shade(MAT.foliage.top, 0.62);
  const body = shade(MAT.foliage.top, 0.84);
  const lit = MAT.foliage.top;

  fillPoly(g, blob(cx, cy, rx, ry, `${o.id}u`, 0.24, 17), under);

  const lobes = Math.max(5, Math.round(Math.max(rx, ry) / 26));
  for (let i = 0; i < lobes; i += 1) {
    const a = (i / lobes) * Math.PI * 2 + jitter(o.id, i) * 0.7;
    const d = 0.34 + jitter(o.id, i + 20) * 0.34;
    const px = cx + Math.cos(a) * rx * d;
    const py = cy + Math.sin(a) * ry * d;
    // Lit by the same north-slightly-west light as everything else: a lobe facing
    // that way is bright, one facing away stays in the mass.
    const facing = (Math.cos(a) * -0.33 + Math.sin(a) * -0.94 + 1) / 2;
    const r = size * (0.42 + jitter(o.id, i + 40) * 0.2);
    g.circle(px, py, r).fill({ color: facing > 0.62 ? lit : body });
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
  // The whole pad, not one layer of it: handed a single Graphics the block form paints a
  // hard black slab, and the stage came out flat as paper on the ballast.
  contact(pad, r, LIFT.tower);
  const top = volume(g, r, MAT.stoneWorn, LIFT.tower);

  // The bunker's own division: two bins over the track, which is what a coaling
  // stage is, plus the hoist housing on the north end where it catches the light.
  const across = acrossAxis(o);
  inlay(g, across
    ? { x: top.x + top.w / 2 - 1.5, y: top.y + 2, w: 3, h: top.h - 4 }
    : { x: top.x + 2, y: top.y + top.h / 2 - 1.5, w: top.w - 4, h: 3 },
    shade(MAT.stoneWorn.front, 0.86));
  const hoist = across
    ? { x: top.x + top.w * 0.06, y: top.y + top.h * 0.16, w: top.w * 0.22, h: top.h * 0.68 }
    : { x: top.x + top.w * 0.16, y: top.y + top.h * 0.06, w: top.w * 0.68, h: top.h * 0.22 };
  inlay(g, hoist, shade(MAT.iron.top, 1.06));
  inlay(g, inset(hoist, 2), MAT.iron.front);

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
 */
const carouselGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.tower);

  // Deck first, showing at the hem, so the ride reads as a platform under a roof.
  cylinder(g, cx, cy, radius, MAT.woodDark, LIFT.mass);

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
    fillPoly(g, wedge, shade(base, 0.9 + facing * 0.22));
  }

  // The scalloped hem: the fairground's own signature, and it breaks the disc.
  const scallops = panels * 2;
  for (let i = 0; i < scallops; i += 1) {
    const a = (i / scallops) * Math.PI * 2;
    g.circle(cx + Math.cos(a) * canopy, cy + Math.sin(a) * canopy, radius * 0.075)
      .fill({ color: shade(MAT.canvas.top, 0.84) });
  }
  g.circle(cx, cy, canopy).stroke({ color: MAT.canvas.edge, width: 1.1 });

  // The crown boss, then the horses on their ring — one gap, because an abandoned
  // carousel is missing a horse and that absence is worth more than the twelve.
  g.circle(cx, cy, radius * 0.2).fill({ color: shade(MAT.canvas.top, 1.06) });
  g.circle(cx, cy, radius * 0.2).stroke({ color: MAT.canvas.edge, width: 0.9 });
  const ring = radius * 0.62;
  for (let i = 0; i < 10; i += 1) {
    if (i === 6) continue;
    const a = (i / 10) * Math.PI * 2 + 0.2;
    const px = cx + Math.cos(a) * ring;
    const py = cy + Math.sin(a) * ring;
    g.circle(px, py, radius * 0.09).fill({ color: shade(MAT.painted.top, 0.94) });
    g.circle(px, py, radius * 0.055).fill({ color: shade(MAT.painted.top, 1.16) });
  }
};

/**
 * A ferris wheel, seen from directly overhead: a line.
 *
 * This is the single most honest thing in the kit. From up here the rim is edge-on —
 * a narrow band the width of the wheel's own structure — and drawing the circle
 * instead would be exactly the perspective cheat the whole language exists to
 * refuse. What carries the scale is the pair of A-frames, and each one is split into
 * two members rather than drawn as a solid triangle, because a big closed dark shape
 * in this language is a wall.
 */
const ferrisWheelGlyph: LandmarkFn = (g, pad, o) => {
  const r = rect(o);
  const across = acrossAxis(o);
  const span = across ? r.w : r.h;
  const band = across ? r.h : r.w;
  contact(pad, r, LIFT.tower);

  const mid = across ? r.x + span * 0.5 : r.y + span * 0.5;
  const axis = across ? r.y + band / 2 : r.x + band / 2;

  // The rim, edge-on: the wheel itself, drawn first so everything else reads as fixed
  // to it. Narrow, because that is all a rim IS from here.
  const rim = across
    ? { x: r.x, y: axis - band * 0.11, w: span, h: band * 0.22 }
    : { x: axis - band * 0.11, y: r.y, w: band * 0.22, h: span };
  inlay(g, rim, MAT.iron.front);
  inlay(g, across
    ? { x: rim.x, y: rim.y, w: rim.w, h: 2 }
    : { x: rim.x, y: rim.y, w: 2, h: rim.h },
    shade(MAT.iron.top, 1.18));

  /**
   * The gondolas: evenly spaced along the rim, hanging still.
   *
   * Still is not a compromise here — the ride is derelict, so nothing about it is in
   * motion, and the language's fourth rule is satisfied without any animation at all. A
   * rusted wheel that does not turn is the point of the place.
   */
  const cars = Math.max(6, Math.round(span / 52));
  for (let i = 0; i < cars; i += 1) {
    const t = (i + 0.5) / cars;
    const at = across ? { x: r.x + span * t, y: axis } : { x: axis, y: r.y + span * t };
    const size = band * 0.19;
    // One value, not two alternating: alternating light and dark cars turned the rim
    // into a dashed line, which is a road marking rather than a ride.
    g.roundRect(at.x - size / 2, at.y - size / 2, size, size, size * 0.3)
      .fill({ color: shade(MAT.canvas.top, 0.92) });
    g.roundRect(at.x - size / 2, at.y - size / 2, size, size, size * 0.3)
      .stroke({ color: MAT.iron.edge, width: 0.8 });
  }

  /**
   * The A-FRAMES AND THE HUB, at the axle, and this is the third attempt.
   *
   * The first drew them in mid iron and the ride came out as a dotted line. The second
   * made them dark and wide and it came out as a LADDER — because they were at 0.18 and
   * 0.82 of the run, one near each end. That is where a coaster's trestles go. A ferris
   * wheel is cantilevered off a single axle, so both frames straddle the MIDDLE, and what
   * says wheel from directly above is a long thin rim with one heavy bearing in the
   * centre of it. Two marks in the right place beat six in the wrong one.
   */
  for (const lean of [-1, 1]) {
    const foot = (band / 2 - 2) * lean;
    const legs: Vec2[] = across
      ? [
        { x: mid - 9, y: axis }, { x: mid + 9, y: axis },
        { x: mid + band * 0.26 * lean + 11, y: axis + foot },
        { x: mid + band * 0.26 * lean - 11, y: axis + foot },
      ]
      : [
        { x: axis, y: mid - 9 }, { x: axis, y: mid + 9 },
        { x: axis + foot, y: mid + band * 0.26 * lean + 11 },
        { x: axis + foot, y: mid + band * 0.26 * lean - 11 },
      ];
    fillPoly(g, legs, MAT.iron.edge);
    // A catch light down the north-west member, so the frame is a member rather than a
    // stain: the darkest thing on the sheet still has to have a lit face.
    fillPoly(g, legs.map((p, i) => (i === 0 || i === 3
      ? { x: p.x, y: p.y }
      : { x: p.x - (across ? 5 : 0), y: p.y - (across ? 0 : 5) })), shade(MAT.iron.front, 0.86));
  }
  const hub = across ? { x: mid, y: axis } : { x: axis, y: mid };
  g.circle(hub.x, hub.y, band * 0.4).fill({ color: MAT.iron.front });
  g.circle(hub.x, hub.y, band * 0.4).stroke({ color: MAT.iron.edge, width: 1.4 });
  g.circle(hub.x, hub.y, band * 0.24).fill({ color: shade(MAT.iron.top, 1.14) });
  g.circle(hub.x, hub.y, band * 0.1).fill({ color: MAT.iron.edge });
};

/**
 * A waltzer: a dished platform with cars round its inside edge.
 *
 * Dished, so it holds rainwater — which is the one detail that says *abandoned* about
 * a ride rather than about the ground it stands on. The water goes on after the rim,
 * never before: drawn first, the dish's own extrusion paints straight over it.
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
  // Standing water in the bottom of it.
  g.circle(cx, cy + radius * 0.04, radius * 0.42).fill({ color: GRD.deep });
  g.circle(cx - radius * 0.1, cy - radius * 0.04, radius * 0.16)
    .fill({ color: shade(GRD.shallow, 1.3), alpha: 0.3 });

  // Cars round the inside of the rim, tipped where they came to rest.
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2 + 0.4;
    const d = radius * 0.79;
    const size = radius * 0.2;
    const px = cx + Math.cos(a) * d;
    const py = cy + Math.sin(a) * d;
    // A car, not a washer: a mass with its own catch light on the lit side, rather than
    // a disc with a darker disc inside it, which is a ring however the values run.
    g.circle(px, py, size).fill({ color: shade(MAT.canvas.top, 0.68) });
    g.circle(px - size * 0.16, py - size * 0.2, size * 0.72).fill({ color: MAT.canvas.top });
    g.circle(px, py, size).stroke({ color: MAT.canvas.edge, width: 0.9 });
  }
};

/**
 * A chairoplane at rest: a mast, and its seats hanging in a ring.
 *
 * Radial, and it works where the tank's staves failed for one reason — the seats are
 * discrete masses at a radius, not lines through it. Discs read as seats; strokes
 * read as spokes.
 */
const swingRideGlyph: LandmarkFn = (g, pad, o) => {
  const { x: cx, y: cy } = centre(o);
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius * 0.34, LIFT.tower);

  // The canopy over the mast: a small striped cone, echoing the carousel because
  // they came from the same works.
  const hubR = radius * 0.32;
  for (let i = 0; i < 8; i += 1) {
    const a0 = (i / 8) * Math.PI * 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2;
    const wedge: Vec2[] = [{ x: cx, y: cy }];
    for (let s = 0; s <= 3; s += 1) {
      const a = a0 + (a1 - a0) * (s / 3);
      wedge.push({ x: cx + Math.cos(a) * hubR, y: cy + Math.sin(a) * hubR });
    }
    fillPoly(g, wedge, i % 2 === 0 ? shade(MAT.canvas.top, 0.94) : shade(MAT.canvas.top, 0.7));
  }
  g.circle(cx, cy, hubR).stroke({ color: MAT.canvas.edge, width: 1 });
  g.circle(cx, cy, radius * 0.1).fill({ color: MAT.iron.front });

  // Seats hanging at rest, well inside the footprint so the silhouette is the collider.
  const ring = radius * 0.7;
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2 + 0.13;
    const px = cx + Math.cos(a) * ring;
    const py = cy + Math.sin(a) * ring;
    /**
     * No chains. They were drawn short on purpose — "a full-length spoke is a dial" — and
     * twelve short spokes are a dial too. What reads as a ride at rest is the ring of
     * seats alone: discrete masses at a radius, with nothing joining them to the hub.
     */
    // Rounded rectangles set square to the ring, not circles: a ring of discs reads as
    // festoon bulbs, and a bulb is 20 units across while a seat is 40.
    const seat = radius * 0.17;
    g.roundRect(px - seat / 2, py - seat / 2, seat, seat * 0.82, seat * 0.3)
      .fill({ color: shade(MAT.canvas.top, 0.74) });
    g.roundRect(px - seat / 2 + 1.5, py - seat / 2 + 1.5, seat - 3, seat * 0.82 - 3, seat * 0.24)
      .fill({ color: shade(MAT.canvas.top, 1.02) });
    g.roundRect(px - seat / 2, py - seat / 2, seat, seat * 0.82, seat * 0.3)
      .stroke({ color: MAT.canvas.edge, width: 0.9 });
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
 * No flame, no smoke — the language's fourth rule, and the one place it is genuinely
 * a constraint rather than a licence. A frozen flame is an artefact; a cold brazier
 * on an abandoned court is the truth about the place anyway.
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
  ferrisWheel: ferrisWheelGlyph,
  waltzer: waltzerGlyph,
  swingRide: swingRideGlyph,
  stele: steleGlyph,
  altar: altarGlyph,
  serpentHead: serpentHeadGlyph,
  brazier: brazierGlyph,
};
