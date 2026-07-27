import type { Graphics } from "pixi.js";
import type { Facing, MapObject, Vec2 } from "@dotbot/game/types";
import {
  contact,
  contactRound,
  cylinder,
  inlay,
  jitter,
  jitterSigned,
  LIFT,
  MAT,
  seam,
  shade,
  sit,
  sitRound,
  V,
  volume,
  type Material,
  type Rect,
  type ShadowPad,
} from "./tone";

/**
 * Volumetric object glyphs.
 *
 * Two authoring rules, both learned from the failure of the line-work kit:
 *
 *  - SILHOUETTE FIRST. An object must be nameable from its outline alone at
 *    play zoom on a phone. Interior detail is a bonus for players who stop and
 *    look; it is never how the object is identified. A rack is legible because
 *    it is a long thing with repeating bays, not because of the marks in them.
 *
 *  - BOT-NATIVE CONTENTS. Shelves hold cores, plates and boards, not groceries.
 *    Specific contents buy more recognition per pixel than fidelity does, and
 *    they make the world DotBot's instead of a borrowed human one.
 */

export type GlyphFn = (g: Graphics, pad: ShadowPad, o: MapObject) => void;

const DARK_SEAM = 0x5c6165;
const DEEP_SEAM = 0x2f3337;

function rect(o: MapObject): Rect {
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

function inset(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, w: r.w - by * 2, h: r.h - by * 2 };
}

function longAxis(o: MapObject): "v" | "h" {
  return o.h >= o.w ? "v" : "h";
}

// ---------------------------------------------------------------------------
// Rack stock: what a DotBot warehouse actually holds
// ---------------------------------------------------------------------------

/**
 * One core: a thick bright disc in a dark rim, with a hub. Drawn as product
 * rather than as a dial — the rim has to be dark and the face has to be the
 * lightest thing in the bay, or a ring of concentric strokes reads as a gauge.
 */
export function coreDisc(g: Graphics, cx: number, cy: number, r: number, lift = 2.4): void {
  sitRound(g, cx, cy, r, lift);
  g.circle(cx, cy + lift * 0.4, r).fill({ color: MAT.steelDark.front });
  g.circle(cx, cy, r).fill({ color: MAT.steelDark.top });
  g.circle(cx, cy, r * 0.87).fill({ color: MAT.core.top });
  g.circle(cx, cy, r * 0.32).fill({ color: MAT.steelDeep.top });
  g.circle(cx, cy, r * 0.32).stroke({ color: DEEP_SEAM, width: 0.5 });
  g.circle(cx - r * 0.24, cy - r * 0.28, r * 0.24).fill({ color: 0xffffff, alpha: 0.55 });
}

/**
 * Cores, clustered. Tight clusters read as stacked product; evenly spaced
 * circles read as instruments, which is exactly how the first pass failed.
 */
function stockCores(g: Graphics, deck: Rect, id: string): void {
  const across = deck.w >= deck.h;
  const span = across ? deck.w : deck.h;
  const girth = across ? deck.h : deck.w;
  const r = Math.min(girth * 0.42, span * 0.2, 6.4);
  const count = Math.max(2, Math.min(4, Math.floor(span / (r * 2.15))));
  const pitch = r * 2.06;
  const start = (span - pitch * (count - 1)) / 2;
  for (let i = 0; i < count; i += 1) {
    const along = start + pitch * i;
    const wobble = (jitter(id, i) - 0.5) * (girth - r * 2) * 0.5;
    const cx = across ? deck.x + along : deck.x + deck.w / 2 + wobble;
    const cy = across ? deck.y + deck.h / 2 + wobble : deck.y + along;
    coreDisc(g, cx, cy, r);
  }
}

/** Flat armour plates, stacked and banded. */
function stockPlates(g: Graphics, deck: Rect, id: string): void {
  const across = deck.w >= deck.h;
  const span = across ? deck.h : deck.w;
  const count = Math.max(2, Math.min(4, Math.floor(span / 5)));
  const thick = Math.min(3.4, span / (count + 0.8));
  const gap = (span - count * thick) / (count + 1);
  for (let i = 0; i < count; i += 1) {
    const off = gap + i * (thick + gap);
    const bar: Rect = across
      ? { x: deck.x + 1.4, y: deck.y + off, w: deck.w - 2.8, h: thick }
      : { x: deck.x + off, y: deck.y + 1.4, w: thick, h: deck.h - 2.8 };
    sit(g, bar, 1.8);
    inlay(g, bar, MAT.plateStock.top);
    inlay(
      g,
      across ? { ...bar, h: 0.8 } : { ...bar, w: 0.8 },
      MAT.plateStock.lit,
    );
    if (jitter(id, i) > 0.5) {
      const mid = across ? bar.x + bar.w * 0.62 : bar.x;
      const midY = across ? bar.y : bar.y + bar.h * 0.62;
      inlay(g, { x: mid, y: midY, w: across ? 2.2 : bar.w, h: across ? bar.h : 2.2 }, DEEP_SEAM);
    }
  }
}

/** Circuit boards, filed on edge in a slotted tray. */
function stockBoards(g: Graphics, deck: Rect, id: string): void {
  const across = deck.w >= deck.h;
  sit(g, deck, 2.6);
  inlay(g, deck, MAT.steelDeep.front);
  const span = across ? deck.w : deck.h;
  const count = Math.max(3, Math.min(7, Math.floor(span / 4.5)));
  const step = span / count;
  for (let i = 0; i < count; i += 1) {
    const off = step * i + step * 0.24;
    const card: Rect = across
      ? { x: deck.x + off, y: deck.y + 1.4, w: step * 0.5, h: deck.h - 2.8 }
      : { x: deck.x + 1.4, y: deck.y + off, w: deck.w - 2.8, h: step * 0.5 };
    inlay(g, card, jitter(id, i) > 0.45 ? MAT.board.lit : MAT.board.top);
  }
}

/** Fibre cartons. */
function stockCartons(g: Graphics, deck: Rect, id: string): void {
  const across = deck.w >= deck.h;
  const span = across ? deck.w : deck.h;
  const count = Math.max(1, Math.min(3, Math.floor(span / 12)));
  const step = span / count;
  for (let i = 0; i < count; i += 1) {
    const pad = 1.6 + jitter(id, i * 3) * 1.4;
    const box: Rect = across
      ? { x: deck.x + step * i + pad, y: deck.y + pad, w: step - pad * 2.2, h: deck.h - pad * 2 }
      : { x: deck.x + pad, y: deck.y + step * i + pad, w: deck.w - pad * 2, h: step - pad * 2.2 };
    if (box.w <= 1 || box.h <= 1) continue;
    sit(g, box, 2.6);
    const top = volume(g, box, jitter(id, i) > 0.5 ? MAT.fibre : MAT.wood, 2.6);
    seam(g, top.x + top.w * 0.5, top.y + 1, top.x + top.w * 0.5, top.y + top.h - 1, DARK_SEAM, 0.6);
  }
}

/** A picked-over bay. Empty deck is a story beat, not a gap in the drawing. */
function stockPicked(g: Graphics, deck: Rect, id: string): void {
  inlay(g, deck, shade(MAT.steelDark.top, 0.88));
  const scuffs = 1 + Math.floor(jitter(id, 11) * 2);
  for (let i = 0; i < scuffs; i += 1) {
    const fx = 0.2 + jitter(id, 20 + i) * 0.5;
    const fy = 0.2 + jitter(id, 30 + i) * 0.5;
    inlay(
      g,
      { x: deck.x + deck.w * fx, y: deck.y + deck.h * fy, w: Math.max(2, deck.w * 0.22), h: 1 },
      shade(MAT.steelDark.top, 0.74),
    );
  }
}

const STOCK = [stockCores, stockPlates, stockBoards, stockCartons, stockCores, stockPicked];

/**
 * Rack bays never draw the picked-over variant: an empty deck inside a frame
 * reads as a closed cabinet door. A picked bay is shown by omitting the load
 * entirely and leaving the bare pallet visible instead.
 */
const RACK_STOCK = [stockCores, stockPlates, stockBoards, stockCartons, stockCores, stockPlates];

// ---------------------------------------------------------------------------
// Racking — the hero fixture of a depot floor
// ---------------------------------------------------------------------------

/**
 * A pallet-racking run.
 *
 * The first pass drew this as a closed cabinet with recessed panels and it read
 * as a server rack, because a rack is not identified by its frame — it is
 * identified by *a pallet in every bay with a load sitting on it*, separated by
 * hard beam lines. So the frame goes dark and thin, the pallet and its load are
 * the brightest things in the bay, and the beams carry the rhythm.
 */
function rackGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const vertical = longAxis(o) === "v";
  const along = vertical ? r.h : r.w;
  const across = vertical ? r.w : r.h;

  contact(pad, r, LIFT.cabinet);

  const rail = Math.max(2.2, Math.min(3.2, across * 0.11));
  const beam = 3.4;
  const bays = Math.max(2, Math.min(8, Math.round(along / 44)));
  const bayLen = (along - beam * (bays + 1)) / bays;

  // Frame void: what you see between members, in deep shadow.
  inlay(g, r, 0x5f646a);

  for (let i = 0; i < bays; i += 1) {
    const off = beam + i * (bayLen + beam);
    const bay: Rect = vertical
      ? { x: r.x + rail, y: r.y + off, w: across - rail * 2, h: bayLen }
      : { x: r.x + off, y: r.y + rail, w: bayLen, h: across - rail * 2 };
    if (bay.w <= 3 || bay.h <= 3) continue;

    const roll = jitter(o.id, i * 7 + 1);

    // Every occupied bay gets a pallet. This is the recognition cue.
    const skid = inset(bay, 0.8);
    sit(g, skid, 3);
    const deck = palletDeck(g, skid, `${o.id}:p${i}`, MAT.wood);

    if (roll < 0.14) continue; // a bare pallet: the bay has been picked out

    const usable = inset(deck, 1.6);
    if (usable.w <= 2 || usable.h <= 2) continue;
    const pick = Math.floor(roll * RACK_STOCK.length) % RACK_STOCK.length;
    RACK_STOCK[pick](g, usable, `${o.id}:${i}`);
  }

  // Beams: the hard horizontal rhythm that names a rack from above.
  for (let i = 0; i <= bays; i += 1) {
    const off = i * (bayLen + beam);
    const bar: Rect = vertical
      ? { x: r.x, y: r.y + off, w: across, h: beam }
      : { x: r.x + off, y: r.y, w: beam, h: across };
    inlay(g, bar, MAT.steelDeep.front);
    inlay(g, vertical ? { ...bar, h: 1 } : { ...bar, w: 1 }, MAT.steelDark.lit);
    // Upright nubs where each beam meets a rail.
    for (const near of [true, false]) {
      const nub: Rect = vertical
        ? { x: near ? r.x : r.x + r.w - rail, y: bar.y - 0.6, w: rail, h: beam + 1.2 }
        : { x: bar.x - 0.6, y: near ? r.y : r.y + r.h - rail, w: beam + 1.2, h: rail };
      inlay(g, nub, DEEP_SEAM);
    }
  }

  // Continuous rails down both flanks, lit on top so the steel reads as steel.
  for (const near of [true, false]) {
    const flank: Rect = vertical
      ? { x: near ? r.x : r.x + r.w - rail, y: r.y, w: rail, h: r.h }
      : { x: r.x, y: near ? r.y : r.y + r.h - rail, w: r.w, h: rail };
    inlay(g, flank, MAT.steelDeep.top);
    inlay(g, vertical ? { ...flank, w: 0.9 } : { ...flank, h: 0.9 }, MAT.steelDark.top);
  }

  g.rect(r.x + 0.45, r.y + 0.45, r.w - 0.9, r.h - 0.9).stroke({ color: 0x2b2f33, width: 0.9 });
}

// ---------------------------------------------------------------------------
// Loose freight
// ---------------------------------------------------------------------------

/** A stringer pallet: three runners, slatted deck, visible gaps. */
function palletDeck(g: Graphics, r: Rect, id: string, mat: Material = MAT.wood): Rect {
  const across = r.w >= r.h;
  const top = volume(g, r, mat, LIFT.low);
  const span = across ? top.h : top.w;
  const boards = Math.max(4, Math.min(7, Math.round(span / 6)));
  const gap = Math.max(1.1, span * 0.055);
  const board = (span - gap * (boards - 1)) / boards;
  for (let i = 1; i < boards; i += 1) {
    const off = i * (board + gap) - gap;
    const slot: Rect = across
      ? { x: top.x + 1, y: top.y + off, w: top.w - 2, h: gap }
      : { x: top.x + off, y: top.y + 1, w: gap, h: top.h - 2 };
    inlay(g, slot, shade(mat.front, 0.7));
  }
  // Stringers show as three shadowed cross bands under the deck boards.
  for (const f of [0.08, 0.5, 0.92]) {
    const bar: Rect = across
      ? { x: top.x + top.w * f - 1.2, y: top.y, w: 2.4, h: top.h }
      : { x: top.x, y: top.y + top.h * f - 1.2, w: top.w, h: 2.4 };
    inlay(g, bar, mat.top);
  }
  void id;
  return top;
}

function palletGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.low);
  const top = palletDeck(g, r, o.id);

  const load = jitter(o.id, 3);
  if (load < 0.34) return; // an empty pallet on a dock strip is normal

  const padding = 2.4;
  const box: Rect = {
    x: top.x + padding,
    y: top.y + padding - 1,
    w: top.w - padding * 2,
    h: top.h - padding * 2,
  };
  sit(g, box, 4);
  if (load < 0.68) {
    // Banded stack of plates.
    const stack = volume(g, box, MAT.plateStock, 5);
    for (let i = 1; i < 4; i += 1) {
      seam(g, stack.x, stack.y + (stack.h / 4) * i, stack.x + stack.w, stack.y + (stack.h / 4) * i, DARK_SEAM, 0.6);
    }
    for (const f of [0.3, 0.72]) {
      inlay(g, { x: stack.x + stack.w * f - 1, y: stack.y, w: 2, h: stack.h }, DEEP_SEAM);
    }
    return;
  }
  // Wrapped bale: translucent stretch film reads as a lighter, softer block.
  const wrap = volume(g, box, MAT.fibre, 6, 1.5);
  inlay(g, { x: wrap.x, y: wrap.y, w: wrap.w, h: wrap.h }, 0xffffff);
  g.rect(wrap.x, wrap.y, wrap.w, wrap.h).fill({ color: MAT.fibre.top, alpha: 0.72 });
  for (const f of [0.26, 0.54, 0.82]) {
    inlay(g, { x: wrap.x, y: wrap.y + wrap.h * f, w: wrap.w, h: 0.8 }, shade(MAT.fibre.front, 0.9));
  }
  g.rect(wrap.x + 0.45, wrap.y + 0.45, wrap.w - 0.9, wrap.h - 0.9).stroke({ color: MAT.fibre.edge, width: 0.9 });
}

function crateStackGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.crate);
  const base = volume(g, r, MAT.wood, LIFT.crate);

  // Lid seam and corner cleats: the crate's own construction, not annotation.
  seam(g, base.x + 2, base.y + base.h / 2, base.x + base.w - 2, base.y + base.h / 2, shade(MAT.wood.front, 0.85), 0.8);
  const cleat = Math.max(2.6, base.w * 0.16);
  for (const [cx, cy] of [
    [base.x, base.y],
    [base.x + base.w - cleat, base.y],
    [base.x, base.y + base.h - cleat],
    [base.x + base.w - cleat, base.y + base.h - cleat],
  ]) {
    inlay(g, { x: cx, y: cy, w: cleat, h: cleat }, MAT.woodDark.top);
  }
  // Stencil block: a shipping mark, deliberately unreadable at play zoom.
  inlay(
    g,
    { x: base.x + base.w * 0.26, y: base.y + base.h * 0.2, w: base.w * 0.46, h: Math.max(1.6, base.h * 0.1) },
    shade(MAT.wood.front, 0.72),
  );

  if (jitter(o.id, 5) < 0.4) return;

  // Second crate: clearly smaller, only slightly off square. A large offset
  // reads as a drawing error rather than as a hand-stacked crate.
  const pad2 = 5.5 + jitter(o.id, 6) * 1.5;
  const dx = (jitter(o.id, 7) - 0.5) * 2;
  const dy = (jitter(o.id, 8) - 0.5) * 1.6;
  const upper: Rect = {
    x: base.x + pad2 + dx,
    y: base.y + pad2 * 0.7 + dy,
    w: base.w - pad2 * 2,
    h: base.h - pad2 * 1.7,
  };
  if (upper.w <= 3 || upper.h <= 3) return;
  sit(g, upper, 5);
  const lid = volume(g, upper, MAT.woodDark, 4.5);
  seam(g, lid.x + 1.5, lid.y + lid.h / 2, lid.x + lid.w - 1.5, lid.y + lid.h / 2, shade(MAT.woodDark.front, 0.82), 0.7);
}

function drumGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.drum);
  cylinder(g, cx, cy, radius, MAT.steelDark, LIFT.drum);
  // Rolling hoops.
  g.circle(cx, cy, radius * 0.78).stroke({ color: MAT.steelDark.front, width: 1.1 });
  g.circle(cx, cy, radius * 0.5).stroke({ color: MAT.steelDark.front, width: 0.9 });
  // Bung caps, off-centre the way a real drum head is.
  const bung = radius * 0.5;
  const angle = jitter(o.id, 2) * Math.PI * 2;
  const bx = cx + Math.cos(angle) * bung;
  const by = cy + Math.sin(angle) * bung;
  sitRound(g, bx, by, radius * 0.2, 1.6);
  cylinder(g, bx, by, radius * 0.2, MAT.steel, 1.6);
  g.circle(cx - Math.cos(angle) * bung * 0.7, cy - Math.sin(angle) * bung * 0.7, radius * 0.12)
    .fill({ color: MAT.steelDark.front });
}

// ---------------------------------------------------------------------------
// Plant equipment
// ---------------------------------------------------------------------------

/**
 * A parked counterbalance forklift, loaded. The wide rear counterweight
 * narrowing to a mast and forks is one of the most recognisable overhead
 * silhouettes in any industrial space — and the pallet on the forks keeps the
 * drawn shape honest against the authored collision rect.
 */
function forkliftGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const facing: Facing = o.facing ?? "S";
  const vertical = facing === "N" || facing === "S";
  const along = vertical ? r.h : r.w;
  const across = vertical ? r.w : r.h;
  // Distance from the object's rear edge, in the direction the truck points.
  const flip = facing === "N" || facing === "W";

  const at = (start: number, size: number, aStart = 0, aSize = across): Rect => {
    const s = flip ? along - start - size : start;
    const a = aStart;
    return vertical
      ? { x: r.x + a, y: r.y + s, w: aSize, h: size }
      : { x: r.x + s, y: r.y + a, w: size, h: aSize };
  };

  contact(pad, r, LIFT.machine);

  const bodyLen = along * 0.6;
  const wheel = Math.max(7, across * 0.2);

  // Wheels first: they live under the chassis.
  for (const [s, sz] of [[bodyLen * 0.08, wheel * 1.5], [bodyLen * 0.66, wheel * 1.35]] as const) {
    for (const side of [0, across - wheel] as const) {
      const w = at(s, sz, side, wheel);
      volume(g, w, MAT.rubber, 5, 1.2);
    }
  }

  // Counterweight: the heavy, wide rear end.
  const rear = at(0, bodyLen * 0.42, across * 0.06, across * 0.88);
  const rearTop = volume(g, rear, MAT.paintedDark, LIFT.machine, 2);
  inlay(g, inset(rearTop, 2.2), MAT.paintedDark.front);

  // Operator station.
  const cab = at(bodyLen * 0.4, bodyLen * 0.6, across * 0.04, across * 0.92);
  const cabTop = volume(g, cab, MAT.painted, LIFT.machine, 1.5);
  const seatR: Rect = {
    x: cabTop.x + cabTop.w * 0.24,
    y: cabTop.y + cabTop.h * (flip ? 0.42 : 0.18),
    w: cabTop.w * 0.52,
    h: cabTop.h * 0.4,
  };
  sit(g, seatR, 3);
  volume(g, seatR, MAT.rubber, 3, 2);
  const wheelC = {
    x: cabTop.x + cabTop.w / 2,
    y: cabTop.y + cabTop.h * (flip ? 0.2 : 0.76),
  };
  sitRound(g, wheelC.x, wheelC.y, 3.2, 2.4);
  g.circle(wheelC.x, wheelC.y, 3.2).stroke({ color: MAT.steelDeep.top, width: 1.5 });
  g.circle(wheelC.x, wheelC.y, 1).fill({ color: MAT.steelDeep.front });

  // Overhead guard: four posts and a canopy read as structure above the cab.
  const postSize = 3.4;
  const guard = at(bodyLen * 0.38, bodyLen * 0.64, across * 0.02, across * 0.96);
  for (const [px, py] of [
    [guard.x, guard.y],
    [guard.x + guard.w - postSize, guard.y],
    [guard.x, guard.y + guard.h - postSize],
    [guard.x + guard.w - postSize, guard.y + guard.h - postSize],
  ]) {
    sit(g, { x: px, y: py, w: postSize, h: postSize }, 6);
    volume(g, { x: px, y: py, w: postSize, h: postSize }, MAT.steelDeep, 3);
  }
  g.rect(guard.x + 1, guard.y + 1, guard.w - 2, guard.h - 2)
    .stroke({ color: MAT.steelDark.top, width: 1.1, alpha: 0.55 });

  // Mast, carriage and forks.
  const mast = at(bodyLen, along * 0.06, across * 0.05, across * 0.9);
  contact(pad, mast, 4);
  volume(g, mast, MAT.steelDeep, LIFT.machine + 1);
  const carriage = at(bodyLen + along * 0.06, along * 0.035, across * 0.1, across * 0.8);
  volume(g, carriage, MAT.steelDark, 5);

  const forkStart = bodyLen + along * 0.095;
  const forkLen = along - forkStart;
  const forkW = across * 0.2;
  for (const side of [across * 0.16, across * 0.64]) {
    const fork = at(forkStart, forkLen, side, forkW);
    contact(pad, fork, 2);
    volume(g, fork, MAT.steel, 2);
  }

  // Load on the forks: keeps the silhouette solid across the whole footprint.
  const load = at(forkStart + forkLen * 0.06, forkLen * 0.86, across * 0.08, across * 0.84);
  contact(pad, load, LIFT.low);
  const deck = palletDeck(g, load, `${o.id}:load`, MAT.wood);
  const cargo = inset(deck, 3);
  if (cargo.w > 3 && cargo.h > 3) {
    sit(g, cargo, 4);
    const stack = volume(g, cargo, MAT.fibre, 5);
    seam(g, stack.x + stack.w / 2, stack.y, stack.x + stack.w / 2, stack.y + stack.h, shade(MAT.fibre.front, 0.85), 0.7);
  }
}

// ---------------------------------------------------------------------------
// Workshop
// ---------------------------------------------------------------------------

/** A hung hand tool. Three crude silhouettes carry more than tick marks do. */
function hangTool(g: Graphics, at: Rect, kind: number): void {
  const cx = at.x + at.w / 2;
  if (kind === 0) {
    // Spanner: two ring ends on a shaft.
    inlay(g, { x: cx - 0.7, y: at.y + at.h * 0.2, w: 1.4, h: at.h * 0.6 }, DEEP_SEAM);
    g.circle(cx, at.y + at.h * 0.18, 1.5).stroke({ color: DEEP_SEAM, width: 1 });
    g.circle(cx, at.y + at.h * 0.82, 1.2).stroke({ color: DEEP_SEAM, width: 1 });
    return;
  }
  if (kind === 1) {
    // Mallet: head across a handle.
    inlay(g, { x: cx - 0.6, y: at.y + at.h * 0.3, w: 1.2, h: at.h * 0.7 }, MAT.wood.front);
    inlay(g, { x: cx - at.w * 0.36, y: at.y + at.h * 0.1, w: at.w * 0.72, h: at.h * 0.24 }, DEEP_SEAM);
    return;
  }
  // Driver: bright shaft, dark grip.
  inlay(g, { x: cx - 0.5, y: at.y + at.h * 0.34, w: 1, h: at.h * 0.62 }, MAT.steelLit.top);
  inlay(g, { x: cx - 1.2, y: at.y + at.h * 0.1, w: 2.4, h: at.h * 0.3 }, DEEP_SEAM);
}

/**
 * Fitter's bench: chunky top, tool rail with recognisable tools, a vise
 * straddling the front edge, and work left out on the surface. The vise is the
 * cue that separates a bench from a counter, so it has to be big enough to see.
 */
function workbenchGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const across = r.w >= r.h;
  contact(pad, r, LIFT.bench);
  const top = volume(g, r, MAT.wood, LIFT.bench);

  // Chunky front edge: a bench top is a slab, not a sheet.
  inlay(
    g,
    { x: r.x, y: r.y + r.h - LIFT.bench, w: r.w, h: 1.4 },
    MAT.wood.lit,
  );

  // Back rail with hung tools, on the wall side (opposite the facing).
  const railDepth = Math.max(4.5, (across ? top.h : top.w) * 0.24);
  const facing: Facing = o.facing ?? "S";
  const railAtStart = facing === "S" || facing === "E";
  const rail: Rect = across
    ? { x: top.x, y: railAtStart ? top.y : top.y + top.h - railDepth, w: top.w, h: railDepth }
    : { x: railAtStart ? top.x : top.x + top.w - railDepth, y: top.y, w: railDepth, h: top.h };
  inlay(g, rail, MAT.steelDark.top);
  inlay(g, across ? { ...rail, h: 1 } : { ...rail, w: 1 }, MAT.steelDark.lit);
  const span = across ? rail.w : rail.h;
  const tools = Math.max(2, Math.floor(span / 13));
  for (let i = 0; i < tools; i += 1) {
    const at = (span / tools) * (i + 0.5);
    const slot: Rect = across
      ? { x: rail.x + at - 3, y: rail.y + 0.8, w: 6, h: railDepth - 1.6 }
      : { x: rail.x + 0.8, y: rail.y + at - 3, w: railDepth - 1.6, h: 6 };
    hangTool(g, slot, Math.floor(jitter(o.id, i * 3) * 3) % 3);
  }

  // Bench vise, straddling the front edge the way a real one does.
  const viseLen = Math.min(22, (across ? top.w : top.h) * 0.2);
  const vise: Rect = across
    ? { x: top.x + 3, y: top.y + top.h - viseLen * 0.52, w: viseLen, h: viseLen * 0.62 }
    : { x: top.x + top.w - viseLen * 0.52, y: top.y + 3, w: viseLen * 0.62, h: viseLen };
  sit(g, vise, 5);
  const jaws = volume(g, vise, MAT.steelDeep, 4.5);
  // Two jaws with a gripped gap between them.
  if (across) {
    inlay(g, { x: jaws.x, y: jaws.y, w: jaws.w * 0.4, h: jaws.h }, MAT.steelDark.top);
    inlay(g, { x: jaws.x + jaws.w * 0.56, y: jaws.y, w: jaws.w * 0.44, h: jaws.h }, MAT.steelDark.top);
    inlay(g, { x: jaws.x + jaws.w * 0.4, y: jaws.y + jaws.h * 0.3, w: jaws.w * 0.16, h: jaws.h * 0.4 }, DEEP_SEAM);
    // Screw handle across the jaws.
    inlay(g, { x: jaws.x - 1.5, y: jaws.y + jaws.h * 0.46, w: jaws.w + 3, h: 1.2 }, MAT.steelLit.top);
  } else {
    inlay(g, { x: jaws.x, y: jaws.y, w: jaws.w, h: jaws.h * 0.4 }, MAT.steelDark.top);
    inlay(g, { x: jaws.x, y: jaws.y + jaws.h * 0.56, w: jaws.w, h: jaws.h * 0.44 }, MAT.steelDark.top);
    inlay(g, { x: jaws.x + jaws.w * 0.3, y: jaws.y + jaws.h * 0.4, w: jaws.w * 0.4, h: jaws.h * 0.16 }, DEEP_SEAM);
    inlay(g, { x: jaws.x + jaws.w * 0.46, y: jaws.y - 1.5, w: 1.2, h: jaws.h + 3 }, MAT.steelLit.top);
  }

  // Work in progress: a core under repair, loose plates, and a parts bin.
  const workArea: Rect = across
    ? { x: top.x + viseLen + 8, y: top.y + railDepth + 1.5, w: top.w - viseLen - 14, h: top.h - railDepth - 3 }
    : { x: top.x + railDepth + 1.5, y: top.y + viseLen + 8, w: top.w - railDepth - 3, h: top.h - viseLen - 14 };
  if (workArea.w > 8 && workArea.h > 5) {
    const cr = Math.min(5, Math.min(workArea.w, workArea.h) * 0.44);
    coreDisc(g, workArea.x + cr + 2, workArea.y + workArea.h / 2, cr, 2.4);
    for (let i = 0; i < 2; i += 1) {
      const p: Rect = {
        x: workArea.x + cr * 2 + 7 + i * 8,
        y: workArea.y + workArea.h * 0.28 + jitter(o.id, 50 + i) * workArea.h * 0.3,
        w: 7,
        h: 3.2,
      };
      if (p.x + p.w > workArea.x + workArea.w) continue;
      sit(g, p, 2);
      inlay(g, p, MAT.plateStock.top);
      inlay(g, { ...p, h: 0.7 }, MAT.plateStock.lit);
    }
    // Parts bin at the far end: compartments of small stock.
    const bin: Rect = across
      ? { x: workArea.x + workArea.w - 20, y: workArea.y + 0.5, w: 19, h: workArea.h - 1 }
      : { x: workArea.x + 0.5, y: workArea.y + workArea.h - 20, w: workArea.w - 1, h: 19 };
    if (bin.w > 6 && bin.h > 4) {
      sit(g, bin, 3);
      const tray = volume(g, bin, MAT.steelDark, 3);
      for (let k = 1; k < 3; k += 1) {
        const fx = tray.x + (tray.w / 3) * k;
        seam(g, fx, tray.y + 0.8, fx, tray.y + tray.h - 0.8, MAT.steelDeep.front, 0.7);
      }
      inlay(g, inset(tray, 1.2), MAT.steelDeep.front);
    }
  }
}

/**
 * Roller-drawer chest.
 *
 * Reads as a chest rather than a grey box because of three things: a recessed
 * working tray on the top with a raised lip, *bright* pull handles across the
 * shaded front face, and loose stock lying on the tray. Dark handles on a dark
 * front face are invisible, which is why the first pass read as a plain slab.
 */
function drawerUnitGlyph(mat: Material, drawers: number, liftFor = LIFT.cabinet, tools = false): GlyphFn {
  return (g, pad, o) => {
    const r = rect(o);
    const lift = Math.min(liftFor, Math.min(r.w, r.h) * 0.45);
    contact(pad, r, lift);
    const top = volume(g, r, mat, lift, 1);
    const across = r.w >= r.h;

    // Recessed tray: lip lit on the north edge, floor of the tray darker.
    const tray = inset(top, 2.2);
    if (tray.w > 2 && tray.h > 2) {
      inlay(g, tray, shade(mat.top, 0.86));
      inlay(g, { x: tray.x, y: tray.y, w: tray.w, h: 0.9 }, shade(mat.top, 0.72));
      inlay(g, { x: tray.x, y: tray.y + tray.h - 0.8, w: tray.w, h: 0.8 }, mat.lit);
    }

    // Drawer fronts with bright pulls.
    const front: Rect = { x: r.x, y: r.y + r.h - lift, w: r.w, h: lift };
    const span = across ? front.w : front.h;
    for (let i = 0; i < drawers; i += 1) {
      const at = (span / drawers) * i;
      const cell: Rect = across
        ? { x: front.x + at, y: front.y, w: span / drawers, h: front.h }
        : { x: front.x, y: front.y + at, w: front.w, h: span / drawers };
      if (i > 0) {
        if (across) seam(g, cell.x, cell.y, cell.x, cell.y + cell.h, shade(mat.front, 0.62), 0.9);
        else seam(g, cell.x, cell.y, cell.x + cell.w, cell.y, shade(mat.front, 0.62), 0.9);
      }
      const pull: Rect = across
        ? { x: cell.x + cell.w * 0.22, y: cell.y + cell.h * 0.42, w: cell.w * 0.56, h: Math.max(1.1, cell.h * 0.2) }
        : { x: cell.x + cell.w * 0.42, y: cell.y + cell.h * 0.22, w: Math.max(1.1, cell.w * 0.2), h: cell.h * 0.56 };
      inlay(g, pull, mat.lit);
    }

    // A tool chest is used: leave stock on the tray.
    if (tools && tray.w > 12 && tray.h > 6) {
      const cr = Math.min(3.4, Math.min(tray.w, tray.h) * 0.34);
      coreDisc(g, tray.x + cr + 2, tray.y + tray.h / 2, cr, 1.8);
      const plate: Rect = { x: tray.x + cr * 2 + 6, y: tray.y + tray.h * 0.34, w: tray.w * 0.3, h: 2.6 };
      if (plate.x + plate.w < tray.x + tray.w) {
        sit(g, plate, 1.6);
        inlay(g, plate, MAT.plateStock.top);
        inlay(g, { ...plate, h: 0.7 }, MAT.plateStock.lit);
      }
    }

    for (const cx of [r.x + 1.5, r.x + r.w - 3.5]) {
      inlay(g, { x: cx, y: r.y + r.h - 1.6, w: 2, h: 1.6 }, DEEP_SEAM);
    }
  };
}

/**
 * Locker bank. A single locker top is featureless, so what has to read is the
 * *bank*: one door division per locker width, a bright handle per door, and a
 * louvre stack above each handle.
 */
function lockerGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const lift = Math.min(LIFT.cabinet, Math.min(r.w, r.h) * 0.45);
  contact(pad, r, lift);
  const top = volume(g, r, MAT.painted, lift);

  // Cranked top: lockers are almost always fitted with a sloping dust shed.
  inlay(g, inset(top, 1.4), shade(MAT.painted.top, 0.9));
  inlay(g, { x: top.x + 1.4, y: top.y + 1.4, w: top.w - 2.8, h: 1 }, MAT.painted.lit);

  const front: Rect = { x: r.x, y: r.y + r.h - lift, w: r.w, h: lift };
  const doors = Math.max(1, Math.round(r.w / 26));
  for (let i = 0; i < doors; i += 1) {
    const cell: Rect = { x: front.x + (front.w / doors) * i, y: front.y, w: front.w / doors, h: front.h };
    if (i > 0) seam(g, cell.x, cell.y, cell.x, cell.y + cell.h, shade(MAT.painted.front, 0.58), 1);
    // Louvre stack.
    for (let k = 0; k < 3; k += 1) {
      const y = cell.y + 1.3 + k * 1.7;
      if (y > cell.y + cell.h - 3) break;
      inlay(g, { x: cell.x + cell.w * 0.22, y, w: cell.w * 0.56, h: 0.8 }, shade(MAT.painted.front, 0.56));
    }
    // Latch handle, bright so it survives the shaded face.
    inlay(
      g,
      { x: cell.x + cell.w * 0.62, y: cell.y + cell.h - 2.6, w: cell.w * 0.22, h: 1.6 },
      MAT.painted.lit,
    );
  }
  // Plinth line at the very bottom: lockers stand on a kick rail.
  inlay(g, { x: r.x, y: r.y + r.h - 1.1, w: r.w, h: 1.1 }, shade(MAT.painted.front, 0.5));
}

// ---------------------------------------------------------------------------
// Office
// ---------------------------------------------------------------------------

/**
 * Desk. `facing` is the side the occupant sits on, so the display goes to the
 * opposite edge with the keyboard between them.
 *
 * A monitor seen from directly overhead really is a thin bar, which is why the
 * first pass read as a black lip on the desk edge. What makes it a monitor is
 * the pairing: a bezelled panel at the back plus a stand foot in front of it.
 */
function deskGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const facing: Facing = o.facing ?? "S";
  contact(pad, r, LIFT.bench);
  const top = volume(g, r, MAT.wood, LIFT.bench);
  inlay(g, { x: r.x, y: r.y + r.h - LIFT.bench, w: r.w, h: 1.2 }, MAT.wood.lit);

  const across = r.w >= r.h;
  // Pedestal drawer bank at one end, with real drawer fronts on the top face.
  const pedW = Math.min(26, (across ? top.w : top.h) * 0.3);
  const ped: Rect = across
    ? { x: top.x + top.w - pedW, y: top.y, w: pedW, h: top.h }
    : { x: top.x, y: top.y + top.h - pedW, w: top.w, h: pedW };
  inlay(g, ped, shade(MAT.wood.top, 0.93));
  if (across) {
    seam(g, ped.x, ped.y, ped.x, ped.y + ped.h, shade(MAT.wood.front, 0.74), 1);
    for (let i = 1; i < 3; i += 1) {
      const y = ped.y + (ped.h / 3) * i;
      seam(g, ped.x + 1.5, y, ped.x + ped.w - 1.5, y, shade(MAT.wood.front, 0.82), 0.7);
      inlay(g, { x: ped.x + ped.w * 0.34, y: y - (ped.h / 3) * 0.5 - 0.6, w: ped.w * 0.32, h: 1.2 }, MAT.wood.lit);
    }
  }

  // Display at the back edge, plus its stand.
  const backNorth = facing === "S";
  const panelLong = Math.min(32, (across ? top.w : top.h) * 0.38);
  const panelDeep = 6.5;
  const panel: Rect = across
    ? {
        x: top.x + top.w * 0.1,
        y: backNorth ? top.y + 2 : top.y + top.h - panelDeep - 2,
        w: panelLong,
        h: panelDeep,
      }
    : {
        x: backNorth ? top.x + 2 : top.x + top.w - panelDeep - 2,
        y: top.y + top.h * 0.1,
        w: panelDeep,
        h: panelLong,
      };
  const inward = backNorth ? 1 : -1;
  const foot: Rect = across
    ? { x: panel.x + panelLong * 0.34, y: panel.y + (backNorth ? panelDeep : -5), w: panelLong * 0.32, h: 5 }
    : { x: panel.x + (backNorth ? panelDeep : -5), y: panel.y + panelLong * 0.34, w: 5, h: panelLong * 0.32 };
  sit(g, foot, 3);
  volume(g, foot, MAT.steelDark, 2.5, 1);
  sit(g, panel, 7);
  const screen = volume(g, panel, MAT.steelDeep, 3, 1);
  inlay(g, inset(screen, 1), 0x191d21);
  inlay(g, { x: screen.x + 1, y: screen.y + 0.6, w: screen.w - 2, h: 0.7 }, MAT.steelDark.lit);

  // Keyboard, between the display and the occupant.
  const kb: Rect = across
    ? { x: panel.x + 2, y: panel.y + (inward > 0 ? panelDeep + 8 : -14), w: panelLong - 4, h: 6.5 }
    : { x: panel.x + (inward > 0 ? panelDeep + 8 : -14), y: panel.y + 2, w: 6.5, h: panelLong - 4 };
  if (kb.y > top.y && kb.y + kb.h < top.y + top.h && kb.x > top.x) {
    sit(g, kb, 2);
    inlay(g, kb, MAT.steelLit.top);
    inlay(g, inset(kb, 1), shade(MAT.steelLit.top, 0.86));
  }

  // Paperwork, in the gap between the keyboard and the pedestal.
  const paper: Rect = across
    ? { x: Math.min(ped.x - 17, panel.x + panelLong + 6), y: top.y + top.h * 0.38, w: 15, h: 11 }
    : { x: top.x + top.w * 0.38, y: Math.min(ped.y - 17, panel.y + panelLong + 6), w: 11, h: 15 };
  if (paper.x > top.x + 1 && paper.y > top.y + 1) {
    sit(g, paper, 2);
    inlay(g, paper, 0xfbfbfc);
    for (let i = 0; i < 2; i += 1) {
      inlay(g, { x: paper.x + 2, y: paper.y + 3 + i * 2.4, w: paper.w - 4 - i * 2, h: 0.8 }, MAT.steelDark.top);
    }
  }
}

/**
 * Vegetation as one irregular mass, not a cluster of discs.
 *
 * Overlapping equal-value circles are the worst reading in the kit: from directly
 * above they are indistinguishable from a puff of smoke, which is both wrong and
 * against the rule that nothing in motion is drawn statically. A closed blob with
 * a genuinely dark underside, a mid body and a bright north-west crown reads as a
 * canopy at every zoom, and the notches are what make it leaves rather than a lump.
 */
function foliageMass(g: Graphics, cx: number, cy: number, radius: number, seed: string, spread = 1): void {
  const steps = 20;
  const ring = (scale: number, dx = 0, dy = 0): Vec2[] =>
    Array.from({ length: steps }, (_, i) => {
      const a = (i / steps) * Math.PI * 2;
      const wobble = (0.78 + jitter(seed, i) * 0.34) * scale * spread;
      return { x: cx + dx + Math.cos(a) * radius * wobble, y: cy + dy + Math.sin(a) * radius * wobble };
    });
  const fill = (points: Vec2[], color: number, alpha = 1): void => {
    g.poly(points.map((point) => ({ x: point.x, y: point.y }))).fill({ color, alpha });
  };

  /**
   * A canopy absorbs light, so every step of this ramp stays well below the
   * paving it stands on. The previous version topped out at 0xcfd4d1 against
   * 0xd5d8db footway — indistinguishable — so the middle of each tree dropped out
   * and left a dark ring, which is exactly what "circles that look like smoke"
   * describes.
   */
  const shaded = shade(MAT.foliage.top, 0.46);
  const body = shade(MAT.foliage.top, 0.62);
  const crown = shade(MAT.foliage.top, 0.84);

  // Cast shadow on the ground, thrown south-east.
  fill(ring(1.04, radius * 0.15, radius * 0.19), 0x000000, 0.17);
  fill(ring(1), shaded);
  /**
   * The ramp runs north-west, like every other lit surface in this language. The
   * earlier concentric version — dark rim, light centre — is a dome lit from
   * directly overhead, and nothing else on the map is lit that way, so the trees
   * were the one thing on the sheet with their own private sun.
   */
  fill(ring(0.86, -radius * 0.11, -radius * 0.14), body);
  fill(ring(0.56, -radius * 0.26, -radius * 0.31), crown);

  // Gaps between branch masses, cut in from the rim so the silhouette stays
  // ragged. Without them the crown is a smooth dome.
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + jitter(seed, i + 70) * 1.4;
    const d = radius * (0.55 + jitter(seed, i + 80) * 0.3);
    g.circle(cx + Math.cos(a) * d, cy + Math.sin(a) * d, radius * (0.13 + jitter(seed, i + 90) * 0.1))
      .fill({ color: shade(MAT.foliage.top, 0.38), alpha: 0.7 });
  }
}

function plantGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const radius = Math.min(o.w, o.h) / 2 - 0.5;
  contactRound(pad, cx, cy, radius, LIFT.bench);

  // Pot first, so the plant reads as planted rather than as loose foliage.
  cylinder(g, cx, cy, radius, MAT.fibre, 5);
  g.circle(cx, cy, radius).stroke({ color: MAT.fibre.edge, width: 1.1 });
  g.circle(cx, cy, radius * 0.74).stroke({ color: shade(MAT.fibre.front, 0.8), width: 0.9 });

  foliageMass(g, cx, cy - radius * 0.06, radius * 0.72, o.id);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

function columnGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  // Columns run floor to deck: the longest shadow on the floor.
  contact(pad, r, LIFT.column);
  const top = volume(g, { x: r.x, y: r.y, w: r.w, h: r.h }, { top: V.wallCap, front: V.wall, edge: 0x0d1013, lit: 0x4a4f55 }, LIFT.column);
  inlay(g, inset(top, 1.8), shade(V.wallCap, 1.18));
  // Base plate, drawn inside the collider. Nothing that looks solid may sit
  // outside the authored rect — only shadow may.
  inlay(g, { x: r.x, y: r.y + r.h - 2, w: r.w, h: 2 }, shade(V.wallCap, 0.72));
}

function generatorGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.machine);
  const top = volume(g, r, MAT.paintedDark, LIFT.machine, 1.5);
  const across = r.w >= r.h;
  // Radiator grille at one end, engine block housing at the other.
  const grille: Rect = across
    ? { x: top.x + 1.5, y: top.y + 1.5, w: top.w * 0.28, h: top.h - 3 }
    : { x: top.x + 1.5, y: top.y + 1.5, w: top.w - 3, h: top.h * 0.28 };
  inlay(g, grille, MAT.steelDeep.front);
  const fins = Math.floor((across ? grille.h : grille.w) / 2.4);
  for (let i = 1; i < fins; i += 1) {
    const at = ((across ? grille.h : grille.w) / fins) * i;
    if (across) inlay(g, { x: grille.x, y: grille.y + at, w: grille.w, h: 0.9 }, MAT.steelDark.top);
    else inlay(g, { x: grille.x + at, y: grille.y, w: 0.9, h: grille.h }, MAT.steelDark.top);
  }
  const block: Rect = across
    ? { x: grille.x + grille.w + 2, y: top.y + 2.5, w: top.w * 0.5, h: top.h - 5 }
    : { x: top.x + 2.5, y: grille.y + grille.h + 2, w: top.w - 5, h: top.h * 0.5 };
  sit(g, block, 3);
  volume(g, block, MAT.steelDark, 3, 1);
  // Exhaust stack.
  const sx = across ? top.x + top.w - 6 : top.x + top.w / 2;
  const sy = across ? top.y + top.h / 2 : top.y + top.h - 6;
  sitRound(g, sx, sy, 3, 5);
  cylinder(g, sx, sy, 3, MAT.steelDeep, 4);
  g.circle(sx, sy, 1.5).fill({ color: 0x14171a });
}

function utilityBoxGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.steelDark, LIFT.cabinet, 1);
  inlay(g, inset(top, 1.6), shade(MAT.steelDark.top, 0.92));
  seam(g, top.x + top.w / 2, top.y + 1.6, top.x + top.w / 2, top.y + top.h - 1.6, MAT.steelDark.front, 0.8);
  const front: Rect = { x: r.x, y: r.y + r.h - LIFT.cabinet, w: r.w, h: LIFT.cabinet };
  inlay(g, { x: front.x + front.w * 0.44, y: front.y + front.h * 0.35, w: 2, h: front.h * 0.35 }, DEEP_SEAM);
}

function ventGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.flat);
  const top = volume(g, r, MAT.steelDark, LIFT.flat);
  const louvres = Math.max(3, Math.floor(top.h / 3));
  for (let i = 0; i < louvres; i += 1) {
    const y = top.y + 1.2 + (i * (top.h - 2.4)) / louvres;
    inlay(g, { x: top.x + 1.4, y, w: top.w - 2.8, h: 1.2 }, MAT.steelDeep.front);
  }
}

// ---------------------------------------------------------------------------
// Street
// ---------------------------------------------------------------------------

/**
 * A street tree. The canopy is built outer-dark to inner-light with a value ramp
 * driven by each lobe's height, so the mass has a top instead of reading as a
 * ring of bubbles — and it is the only soft silhouette on a street full of boxes.
 */
function treeGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const radius = Math.min(o.w, o.h) / 2;
  contactRound(pad, cx, cy, radius * 0.88, LIFT.column + 4);

  // Trunk, visible where the canopy thins. A crown with no trunk floats.
  cylinder(g, cx, cy + radius * 0.06, Math.max(2.2, radius * 0.13), MAT.woodDark, 3);

  foliageMass(g, cx, cy, radius * 0.96, o.id);
}

/**
 * A car. Bonnet, cabin and boot along the long axis, dark glass at both ends of
 * the cabin, and wheels peeking at the flanks — the overhead silhouette everyone
 * already knows, which is why it needs no label.
 */
function carGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const along = longAxis(o) === "v" ? "v" : "h";
  const vertical = along === "v";
  const length = vertical ? r.h : r.w;
  const width = vertical ? r.w : r.h;
  const facing: Facing = o.facing ?? (vertical ? "S" : "E");
  const flip = facing === "N" || facing === "W";

  const band = (start: number, size: number, insetSide = 0): Rect => {
    const s = flip ? length - start - size : start;
    return vertical
      ? { x: r.x + insetSide, y: r.y + s, w: width - insetSide * 2, h: size }
      : { x: r.x + s, y: r.y + insetSide, w: size, h: width - insetSide * 2 };
  };

  contact(pad, r, LIFT.machine);

  // Wheels first: they sit under the body and show at the flanks.
  const wheelLen = length * 0.16;
  const wheelW = Math.max(4, width * 0.11);
  for (const start of [length * 0.14, length * 0.68]) {
    for (const side of [0, width - wheelW]) {
      const wheel = vertical
        ? { x: r.x + side, y: r.y + start, w: wheelW, h: wheelLen }
        : { x: r.x + start, y: r.y + side, w: wheelLen, h: wheelW };
      volume(g, wheel, MAT.rubber, 3, 1.2);
    }
  }

  // Body shell.
  const shell = band(0, length, width * 0.06);
  const top = volume(g, shell, MAT.painted, LIFT.machine, Math.min(width, length) * 0.22);

  // Bonnet and boot panels, slightly darker than the roof.
  const panel = shade(MAT.painted.top, 0.94);
  inlay(g, band(length * 0.03, length * 0.24, width * 0.13), panel);
  inlay(g, band(length * 0.79, length * 0.18, width * 0.13), panel);

  // Glass: windscreen, rear window, and a side strip down the cabin.
  const glass = 0x2c3239;
  inlay(g, band(length * 0.28, length * 0.1, width * 0.11), glass);
  inlay(g, band(length * 0.69, length * 0.08, width * 0.12), glass);
  const cabin = band(length * 0.38, length * 0.31, width * 0.08);
  inlay(g, cabin, shade(MAT.painted.top, 1.06));
  for (const side of [0, 1]) {
    inlay(
      g,
      vertical
        ? { x: cabin.x + (side ? cabin.w - 2.6 : 0), y: cabin.y, w: 2.6, h: cabin.h }
        : { x: cabin.x, y: cabin.y + (side ? cabin.h - 2.6 : 0), w: cabin.w, h: 2.6 },
      glass,
    );
  }
  /**
   * Roof highlight on the cabin's **north** edge, whichever way the car points.
   * Keying it to the car's own axis put a bright stripe straight across the body
   * of every east-west car, which read as paint rather than as light.
   */
  inlay(g, { x: cabin.x, y: cabin.y, w: cabin.w, h: 1 }, MAT.painted.lit);

  // Lamps at the leading end.
  const lampLen = Math.max(2.4, length * 0.025);
  for (const off of [width * 0.16, width * 0.62]) {
    const lamp = vertical
      ? { x: r.x + off, y: flip ? r.y + length - lampLen - 1 : r.y + 1, w: width * 0.22, h: lampLen }
      : { x: flip ? r.x + length - lampLen - 1 : r.x + 1, y: r.y + off, w: lampLen, h: width * 0.22 };
    inlay(g, lamp, MAT.steelLit.top);
  }
  void top;
}

function lampPostGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const base = Math.min(o.w, o.h) / 2;
  contactRound(pad, cx, cy, base * 0.6, LIFT.column + 6);
  // Base flange, mast, then the luminaire head offset toward the light.
  cylinder(g, cx, cy, base * 0.9, MAT.steelDeep, 3);
  cylinder(g, cx, cy, base * 0.42, MAT.steelDark, 4);
  sitRound(g, cx - base * 0.5, cy - base * 0.6, base * 0.5, 5);
  g.ellipse(cx - base * 0.5, cy - base * 0.6, base * 0.62, base * 0.44).fill({ color: MAT.steelLit.top });
  g.ellipse(cx - base * 0.5, cy - base * 0.6, base * 0.62, base * 0.44).stroke({ color: MAT.steelDeep.top, width: 0.9 });
}

function benchGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const across = r.w >= r.h;
  const facing: Facing = o.facing ?? "S";
  contact(pad, r, LIFT.seat);
  const top = volume(g, r, MAT.wood, LIFT.seat);

  // Slatted seat.
  const span = across ? top.h : top.w;
  const slats = Math.max(3, Math.round(span / 5));
  for (let i = 1; i < slats; i += 1) {
    const at = (span / slats) * i;
    if (across) inlay(g, { x: top.x + 1, y: top.y + at - 0.5, w: top.w - 2, h: 1.1 }, shade(MAT.wood.front, 0.75));
    else inlay(g, { x: top.x + at - 0.5, y: top.y + 1, w: 1.1, h: top.h - 2 }, shade(MAT.wood.front, 0.75));
  }
  // Back rail opposite the facing side.
  const railDepth = Math.max(2.5, span * 0.26);
  const backAtStart = facing === "S" || facing === "E";
  const rail: Rect = across
    ? { x: top.x, y: backAtStart ? top.y : top.y + top.h - railDepth, w: top.w, h: railDepth }
    : { x: backAtStart ? top.x : top.x + top.w - railDepth, y: top.y, w: railDepth, h: top.h };
  inlay(g, rail, MAT.woodDark.top);
  inlay(g, across ? { ...rail, h: 0.9 } : { ...rail, w: 0.9 }, MAT.wood.lit);
  // Cast-iron end frames.
  for (const end of [0, 1]) {
    const frame: Rect = across
      ? { x: end ? r.x + r.w - 3 : r.x, y: r.y, w: 3, h: r.h }
      : { x: r.x, y: end ? r.y + r.h - 3 : r.y, w: r.w, h: 3 };
    inlay(g, frame, MAT.steelDeep.top);
  }
}

function planterGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.bench);
  const top = volume(g, r, MAT.steelDark, LIFT.bench, 2);
  const soil = inset(top, 2.6);
  if (soil.w <= 1 || soil.h <= 1) return;
  inlay(g, soil, shade(MAT.foliage.front, 0.62));

  /**
   * Planting drawn as a continuous run along the bed rather than as separate
   * shrubs. Discrete blobs in a raised bed are exactly what read as smoke on the
   * Beacon and Civic roofs.
   */
  const across = soil.w >= soil.h;
  const thickness = Math.min(soil.w, soil.h);
  const run = across ? soil.w : soil.h;
  const clumps = Math.max(1, Math.round(run / (thickness * 0.72)));
  for (let i = 0; i < clumps; i += 1) {
    const t = clumps === 1 ? 0.5 : (i + 0.5) / clumps;
    foliageMass(
      g,
      across ? soil.x + soil.w * t : soil.x + soil.w / 2,
      across ? soil.y + soil.h / 2 : soil.y + soil.h * t,
      thickness * 0.5,
      `${o.id}-${i}`,
      0.96,
    );
  }
}

function hydrantGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const radius = Math.min(o.w, o.h) / 2;
  contactRound(pad, cx, cy, radius * 0.8, LIFT.drum);
  cylinder(g, cx, cy, radius * 0.78, MAT.steelDark, 5);
  // Side nozzles and the bonnet cap.
  for (const dx of [-1, 1]) {
    inlay(g, { x: cx + dx * radius * 0.78 - (dx > 0 ? 0 : radius * 0.3), y: cy - 1.3, w: radius * 0.3, h: 2.6 }, MAT.steelDeep.top);
  }
  cylinder(g, cx, cy, radius * 0.34, MAT.steelLit, 2);
}

function bollardGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const radius = Math.min(o.w, o.h) / 2;
  contactRound(pad, cx, cy, radius * 0.7, LIFT.column);
  cylinder(g, cx, cy, radius * 0.7, MAT.steelDeep, 6);
  // Reflective band, the one detail that makes a bollard read at play zoom.
  g.circle(cx, cy, radius * 0.44).stroke({ color: MAT.steelLit.top, width: 1.6 });
}

function bikeRackGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const across = r.w >= r.h;
  const span = across ? r.w : r.h;
  const hoops = Math.max(2, Math.round(span / 30));
  for (let i = 0; i < hoops; i += 1) {
    const at = (span / hoops) * (i + 0.5);
    const hoop: Rect = across
      ? { x: r.x + at - 2, y: r.y + 1, w: 4, h: r.h - 2 }
      : { x: r.x + 1, y: r.y + at - 2, w: r.w - 2, h: 4 };
    contact(pad, hoop, LIFT.bench);
    volume(g, hoop, MAT.steelDark, 4, 1.6);
  }
  // Ground rail joining the hoop feet.
  inlay(
    g,
    across ? { x: r.x, y: r.y + r.h - 2, w: r.w, h: 2 } : { x: r.x + r.w - 2, y: r.y, w: 2, h: r.h },
    MAT.steelDeep.front,
  );
}

function dumpsterGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.paintedDark, LIFT.cabinet, 1.5);
  const across = r.w >= r.h;
  // Two lids meeting on the centre line.
  inlay(g, inset(top, 2), shade(MAT.paintedDark.top, 1.08));
  if (across) seam(g, top.x + top.w / 2, top.y + 2, top.x + top.w / 2, top.y + top.h - 2, DEEP_SEAM, 1.1);
  else seam(g, top.x + 2, top.y + top.h / 2, top.x + top.w - 2, top.y + top.h / 2, DEEP_SEAM, 1.1);
  // Lid grab bars.
  for (const f of [0.28, 0.72]) {
    inlay(
      g,
      across
        ? { x: top.x + top.w * f - 5, y: top.y + top.h * 0.42, w: 10, h: 1.6 }
        : { x: top.x + top.w * 0.42, y: top.y + top.h * f - 5, w: 1.6, h: 10 },
      MAT.steelLit.top,
    );
  }
  // Castors at the corners.
  for (const cx of [r.x + 2, r.x + r.w - 5]) {
    inlay(g, { x: cx, y: r.y + r.h - 2, w: 3, h: 2 }, DEEP_SEAM);
  }
}

/** Paint only: a stall is a mark on the ground, never an obstacle. */
function parkingStallGlyph(g: Graphics, _pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  const across = r.w >= r.h;
  const bays = Math.max(1, Math.round((across ? r.w : r.h) / 60));
  const paint = 0xf1f3f4;
  for (let i = 0; i <= bays; i += 1) {
    const at = ((across ? r.w : r.h) / bays) * i;
    inlay(
      g,
      across ? { x: r.x + at - 1.5, y: r.y, w: 3, h: r.h } : { x: r.x, y: r.y + at - 1.5, w: r.w, h: 3 },
      paint,
    );
  }
  inlay(g, across ? { x: r.x, y: r.y, w: r.w, h: 3 } : { x: r.x, y: r.y, w: 3, h: r.h }, paint);
}

function kioskGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.wall);
  const top = volume(g, r, MAT.painted, Math.min(LIFT.wall, Math.min(r.w, r.h) * 0.4), 2);
  inlay(g, inset(top, 3), shade(MAT.painted.top, 0.9));
  // Service counter on the facing side.
  const facing: Facing = o.facing ?? "S";
  const depth = 4;
  const counter: Rect = facing === "N"
    ? { x: top.x + 3, y: top.y, w: top.w - 6, h: depth }
    : facing === "S"
      ? { x: top.x + 3, y: top.y + top.h - depth, w: top.w - 6, h: depth }
      : facing === "W"
        ? { x: top.x, y: top.y + 3, w: depth, h: top.h - 6 }
        : { x: top.x + top.w - depth, y: top.y + 3, w: depth, h: top.h - 6 };
  inlay(g, counter, MAT.steelLit.top);
}

/** Rooftop plant: a housed unit with a fan grille. */
function hvacGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.steelDark, LIFT.cabinet, 1.5);
  const across = r.w >= r.h;
  // Fan cowl on one half, coil bank on the other.
  const fan = across
    ? { x: top.x + 2, y: top.y + 2, w: top.w * 0.44, h: top.h - 4 }
    : { x: top.x + 2, y: top.y + 2, w: top.w - 4, h: top.h * 0.44 };
  const cr = Math.min(fan.w, fan.h) / 2 - 0.5;
  inlay(g, fan, MAT.steelDeep.front);
  const fcx = fan.x + fan.w / 2;
  const fcy = fan.y + fan.h / 2;
  g.circle(fcx, fcy, cr).fill({ color: MAT.steelDeep.top });
  /**
   * A stationary guard grille, not fan blades.
   *
   * Nothing that is actually in motion may be drawn as a static mark: frozen
   * blades read as a swirl or a puff of smoke, and they promise animation the
   * renderer never delivers. The grille is the part that genuinely does not
   * move, and it reads better at play zoom besides.
   */
  for (const ring of [0.86, 0.58, 0.3]) {
    g.circle(fcx, fcy, cr * ring).stroke({ color: MAT.steelDark.top, width: 1, alpha: 0.85 });
  }
  for (const along of [-1, 1]) {
    g.moveTo(fcx - cr * 0.86, fcy + along * cr * 0.34)
      .lineTo(fcx + cr * 0.86, fcy + along * cr * 0.34)
      .stroke({ color: MAT.steelDark.top, width: 0.9, alpha: 0.7 });
  }
  g.circle(fcx, fcy, cr * 0.18).fill({ color: DEEP_SEAM });
  const coil = across
    ? { x: fan.x + fan.w + 3, y: top.y + 2, w: top.w - fan.w - 7, h: top.h - 4 }
    : { x: top.x + 2, y: fan.y + fan.h + 3, w: top.w - 4, h: top.h - fan.h - 7 };
  if (coil.w > 2 && coil.h > 2) {
    inlay(g, coil, MAT.steelDeep.front);
    const fins = Math.floor((across ? coil.w : coil.h) / 2.6);
    for (let i = 1; i < fins; i += 1) {
      const at = ((across ? coil.w : coil.h) / fins) * i;
      inlay(
        g,
        across ? { x: coil.x + at, y: coil.y, w: 0.9, h: coil.h } : { x: coil.x, y: coil.y + at, w: coil.w, h: 0.9 },
        MAT.steelDark.top,
      );
    }
  }
}

/** Roof glazing: bright, framed, and clearly a hole in the deck. */
function skylightGlyph(g: Graphics, pad: ShadowPad, o: MapObject): void {
  const r = rect(o);
  contact(pad, r, LIFT.seat);
  const top = volume(g, r, MAT.steelDark, LIFT.seat, 1);
  const glass = inset(top, 3);
  if (glass.w <= 2 || glass.h <= 2) return;
  inlay(g, glass, V.glass);
  const across = glass.w >= glass.h;
  const lights = Math.max(2, Math.round((across ? glass.w : glass.h) / 22));
  for (let i = 1; i < lights; i += 1) {
    const at = ((across ? glass.w : glass.h) / lights) * i;
    inlay(
      g,
      across ? { x: glass.x + at, y: glass.y, w: 1.4, h: glass.h } : { x: glass.x, y: glass.y + at, w: glass.w, h: 1.4 },
      V.glassFrame,
    );
  }
  inlay(g, { x: glass.x, y: glass.y, w: glass.w, h: 1.2 }, 0xffffff);
}

// ---------------------------------------------------------------------------
// The player base
// ---------------------------------------------------------------------------

/**
 * Every base fixture materializes into a placement slot, so they all arrive as
 * the same two rectangles: roughly 86x38 against a wall, or 108x72 on the floor,
 * in either orientation. Silhouette cannot do the identifying work here the way
 * it does for a rack or a forklift.
 *
 * So these glyphs distinguish themselves on the top face, and they distinguish
 * by *one* strong cue each, placed where the eye lands: the bright build plate of
 * a fabricator, the pillow of a bunk, the two arms of a couch, the lit board
 * edges of a rack. A second cue is detail; it is never the identification.
 *
 * They also fill their slot rather than sitting daintily inside it, because the
 * slot is the collider. A small mast drawn inside an 86x38 box would be a
 * silhouette that lies about what stops a bot.
 */

/** The long-axis-aware slot geometry every base glyph starts from. */
function bay(o: MapObject): {
  r: Rect;
  across: boolean;
  /** True when the presented face is the north/west one. */
  farSide: boolean;
} {
  const facing: Facing = o.facing ?? "S";
  return { r: rect(o), across: o.w >= o.h, farSide: facing === "S" || facing === "E" };
}

/** A band along one end of the long axis, at `depth`, measured from the head end. */
function endBand(r: Rect, across: boolean, atStart: boolean, depth: number): Rect {
  if (across) {
    return { x: atStart ? r.x : r.x + r.w - depth, y: r.y, w: depth, h: r.h };
  }
  return { x: r.x, y: atStart ? r.y : r.y + r.h - depth, w: r.w, h: depth };
}

/** A band along one side of the long axis (the back rail, the tool trough). */
function sideBand(r: Rect, across: boolean, atStart: boolean, depth: number): Rect {
  if (across) {
    return { x: r.x, y: atStart ? r.y : r.y + r.h - depth, w: r.w, h: depth };
  }
  return { x: atStart ? r.x : r.x + r.w - depth, y: r.y, w: depth, h: r.h };
}

/**
 * A bunk. The pillow at the head end is the whole glyph — a mattress without one
 * is a table — so it takes real area and the brightest value on the object.
 */
function bunkGlyph(mat: Material, lift: number, thin: boolean): GlyphFn {
  return (g, pad, o) => {
    const { r, across, farSide } = bay(o);
    contact(pad, r, lift);
    const top = volume(g, r, mat, lift, 1.5);

    // Mattress, inset so the frame reads as a frame on all four sides.
    const bed = inset(top, thin ? 1.6 : 2.4);
    inlay(g, bed, shade(MAT.fibre.top, thin ? 0.99 : 1.03), 1.5);

    // Pillow at the head: the end away from the side the occupant steps in from.
    const head = endBand(bed, across, !farSide, (across ? bed.w : bed.h) * 0.26);
    sit(g, head, 2);
    inlay(g, head, MAT.fibre.lit, 1.5);
    seam(
      g,
      across ? head.x + head.w : head.x,
      across ? head.y : head.y + head.h,
      across ? head.x + head.w : head.x + head.w,
      across ? head.y + head.h : head.y + head.h,
      shade(MAT.fibre.front, 0.86),
      0.9,
    );

    // Turned sheet: one bright fold across the mattress a third of the way down.
    const fold = across
      ? { x: bed.x + bed.w * (farSide ? 0.34 : 0.62), y: bed.y, w: 2.2, h: bed.h }
      : { x: bed.x, y: bed.y + bed.h * (farSide ? 0.34 : 0.62), w: bed.w, h: 2.2 };
    inlay(g, fold, MAT.fibre.lit);

    if (thin) {
      // A cot is canvas on a folding frame: the rails show through at both ends.
      for (const atStart of [true, false]) {
        const rail = endBand(top, across, atStart, 2);
        inlay(g, rail, MAT.steelDark.top);
      }
    }
  };
}

/**
 * A couch reads by its arms. Two thick blocks at the ends plus a back rail on
 * the far side leave a seat pad that is obviously for sitting in, at a size where
 * a bed would just be a big flat pad.
 */
const couchGlyph: GlyphFn = (g, pad, o) => {
  const { r, across, farSide } = bay(o);
  contact(pad, r, LIFT.seat);
  const top = volume(g, r, MAT.painted, LIFT.seat, 2);

  const backDepth = Math.max(5, (across ? top.h : top.w) * 0.3);
  const armDepth = Math.max(5, (across ? top.w : top.h) * 0.13);

  // Seat pad first, so the arms and back overlap it and read as standing proud.
  const seatPad = across
    ? {
        x: top.x + armDepth,
        y: farSide ? top.y + backDepth : top.y,
        w: top.w - armDepth * 2,
        h: top.h - backDepth,
      }
    : {
        x: farSide ? top.x + backDepth : top.x,
        y: top.y + armDepth,
        w: top.w - backDepth,
        h: top.h - armDepth * 2,
      };
  inlay(g, seatPad, shade(MAT.fibre.top, 0.99), 1.5);
  // One cushion division, so the pad is upholstery rather than a slab.
  const half = across
    ? { x: seatPad.x + seatPad.w / 2 - 0.5, y: seatPad.y, w: 1, h: seatPad.h }
    : { x: seatPad.x, y: seatPad.y + seatPad.h / 2 - 0.5, w: seatPad.w, h: 1 };
  inlay(g, half, shade(MAT.fibre.front, 0.9));

  const back = sideBand(top, across, farSide, backDepth);
  inlay(g, back, MAT.painted.top, 1.5);
  inlay(g, across ? { ...back, h: 1.1 } : { ...back, w: 1.1 }, MAT.painted.lit);
  for (const atStart of [true, false]) {
    const arm = endBand(top, across, atStart, armDepth);
    inlay(g, arm, shade(MAT.painted.top, 1.04), 1.5);
    inlay(g, across ? { ...arm, h: 1 } : { ...arm, w: 1 }, MAT.painted.lit);
  }
};

/**
 * A conference table: one large uninterrupted top. What names it is the service
 * spine — a cable channel with power grommets down the centreline — because that
 * is the only thing a big empty top can carry that a big empty desk cannot.
 */
const conferenceTableGlyph: GlyphFn = (g, pad, o) => {
  const { r, across } = bay(o);
  contact(pad, r, LIFT.bench);
  const top = volume(g, r, MAT.wood, LIFT.bench, 3);
  inlay(g, { x: r.x, y: r.y + r.h - LIFT.bench, w: r.w, h: 1.3 }, MAT.wood.lit);

  const spineDepth = Math.max(5, (across ? top.h : top.w) * 0.2);
  const spine = across
    ? { x: top.x + top.w * 0.08, y: top.y + (top.h - spineDepth) / 2, w: top.w * 0.84, h: spineDepth }
    : { x: top.x + (top.w - spineDepth) / 2, y: top.y + top.h * 0.08, w: spineDepth, h: top.h * 0.84 };
  inlay(g, spine, shade(MAT.wood.top, 0.93), 1);
  const span = across ? spine.w : spine.h;
  const ports = Math.max(2, Math.floor(span / 26));
  for (let i = 0; i < ports; i += 1) {
    const at = (span / ports) * (i + 0.5);
    const cx = across ? spine.x + at : spine.x + spine.w / 2;
    const cy = across ? spine.y + spine.h / 2 : spine.y + at;
    g.circle(cx, cy, spineDepth * 0.26).fill({ color: DEEP_SEAM });
    g.circle(cx, cy, spineDepth * 0.26).stroke({ color: MAT.steelDark.lit, width: 0.7 });
  }
};

/**
 * The planning table. Its collision is only the inset tabletop — a bot walks the
 * chair gutter around it — so the glyph must draw that gutter as open floor.
 * Filling the slot here would be the one case where honesty runs the other way.
 */
const planningTableGlyph: GlyphFn = (g, pad, o) => {
  const slot = rect(o);
  const chair = Math.min(30, Math.max(26, Math.min(slot.h * 0.4, slot.w * 0.26)));
  const surface: Rect = {
    x: slot.x + chair * 0.52,
    y: slot.y + chair * 0.48,
    w: slot.w - chair * 1.04,
    h: slot.h - chair * 0.96,
  };
  const across = surface.w >= surface.h;

  contact(pad, surface, LIFT.bench);
  const top = volume(g, surface, MAT.steelDark, LIFT.bench, 2);

  // A backlit plan surface: the brightest thing in the room, which is what makes
  // this the table you walk to.
  const glass = inset(top, 2.2);
  inlay(g, glass, V.glass, 1);
  inlay(g, inset(glass, 1.6), shade(V.glass, 1.02), 1);
  // Plan graticule, kept to two lines each way so it reads as a drawing surface
  // rather than as a grid pattern.
  for (let i = 1; i < 3; i += 1) {
    seam(g, glass.x + (glass.w / 3) * i, glass.y + 1, glass.x + (glass.w / 3) * i, glass.y + glass.h - 1, shade(V.glass, 0.9));
    seam(g, glass.x + 1, glass.y + (glass.h / 3) * i, glass.x + glass.w - 1, glass.y + (glass.h / 3) * i, shade(V.glass, 0.9));
  }
  // Bezel rail along the long side, where the controls live.
  const rail = sideBand(top, across, true, 2);
  inlay(g, rail, MAT.steelDeep.top);
  inlay(g, across ? { ...rail, h: 0.9 } : { ...rail, w: 0.9 }, MAT.steelDark.lit);
};

/**
 * A drafting board: a tilted surface. The tilt is carried by a value ramp up the
 * board plus a bright leading lip at the low edge, which is the only honest way to
 * show a slope in a plan view — a flat top with a line on it reads as a table.
 */
const draftingTableGlyph: GlyphFn = (g, pad, o) => {
  const { r, across, farSide } = bay(o);
  contact(pad, r, LIFT.bench);
  const top = volume(g, r, MAT.steelDark, LIFT.bench, 1.5);

  // Tool trough along the low edge, the side the draughtsman stands at.
  const troughDepth = Math.max(4, (across ? top.h : top.w) * 0.16);
  const trough = sideBand(top, across, !farSide, troughDepth);
  const board = across
    ? { x: top.x, y: farSide ? top.y : top.y + troughDepth, w: top.w, h: top.h - troughDepth }
    : { x: farSide ? top.x : top.x + troughDepth, y: top.y, w: top.w - troughDepth, h: top.h };

  // The ramp: five bands from the high (far) edge to the low edge.
  const steps = 5;
  for (let i = 0; i < steps; i += 1) {
    // Brightest at the high edge — it faces the light most directly.
    const k = 1.06 - (i / (steps - 1)) * 0.16;
    const t = farSide ? i : steps - 1 - i;
    const slice = across
      ? { x: board.x, y: board.y + (board.h / steps) * t, w: board.w, h: board.h / steps + 0.5 }
      : { x: board.x + (board.w / steps) * t, y: board.y, w: board.w / steps + 0.5, h: board.h };
    inlay(g, slice, shade(MAT.fibre.top, k));
  }
  // Leading lip at the low edge of the board: the sheet's own thickness.
  const lip = sideBand(board, across, !farSide, 1.2);
  inlay(g, lip, MAT.fibre.lit);

  inlay(g, trough, MAT.steelDeep.top);
  const span = across ? trough.w : trough.h;
  for (let i = 0; i < 3; i += 1) {
    const at = span * (0.22 + i * 0.26);
    const pen = across
      ? { x: trough.x + at, y: trough.y + troughDepth * 0.3, w: 9, h: 1.4 }
      : { x: trough.x + troughDepth * 0.3, y: trough.y + at, w: 1.4, h: 9 };
    inlay(g, pen, i === 1 ? MAT.core.lit : MAT.steelLit.top);
  }
};

/**
 * A repair bench. Deliberately the fitter's bench with its stock swapped: a parts
 * tray of salvaged plates where the workbench has raw work. Same silhouette, same
 * vise, because they are the same object doing a different job — inventing a
 * distinct outline for it would be a lie about the furniture.
 */
const repairBenchGlyph: GlyphFn = (g, pad, o) => {
  workbenchGlyph(g, pad, o);
  const { r, across, farSide } = bay(o);
  const top: Rect = { x: r.x, y: r.y, w: r.w, h: Math.max(1, r.h - Math.min(LIFT.bench, Math.min(r.w, r.h) * 0.45)) };

  // Parts tray on the working half, opposite the vise end.
  const trayLong = Math.min(30, (across ? top.w : top.h) * 0.32);
  const trayDeep = Math.min(16, (across ? top.h : top.w) * 0.42);
  const tray: Rect = across
    ? {
        x: farSide ? top.x + top.w - trayLong - 4 : top.x + 4,
        y: top.y + top.h - trayDeep - 2,
        w: trayLong,
        h: trayDeep,
      }
    : {
        x: top.x + top.w - trayDeep - 2,
        y: farSide ? top.y + top.h - trayLong - 4 : top.y + 4,
        w: trayDeep,
        h: trayLong,
      };
  sit(g, tray, 3);
  const pan = volume(g, tray, MAT.steelDeep, 3, 1);
  inlay(g, inset(pan, 1), shade(MAT.steelDeep.top, 0.86), 1);
  // Salvaged plates, stacked loose.
  for (let i = 0; i < 3; i += 1) {
    const jx = jitterSigned(o.id, 40 + i) * 1.6;
    const plate = across
      ? { x: pan.x + 2 + i * ((pan.w - 4) / 3) + jx, y: pan.y + 1.8, w: (pan.w - 4) / 3 - 1.4, h: pan.h - 3.6 }
      : { x: pan.x + 1.8, y: pan.y + 2 + i * ((pan.h - 4) / 3) + jx, w: pan.w - 3.6, h: (pan.h - 4) / 3 - 1.4 };
    inlay(g, plate, MAT.plateStock.top);
    inlay(g, across ? { ...plate, h: 0.8 } : { ...plate, w: 0.8 }, MAT.plateStock.lit);
  }
};

/**
 * A cold cabinet. The door seam plus a full-height handle is the cue: it is the
 * only base fixture whose entire top face is one blank panel with a vertical
 * break, and the vent grille at the base confirms it.
 */
const fridgeGlyph: GlyphFn = (g, pad, o) => {
  const { r, across } = bay(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.steelLit, LIFT.cabinet, 1);
  inlay(g, inset(top, 1.4), shade(MAT.steelLit.top, 0.97), 1);

  // Door break slightly off centre — a fridge/freezer pair, not a symmetrical box.
  const at = 0.58;
  if (across) {
    seam(g, top.x + top.w * at, top.y + 1, top.x + top.w * at, top.y + top.h - 1, shade(MAT.steelLit.front, 0.7), 1.2);
  } else {
    seam(g, top.x + 1, top.y + top.h * at, top.x + top.w - 1, top.y + top.h * at, shade(MAT.steelLit.front, 0.7), 1.2);
  }
  // Handles: two bright bars flanking the seam.
  for (const side of [-1, 1]) {
    const handle = across
      ? { x: top.x + top.w * at + side * 4 - (side > 0 ? 0 : 2.2), y: top.y + top.h * 0.2, w: 2.2, h: top.h * 0.6 }
      : { x: top.x + top.w * 0.2, y: top.y + top.h * at + side * 4 - (side > 0 ? 0 : 2.2), w: top.w * 0.6, h: 2.2 };
    sit(g, handle, 2);
    inlay(g, handle, MAT.steelLit.lit, 1);
  }
  // Condenser grille on the front face — the one detail allowed down there,
  // because it is what tells you which way the appliance is plumbed.
  const lift = Math.min(LIFT.cabinet, Math.min(r.w, r.h) * 0.45);
  const grille: Rect = { x: r.x + r.w * 0.12, y: r.y + r.h - lift + 1.2, w: r.w * 0.3, h: Math.max(1.4, lift - 2.6) };
  inlay(g, grille, shade(MAT.steelLit.front, 0.78));
};

/**
 * The fabricator: the base's whole point. A dark machine box around a bright
 * build plate under a gantry rail. The plate is the brightest value on the floor
 * so the eye goes there first, and the gantry crossing it says "this makes things"
 * rather than "this stores things".
 */
const fabricatorGlyph: GlyphFn = (g, pad, o) => {
  const { r, across } = bay(o);
  contact(pad, r, LIFT.machine);
  const top = volume(g, r, MAT.paintedDark, LIFT.machine, 1.5);
  inlay(g, inset(top, 1.3), shade(MAT.paintedDark.top, 0.9), 1);

  // Build chamber: recessed, then the lit plate inside it.
  const chamber = across
    ? { x: top.x + top.w * 0.2, y: top.y + 2.4, w: top.w * 0.6, h: Math.max(4, top.h - 4.8) }
    : { x: top.x + 2.4, y: top.y + top.h * 0.2, w: Math.max(4, top.w - 4.8), h: top.h * 0.6 };
  inlay(g, chamber, DEEP_SEAM, 1);
  const plate = inset(chamber, 1.8);
  inlay(g, plate, MAT.core.top, 0.8);
  inlay(g, inset(plate, 1.4), MAT.core.lit, 0.8);

  // Gantry rail across the short axis of the chamber, with its carriage.
  const rail = across
    ? { x: chamber.x - 1.5, y: chamber.y + chamber.h * 0.42, w: chamber.w + 3, h: 2.4 }
    : { x: chamber.x + chamber.w * 0.42, y: chamber.y - 1.5, w: 2.4, h: chamber.h + 3 };
  sit(g, rail, 3);
  inlay(g, rail, MAT.steelDeep.top);
  inlay(g, across ? { ...rail, h: 0.8 } : { ...rail, w: 0.8 }, MAT.steelDark.lit);
  const carriage = across
    ? { x: rail.x + rail.w * 0.34, y: rail.y - 1.8, w: 7, h: rail.h + 3.6 }
    : { x: rail.x - 1.8, y: rail.y + rail.h * 0.34, w: rail.w + 3.6, h: 7 };
  sit(g, carriage, 4);
  volume(g, carriage, MAT.steelDark, 3, 1);

  // Status strip on the machine body, the side away from the chamber.
  const strip = across
    ? { x: top.x + 2.4, y: top.y + top.h * 0.34, w: top.w * 0.12, h: top.h * 0.3 }
    : { x: top.x + top.w * 0.34, y: top.y + 2.4, w: top.w * 0.3, h: top.h * 0.12 };
  inlay(g, strip, MAT.core.lit, 0.6);
};

/**
 * A bay console: the desk you stand at to fit out a DotBot. An angled panel of
 * readouts, so the value ramp runs up the panel the way the drafting board's
 * does, plus a key block. Lit readouts distinguish it from a plain desk.
 */
const bayConsoleGlyph: GlyphFn = (g, pad, o) => {
  const { r, across, farSide } = bay(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.steelDeep, LIFT.cabinet, 1.5);

  const panelDepth = (across ? top.h : top.w) * 0.56;
  const panel = sideBand(top, across, farSide, panelDepth);
  // Two-step ramp is enough at this size; five would band visibly.
  for (let i = 0; i < 2; i += 1) {
    const t = farSide ? i : 1 - i;
    const slice = across
      ? { x: panel.x + 1.4, y: panel.y + (panel.h / 2) * t, w: panel.w - 2.8, h: panel.h / 2 }
      : { x: panel.x + (panel.w / 2) * t, y: panel.y + 1.4, w: panel.w / 2, h: panel.h - 2.8 };
    inlay(g, slice, shade(MAT.steelDark.top, i === 0 ? 1.04 : 0.94));
  }
  // Readouts: three bright cells in a row along the panel.
  const span = across ? panel.w : panel.h;
  for (let i = 0; i < 3; i += 1) {
    const at = span * (0.16 + i * 0.28);
    const cell = across
      ? { x: panel.x + at, y: panel.y + panelDepth * 0.24, w: span * 0.18, h: panelDepth * 0.3 }
      : { x: panel.x + panelDepth * 0.24, y: panel.y + at, w: panelDepth * 0.3, h: span * 0.18 };
    inlay(g, cell, DEEP_SEAM, 0.6);
    inlay(g, inset(cell, 0.9), i === 1 ? MAT.core.lit : MAT.board.top, 0.6);
  }
  // Key block on the operator side.
  const keys = sideBand(top, across, !farSide, (across ? top.h : top.w) * 0.3);
  inlay(g, keys, shade(MAT.steelDeep.top, 1.02));
  const keySpan = across ? keys.w : keys.h;
  const count = Math.max(4, Math.floor(keySpan / 11));
  for (let i = 0; i < count; i += 1) {
    const at = (keySpan / count) * (i + 0.5);
    const key = across
      ? { x: keys.x + at - 2.6, y: keys.y + 1.2, w: 5.2, h: Math.max(1.4, keys.h - 2.4) }
      : { x: keys.x + 1.2, y: keys.y + at - 2.6, w: Math.max(1.4, keys.w - 2.4), h: 5.2 };
    inlay(g, key, MAT.steelDark.top, 0.6);
    inlay(g, across ? { ...key, h: 0.7 } : { ...key, w: 0.7 }, MAT.steelDark.lit);
  }
};

/**
 * A reception counter: a worktop with a raised transaction shelf on the public
 * side. The step in the top face is the cue — it is the only base fixture with two
 * surfaces at different heights.
 */
const receptionDeskGlyph: GlyphFn = (g, pad, o) => {
  const { r, across, farSide } = bay(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.wood, LIFT.cabinet, 1.5);

  // Working surface (staff side), lower and plainer.
  const workDepth = (across ? top.h : top.w) * 0.52;
  const work = sideBand(top, across, farSide, workDepth);
  inlay(g, work, shade(MAT.wood.top, 0.95));
  // Ledger and a terminal on the working side.
  const pad2 = across
    ? { x: work.x + work.w * 0.14, y: work.y + workDepth * 0.28, w: work.w * 0.2, h: workDepth * 0.42 }
    : { x: work.x + workDepth * 0.28, y: work.y + work.h * 0.14, w: workDepth * 0.42, h: work.h * 0.2 };
  inlay(g, pad2, MAT.fibre.lit, 0.6);

  // Raised transaction shelf on the public side, drawn as its own small volume so
  // it casts onto the counter below it.
  const shelf = sideBand(top, across, !farSide, (across ? top.h : top.w) * 0.4);
  sit(g, shelf, 3);
  const shelfTop = volume(g, shelf, MAT.woodDark, 3, 1);
  inlay(g, inset(shelfTop, 1.2), shade(MAT.woodDark.top, 1.05), 1);
};

/**
 * A rack of boards. Lit board edges in dark bays: the pattern is bright-dark
 * alternation at a tighter pitch than any shelf in the world, which is what makes
 * it read as electronics rather than storage.
 */
const serverRackGlyph: GlyphFn = (g, pad, o) => {
  const { r, across } = bay(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.steelDeep, LIFT.cabinet, 1);

  const inner = inset(top, 2);
  inlay(g, inner, 0x1b1f23, 0.8);
  const span = across ? inner.w : inner.h;
  const bays = Math.max(4, Math.floor(span / 9));
  for (let i = 0; i < bays; i += 1) {
    const at = (span / bays) * i;
    const pitch = span / bays;
    const board = across
      ? { x: inner.x + at + 0.8, y: inner.y + 1, w: pitch - 1.6, h: Math.max(1.2, inner.h - 2) }
      : { x: inner.x + 1, y: inner.y + at + 0.8, w: Math.max(1.2, inner.w - 2), h: pitch - 1.6 };
    inlay(g, board, MAT.board.top);
    // The lit leading edge of each board, and an activity mark on some of them.
    inlay(g, across ? { ...board, h: 0.9 } : { ...board, w: 0.9 }, MAT.board.lit);
    if (jitter(o.id, 60 + i) > 0.45) {
      const led = across
        ? { x: board.x + board.w * 0.3, y: board.y + board.h * 0.55, w: board.w * 0.4, h: 1.1 }
        : { x: board.x + board.w * 0.55, y: board.y + board.h * 0.3, w: 1.1, h: board.h * 0.4 };
      inlay(g, led, MAT.core.lit);
    }
  }
};

/**
 * A listening post: a console with a dish. The dish is a circle on a rectangle,
 * and it is the only round thing among the base's fixtures, so it identifies at a
 * glance even though the box around it is the standard wall bay.
 */
const listeningPostGlyph: GlyphFn = (g, pad, o) => {
  const { r, across, farSide } = bay(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.painted, LIFT.cabinet, 1.5);
  inlay(g, inset(top, 1.4), shade(MAT.painted.top, 0.93), 1);

  // Dish at the far end, mounted on a short pedestal. Sized to nearly fill the
  // bay's short side: a small disc on a big box reads as a dial, and the dish
  // being round is the entire cue that separates this from a plain console.
  const short = across ? top.h : top.w;
  const long = across ? top.w : top.h;
  const radius = Math.min(short * 0.44, long * 0.24);
  const dishAt = across
    ? { x: farSide ? top.x + radius + 3 : top.x + top.w - radius - 3, y: top.y + top.h / 2 }
    : { x: top.x + top.w / 2, y: farSide ? top.y + radius + 3 : top.y + top.h - radius - 3 };
  sitRound(g, dishAt.x, dishAt.y, radius, 4);
  cylinder(g, dishAt.x, dishAt.y, radius, MAT.steelLit, 4);
  // Reflector rings and the feed horn at the centre.
  g.circle(dishAt.x, dishAt.y, radius * 0.62).stroke({ color: shade(MAT.steelLit.front, 0.8), width: 0.8 });
  g.circle(dishAt.x, dishAt.y, radius * 0.3).fill({ color: DEEP_SEAM });
  g.circle(dishAt.x, dishAt.y, radius * 0.14).fill({ color: MAT.core.lit });

  // Operator side: a headphone hook and two tuning readouts.
  const consoleBand = sideBand(top, across, !farSide, (across ? top.h : top.w) * 0.34);
  for (let i = 0; i < 2; i += 1) {
    const cell = across
      ? { x: consoleBand.x + consoleBand.w * (0.52 + i * 0.2), y: consoleBand.y + consoleBand.h * 0.3, w: consoleBand.w * 0.14, h: consoleBand.h * 0.4 }
      : { x: consoleBand.x + consoleBand.w * 0.3, y: consoleBand.y + consoleBand.h * (0.52 + i * 0.2), w: consoleBand.w * 0.4, h: consoleBand.h * 0.14 };
    inlay(g, cell, DEEP_SEAM, 0.6);
    inlay(g, inset(cell, 0.8), MAT.board.lit, 0.6);
  }
};

/**
 * A signal mast: a heavy plinth with a mast rising out of it and antenna arms
 * radiating from the mast. The arms are what read at play zoom — a bare cylinder
 * on a box is a bollard on a plinth.
 */
const signalMastGlyph: GlyphFn = (g, pad, o) => {
  const { r } = bay(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.steelDark, LIFT.cabinet, 1.5);
  // Bolted base plate.
  const plate = inset(top, 2);
  inlay(g, plate, shade(MAT.steelDark.top, 0.9), 1);
  for (const [fx, fy] of [[0.12, 0.2], [0.88, 0.2], [0.12, 0.8], [0.88, 0.8]] as Array<[number, number]>) {
    g.circle(plate.x + plate.w * fx, plate.y + plate.h * fy, 1.1).fill({ color: MAT.steelLit.lit });
  }

  const cx = top.x + top.w / 2;
  const cy = top.y + top.h / 2;
  const mastR = Math.min(top.w, top.h) * 0.19;

  // Antenna arms first so the mast overlaps them at the hub.
  const arms = 6;
  const reach = Math.min(top.w, top.h) * 0.46;
  for (let i = 0; i < arms; i += 1) {
    const angle = (i / arms) * Math.PI * 2 + 0.26;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // Shadow, then the arm, so each element reads as standing off the plinth.
    g.moveTo(cx + dx * mastR + 0.9, cy + dy * mastR + 1.4)
      .lineTo(cx + dx * reach + 0.9, cy + dy * reach + 1.4)
      .stroke({ color: 0x000000, alpha: 0.17, width: 2 });
    g.moveTo(cx + dx * mastR, cy + dy * mastR)
      .lineTo(cx + dx * reach, cy + dy * reach)
      .stroke({ color: MAT.steelLit.top, width: 1.8 });
    // Element tips catch the light.
    g.circle(cx + dx * reach, cy + dy * reach, 1.3).fill({ color: MAT.steelLit.lit });
  }

  sitRound(g, cx, cy, mastR, 7);
  cylinder(g, cx, cy, mastR, MAT.steelLit, 6);
  g.circle(cx, cy, mastR * 0.4).fill({ color: MAT.core.lit });
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * A rug, mat or floor covering: laid on the slab, never standing on it.
 *
 * It has to draw *flat* — no lift, no cast shadow — for two reasons. A player
 * needs to see at a glance that they can walk over it, and a lifted 200-unit rug
 * paints its top face over every piece of furniture standing inside it, which is
 * how a solid table ends up invisible under one.
 */
const rugGlyph: GlyphFn = (g, _pad, o) => {
  const r = rect(o);
  inlay(g, r, V.rug);
  inlay(g, inset(r, 5), shade(V.rug, 0.97));
  // A woven border, drawn as a line rather than a lip: no edge catches light.
  g.rect(r.x + 2.5, r.y + 2.5, r.w - 5, r.h - 5).stroke({ color: shade(V.rug, 0.9), width: 1.2 });
};

const genericBox: GlyphFn = (g, pad, o) => {
  const r = rect(o);
  contact(pad, r, LIFT.cabinet);
  const top = volume(g, r, MAT.steel, LIFT.cabinet, 1);
  inlay(g, inset(top, 2), shade(MAT.steel.top, 0.94));
};

export const modelGlyphs: Partial<Record<MapObject["kind"], GlyphFn>> = {
  rug: rugGlyph,
  shelf: rackGlyph,
  pallet: palletGlyph,
  crateStack: crateStackGlyph,
  drum: drumGlyph,
  forklift: forkliftGlyph,
  workbench: workbenchGlyph,
  toolCabinet: drawerUnitGlyph(MAT.painted, 4, LIFT.cabinet, true),
  filingCabinet: drawerUnitGlyph(MAT.steel, 4),
  cabinet: drawerUnitGlyph(MAT.steel, 3),
  locker: lockerGlyph,
  desk: deskGlyph,
  plant: plantGlyph,
  column: columnGlyph,
  generator: generatorGlyph,
  utilityBox: utilityBoxGlyph,
  vent: ventGlyph,
  tree: treeGlyph,
  car: carGlyph,
  lampPost: lampPostGlyph,
  bench: benchGlyph,
  planter: planterGlyph,
  hydrant: hydrantGlyph,
  bollard: bollardGlyph,
  bikeRack: bikeRackGlyph,
  dumpster: dumpsterGlyph,
  parkingStall: parkingStallGlyph,
  kiosk: kioskGlyph,
  hvac: hvacGlyph,
  skylight: skylightGlyph,

  // The player base.
  bed: bunkGlyph(MAT.painted, LIFT.seat, false),
  cot: bunkGlyph(MAT.steelDark, LIFT.low, true),
  couch: couchGlyph,
  conferenceTable: conferenceTableGlyph,
  planningTable: planningTableGlyph,
  draftingTable: draftingTableGlyph,
  repairBench: repairBenchGlyph,
  fridge: fridgeGlyph,
  fabricator: fabricatorGlyph,
  bayConsole: bayConsoleGlyph,
  receptionDesk: receptionDeskGlyph,
  serverRack: serverRackGlyph,
  listeningPost: listeningPostGlyph,
  signalMast: signalMastGlyph,
};

export function drawModelObject(g: Graphics, pad: ShadowPad, o: MapObject): void {
  (modelGlyphs[o.kind] ?? genericBox)(g, pad, o);
}
