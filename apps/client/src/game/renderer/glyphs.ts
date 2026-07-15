import type { Graphics } from "pixi.js";
import type { Facing, MapObject, ObjectKind } from "@dotbot/game/types";
import { INK, PAPER, strokes, type StrokeStyle } from "./style";

/**
 * Object glyph library: orthographic plan symbols drawn in pure line work.
 *
 * Rules of the drawing system (see style.ts):
 *  - white fill, tiered gray/black strokes; no shadows, bevels, or washes;
 *  - anchor furniture takes the T3 line, small fixtures T4, detail T5;
 *  - a glyph never exceeds its authored rect, and never implies collision
 *    the data doesn't declare.
 *
 * `facing` marks the object's accent side (bed pillow, chair back, couch
 * back, fridge hinge, toilet tank). Glyphs read it where orientation matters
 * and otherwise infer from the rect's aspect.
 */

export { INK } from "./style";

type GlyphFn = (g: Graphics, o: MapObject) => void;

const T3 = strokes.anchor;
const T4 = strokes.fixture;
const T5 = strokes.hairline;

/** White-filled outline: the base body of nearly every plan symbol. */
function body(g: Graphics, x: number, y: number, w: number, h: number, s: StrokeStyle, radius = 0): void {
  if (radius > 0) {
    g.roundRect(x, y, w, h, radius).fill({ color: PAPER });
    g.roundRect(x, y, w, h, radius).stroke(s);
  } else {
    g.rect(x, y, w, h).fill({ color: PAPER });
    g.rect(x, y, w, h).stroke(s);
  }
}

function line(g: Graphics, x1: number, y1: number, x2: number, y2: number, s: StrokeStyle): void {
  g.moveTo(x1, y1).lineTo(x2, y2).stroke(s);
}

/** The strip of the rect hugging one side, `depth` world units deep. */
function sideStrip(o: MapObject, side: Facing, depth: number, inset = 0) {
  const x = o.x + inset;
  const y = o.y + inset;
  const w = o.w - inset * 2;
  const h = o.h - inset * 2;

  switch (side) {
    case "N":
      return { x, y, w, h: depth };
    case "S":
      return { x, y: y + h - depth, w, h: depth };
    case "W":
      return { x, y, w: depth, h };
    default:
      return { x: x + w - depth, y, w: depth, h };
  }
}

// ---------------------------------------------------------------------------
// Seating and tables
// ---------------------------------------------------------------------------

function chairGlyph(g: Graphics, o: MapObject): void {
  const facing = o.facing ?? "S";
  body(g, o.x + 1, o.y + 1, o.w - 2, o.h - 2, T4, 2);

  // Back bar on the side opposite the facing direction.
  const back: Facing = facing === "S" ? "N" : facing === "N" ? "S" : facing === "E" ? "W" : "E";
  const bar = sideStrip({ ...o, x: o.x + 1, y: o.y + 1, w: o.w - 2, h: o.h - 2 }, back, 3.5);
  g.rect(bar.x, bar.y, bar.w, bar.h).fill({ color: PAPER });
  g.rect(bar.x, bar.y, bar.w, bar.h).stroke(T4);
}

function tableGlyph(g: Graphics, o: MapObject): void {
  const round = Math.abs(o.w - o.h) < 4;

  if (round) {
    const r = Math.min(o.w, o.h) / 2;
    g.circle(o.x + o.w / 2, o.y + o.h / 2, r - 1).fill({ color: PAPER });
    g.circle(o.x + o.w / 2, o.y + o.h / 2, r - 1).stroke(T3);
    g.circle(o.x + o.w / 2, o.y + o.h / 2, Math.max(2, r * 0.16)).stroke(T5);
    return;
  }

  body(g, o.x, o.y, o.w, o.h, T3, 1);
  g.rect(o.x + 3, o.y + 3, o.w - 6, o.h - 6).stroke(T5);
}

function conferenceTableGlyph(g: Graphics, o: MapObject): void {
  // Chairs first so the table edge overlaps their fronts.
  const horizontal = o.w >= o.h;
  const chair = 16;
  const tableRect = horizontal
    ? { x: o.x + 4, y: o.y + chair, w: o.w - 8, h: o.h - chair * 2 }
    : { x: o.x + chair, y: o.y + 4, w: o.w - chair * 2, h: o.h - 8 };

  const seats = Math.max(2, Math.floor((horizontal ? tableRect.w : tableRect.h) / 44));
  const span = horizontal ? tableRect.w : tableRect.h;
  const step = span / seats;

  for (let i = 0; i < seats; i += 1) {
    const at = (horizontal ? tableRect.x : tableRect.y) + step * (i + 0.5);
    if (horizontal) {
      chairGlyph(g, { ...o, x: at - 8, y: o.y, w: 16, h: chair, facing: "S" });
      chairGlyph(g, { ...o, x: at - 8, y: o.y + o.h - chair, w: 16, h: chair, facing: "N" });
    } else {
      chairGlyph(g, { ...o, x: o.x, y: at - 8, w: chair, h: 16, facing: "E" });
      chairGlyph(g, { ...o, x: o.x + o.w - chair, y: at - 8, w: chair, h: 16, facing: "W" });
    }
  }

  body(g, tableRect.x, tableRect.y, tableRect.w, tableRect.h, T3, 6);
  g.roundRect(tableRect.x + 4, tableRect.y + 4, tableRect.w - 8, tableRect.h - 8, 4).stroke(T5);
}

function couchGlyph(g: Graphics, o: MapObject): void {
  const facing = o.facing ?? "S";
  body(g, o.x, o.y, o.w, o.h, T3, 3);

  // Back rest along the side opposite the facing, arms on the two flanks.
  const back: Facing = facing === "S" ? "N" : facing === "N" ? "S" : facing === "E" ? "W" : "E";
  const backStrip = sideStrip(o, back, 6);
  g.rect(backStrip.x, backStrip.y, backStrip.w, backStrip.h).stroke(T4);

  const alongX = back === "N" || back === "S";
  if (alongX) {
    line(g, o.x + 6, o.y + 2, o.x + 6, o.y + o.h - 2, T4);
    line(g, o.x + o.w - 6, o.y + 2, o.x + o.w - 6, o.y + o.h - 2, T4);
    // Cushion seams.
    const seats = Math.max(2, Math.round((o.w - 12) / 44));
    for (let i = 1; i < seats; i += 1) {
      const x = o.x + 6 + ((o.w - 12) / seats) * i;
      line(g, x, back === "N" ? o.y + 6 : o.y + 2, x, back === "N" ? o.y + o.h - 2 : o.y + o.h - 6, T5);
    }
  } else {
    line(g, o.x + 2, o.y + 6, o.x + o.w - 2, o.y + 6, T4);
    line(g, o.x + 2, o.y + o.h - 6, o.x + o.w - 2, o.y + o.h - 6, T4);
    const seats = Math.max(2, Math.round((o.h - 12) / 44));
    for (let i = 1; i < seats; i += 1) {
      const y = o.y + 6 + ((o.h - 12) / seats) * i;
      line(g, back === "W" ? o.x + 6 : o.x + 2, y, back === "W" ? o.x + o.w - 2 : o.x + o.w - 6, y, T5);
    }
  }
}

function benchGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4, 1);
  // Slats along the long axis.
  if (o.w >= o.h) {
    const rows = Math.max(2, Math.floor(o.h / 8));
    for (let i = 1; i < rows; i += 1) {
      line(g, o.x + 2, o.y + (o.h / rows) * i, o.x + o.w - 2, o.y + (o.h / rows) * i, T5);
    }
  } else {
    const rows = Math.max(2, Math.floor(o.w / 8));
    for (let i = 1; i < rows; i += 1) {
      line(g, o.x + (o.w / rows) * i, o.y + 2, o.x + (o.w / rows) * i, o.y + o.h - 2, T5);
    }
  }
}

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------

function bedGlyph(g: Graphics, o: MapObject, cot = false): void {
  const head = o.facing ?? (o.h >= o.w ? "N" : "W");
  body(g, o.x, o.y, o.w, o.h, T3, cot ? 4 : 1);

  // Pillow: a small rounded rect against the head end.
  const along = head === "N" || head === "S" ? o.h : o.w;
  const depth = Math.min(20, along * 0.24);
  const p = sideStrip(o, head, depth, 5);
  g.roundRect(p.x, p.y, p.w, p.h, 3).stroke(T4);

  // Blanket fold line two-thirds down from the head.
  if (head === "N") {
    line(g, o.x + 2, o.y + o.h * 0.4, o.x + o.w - 2, o.y + o.h * 0.4, T4);
    line(g, o.x + 2, o.y + o.h * 0.4 + 4, o.x + o.w - 2, o.y + o.h * 0.4 + 4, T5);
  } else if (head === "S") {
    line(g, o.x + 2, o.y + o.h * 0.6, o.x + o.w - 2, o.y + o.h * 0.6, T4);
    line(g, o.x + 2, o.y + o.h * 0.6 - 4, o.x + o.w - 2, o.y + o.h * 0.6 - 4, T5);
  } else if (head === "W") {
    line(g, o.x + o.w * 0.4, o.y + 2, o.x + o.w * 0.4, o.y + o.h - 2, T4);
    line(g, o.x + o.w * 0.4 + 4, o.y + 2, o.x + o.w * 0.4 + 4, o.y + o.h - 2, T5);
  } else {
    line(g, o.x + o.w * 0.6, o.y + 2, o.x + o.w * 0.6, o.y + o.h - 2, T4);
    line(g, o.x + o.w * 0.6 - 4, o.y + 2, o.x + o.w * 0.6 - 4, o.y + o.h - 2, T5);
  }

  if (cot) {
    // Caster ticks at the corners.
    for (const [cx, cy] of [
      [o.x + 3, o.y + 3],
      [o.x + o.w - 3, o.y + 3],
      [o.x + 3, o.y + o.h - 3],
      [o.x + o.w - 3, o.y + o.h - 3],
    ]) {
      g.circle(cx, cy, 1.6).stroke(T4);
    }
  }
}

// ---------------------------------------------------------------------------
// Worksurfaces and storage
// ---------------------------------------------------------------------------

function deskGlyph(g: Graphics, o: MapObject): void {
  const chairSide = o.facing ?? "S";
  const alongX = chairSide === "N" || chairSide === "S";
  const deskDepth = (alongX ? o.h : o.w) * 0.62;

  const desk = sideStrip(o, chairSide === "S" ? "N" : chairSide === "N" ? "S" : chairSide === "E" ? "W" : "E", deskDepth);

  // Tucked chair centered on the open side, drawn first.
  const seat = 20;
  if (alongX) {
    const cy = chairSide === "S" ? desk.y + desk.h - 4 : desk.y - seat + 4;
    chairGlyph(g, { ...o, x: o.x + o.w / 2 - seat / 2, y: cy, w: seat, h: seat, facing: chairSide === "S" ? "N" : "S" });
  } else {
    const cx = chairSide === "E" ? desk.x + desk.w - 4 : desk.x - seat + 4;
    chairGlyph(g, { ...o, x: cx, y: o.y + o.h / 2 - seat / 2, w: seat, h: seat, facing: chairSide === "E" ? "W" : "E" });
  }

  body(g, desk.x, desk.y, desk.w, desk.h, T3, 1);

  // Monitor: a thin bar near the wall side of the desktop.
  if (alongX) {
    const my = chairSide === "S" ? desk.y + 5 : desk.y + desk.h - 8;
    g.rect(o.x + o.w / 2 - 11, my, 22, 3).stroke(T4);
  } else {
    const mx = chairSide === "E" ? desk.x + 5 : desk.x + desk.w - 8;
    g.rect(mx, o.y + o.h / 2 - 11, 3, 22).stroke(T4);
  }
}

function counterGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  // Front edge line — counters read as built-in millwork, not tables.
  if (o.w >= o.h) {
    line(g, o.x, o.y + o.h - 3, o.x + o.w, o.y + o.h - 3, T5);
  } else {
    line(g, o.x + o.w - 3, o.y, o.x + o.w - 3, o.y + o.h, T5);
  }
}

function receptionDeskGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  g.rect(o.x + 4, o.y + 4, o.w - 8, o.h - 8).stroke(T5);
}

function shelfGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);

  // Center spine + bay divisions along the run.
  if (o.w >= o.h) {
    line(g, o.x, o.y + o.h / 2, o.x + o.w, o.y + o.h / 2, T4);
    const bays = Math.max(2, Math.round(o.w / 30));
    for (let i = 1; i < bays; i += 1) {
      line(g, o.x + (o.w / bays) * i, o.y, o.x + (o.w / bays) * i, o.y + o.h, T5);
    }
  } else {
    line(g, o.x + o.w / 2, o.y, o.x + o.w / 2, o.y + o.h, T4);
    const bays = Math.max(2, Math.round(o.h / 30));
    for (let i = 1; i < bays; i += 1) {
      line(g, o.x, o.y + (o.h / bays) * i, o.x + o.w, o.y + (o.h / bays) * i, T5);
    }
  }
}

function cabinetGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  // Double doors split on the long axis.
  if (o.w >= o.h) {
    line(g, o.x + o.w / 2, o.y + 1, o.x + o.w / 2, o.y + o.h - 1, T5);
  } else {
    line(g, o.x + 1, o.y + o.h / 2, o.x + o.w - 1, o.y + o.h / 2, T5);
  }
}

function medicalCabinetGlyph(g: Graphics, o: MapObject): void {
  cabinetGlyph(g, o);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) * 0.22;
  line(g, cx - r, cy, cx + r, cy, T4);
  line(g, cx, cy - r, cx, cy + r, T4);
}

function filingCabinetGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  const vertical = o.h >= o.w;
  const drawers = 3;
  for (let i = 1; i < drawers; i += 1) {
    if (vertical) {
      line(g, o.x + 1, o.y + (o.h / drawers) * i, o.x + o.w - 1, o.y + (o.h / drawers) * i, T5);
    } else {
      line(g, o.x + (o.w / drawers) * i, o.y + 1, o.x + (o.w / drawers) * i, o.y + o.h - 1, T5);
    }
  }
}

function lockerGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  // Vent slits near the top edge.
  const vertical = o.h >= o.w;
  if (vertical) {
    line(g, o.x + 3, o.y + 5, o.x + o.w - 3, o.y + 5, T5);
    line(g, o.x + 3, o.y + 9, o.x + o.w - 3, o.y + 9, T5);
  } else {
    line(g, o.x + 5, o.y + 3, o.x + 5, o.y + o.h - 3, T5);
    line(g, o.x + 9, o.y + 3, o.x + 9, o.y + o.h - 3, T5);
  }
}

function bayConsoleGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  const inset = Math.max(4, Math.min(o.w, o.h) * 0.14);
  g.roundRect(o.x + inset, o.y + inset, o.w - inset * 2, o.h - inset * 2, 2).stroke(T4);
  const horizontal = o.w >= o.h;
  if (horizontal) {
    line(g, o.x + o.w * 0.25, o.y + o.h / 2, o.x + o.w * 0.75, o.y + o.h / 2, T5);
  } else {
    line(g, o.x + o.w / 2, o.y + o.h * 0.25, o.x + o.w / 2, o.y + o.h * 0.75, T5);
  }
}

function toolCabinetGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  line(g, o.x + 1, o.y + o.h / 2, o.x + o.w - 1, o.y + o.h / 2, T5);
  line(g, o.x + o.w / 2, o.y + o.h / 2, o.x + o.w / 2, o.y + o.h - 1, T5);
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

function serverRackGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  const vertical = o.h >= o.w;
  const slots = Math.max(3, Math.floor((vertical ? o.h : o.w) / 12));
  for (let i = 1; i < slots; i += 1) {
    if (vertical) {
      line(g, o.x + 3, o.y + (o.h / slots) * i, o.x + o.w - 3, o.y + (o.h / slots) * i, T5);
    } else {
      line(g, o.x + (o.w / slots) * i, o.y + 3, o.x + (o.w / slots) * i, o.y + o.h - 3, T5);
    }
  }
}

function generatorGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  const cx = o.x + o.w * 0.34;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) * 0.28;
  g.circle(cx, cy, r).stroke(T4);
  g.circle(cx, cy, r * 0.4).stroke(T5);
  // Terminal block on the other end.
  g.rect(o.x + o.w * 0.62, o.y + o.h * 0.25, o.w * 0.26, o.h * 0.5).stroke(T4);
  line(g, o.x + o.w * 0.68, o.y + o.h * 0.35, o.x + o.w * 0.68, o.y + o.h * 0.65, T5);
  line(g, o.x + o.w * 0.76, o.y + o.h * 0.35, o.x + o.w * 0.76, o.y + o.h * 0.65, T5);
}

function utilityBoxGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  line(g, o.x + o.w * 0.5, o.y + 2, o.x + o.w * 0.5, o.y + o.h - 2, T5);
}

function vendingGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  // Display window + selection column.
  g.rect(o.x + 3, o.y + 3, o.w * 0.55, o.h - 6).stroke(T5);
  g.rect(o.x + o.w * 0.68, o.y + 4, o.w * 0.2, o.h * 0.3).stroke(T5);
}

function fridgeGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  const hinge = o.facing ?? "N";
  // Door split: fridges read as a box with a door line + handle tick.
  if (hinge === "N" || hinge === "S") {
    const y = hinge === "N" ? o.y + o.h * 0.35 : o.y + o.h * 0.65;
    line(g, o.x + 1, y, o.x + o.w - 1, y, T5);
  } else {
    const x = hinge === "W" ? o.x + o.w * 0.35 : o.x + o.w * 0.65;
    line(g, x, o.y + 1, x, o.y + o.h - 1, T5);
  }
}

function hvacGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  const r = Math.min(o.w, o.h) * 0.3;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  g.circle(cx, cy, r).stroke(T4);
  // Fan cross.
  line(g, cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7, T5);
  line(g, cx + r * 0.7, cy - r * 0.7, cx - r * 0.7, cy + r * 0.7, T5);
  g.rect(o.x + 3, o.y + 3, o.w - 6, o.h - 6).stroke(T5);
}

function ventGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  const rows = 3;
  for (let i = 1; i < rows; i += 1) {
    line(g, o.x + 2, o.y + (o.h / rows) * i, o.x + o.w - 2, o.y + (o.h / rows) * i, T5);
  }
}

function skylightGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.glass });
  g.rect(o.x, o.y, o.w, o.h).stroke(T4);
  line(g, o.x, o.y, o.x + o.w, o.y + o.h, T5);
  // Frame mullions.
  if (o.w >= o.h) {
    const bays = Math.max(2, Math.round(o.w / 34));
    for (let i = 1; i < bays; i += 1) {
      line(g, o.x + (o.w / bays) * i, o.y, o.x + (o.w / bays) * i, o.y + o.h, T5);
    }
  } else {
    const bays = Math.max(2, Math.round(o.h / 34));
    for (let i = 1; i < bays; i += 1) {
      line(g, o.x, o.y + (o.h / bays) * i, o.x + o.w, o.y + (o.h / bays) * i, T5);
    }
  }
}

function washerGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  g.circle(cx, cy, Math.min(o.w, o.h) * 0.3).stroke(T4);
  g.circle(cx, cy, Math.min(o.w, o.h) * 0.17).stroke(T5);
}

function stoveGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  const r = Math.min(o.w, o.h) * 0.16;
  for (const [fx, fy] of [
    [0.28, 0.28],
    [0.72, 0.28],
    [0.28, 0.72],
    [0.72, 0.72],
  ]) {
    g.circle(o.x + o.w * fx, o.y + o.h * fy, r).stroke(T5);
  }
}

function sinkGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4, 2);
  g.roundRect(o.x + 3, o.y + 3, o.w - 6, o.h - 6, 3).stroke(T5);
  g.circle(o.x + o.w / 2, o.y + o.h / 2, 1.4).fill({ color: INK.fixture });
}

function toiletGlyph(g: Graphics, o: MapObject): void {
  const wallSide = o.facing ?? "N";
  const alongX = wallSide === "N" || wallSide === "S";
  const tankDepth = (alongX ? o.h : o.w) * 0.3;
  const tank = sideStrip(o, wallSide, tankDepth);

  body(g, tank.x, tank.y, tank.w, tank.h, T4, 1);

  // Bowl: an ellipse in the remaining space.
  const bx = alongX ? o.x + o.w / 2 : wallSide === "W" ? o.x + tankDepth + (o.w - tankDepth) / 2 : o.x + (o.w - tankDepth) / 2;
  const by = !alongX ? o.y + o.h / 2 : wallSide === "N" ? o.y + tankDepth + (o.h - tankDepth) / 2 : o.y + (o.h - tankDepth) / 2;
  const rx = alongX ? o.w * 0.32 : (o.w - tankDepth) * 0.42;
  const ry = alongX ? (o.h - tankDepth) * 0.42 : o.h * 0.32;
  g.ellipse(bx, by, rx, ry).fill({ color: PAPER });
  g.ellipse(bx, by, rx, ry).stroke(T4);
  g.ellipse(bx, by, rx * 0.55, ry * 0.55).stroke(T5);
}

// ---------------------------------------------------------------------------
// Warehouse and service
// ---------------------------------------------------------------------------

function crateStackGlyph(g: Graphics, o: MapObject): void {
  const s = Math.min(o.w, o.h) * 0.62;
  body(g, o.x, o.y + o.h - s, s, s, T4);
  line(g, o.x, o.y + o.h - s, o.x + s, o.y + o.h, T5);
  line(g, o.x + s, o.y + o.h - s, o.x, o.y + o.h, T5);
  body(g, o.x + o.w - s, o.y, s, s, T4);
  line(g, o.x + o.w - s, o.y, o.x + o.w, o.y + s, T5);
}

function palletGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).stroke(T4);
  const boards = Math.max(3, Math.round((o.w >= o.h ? o.w : o.h) / 12));
  for (let i = 1; i < boards; i += 1) {
    if (o.w >= o.h) {
      line(g, o.x + (o.w / boards) * i, o.y + 1, o.x + (o.w / boards) * i, o.y + o.h - 1, T5);
    } else {
      line(g, o.x + 1, o.y + (o.h / boards) * i, o.x + o.w - 1, o.y + (o.h / boards) * i, T5);
    }
  }
}

function drumGlyph(g: Graphics, o: MapObject): void {
  const r = Math.min(o.w, o.h) / 2;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  g.circle(cx, cy, r - 1).fill({ color: PAPER });
  g.circle(cx, cy, r - 1).stroke(T4);
  g.circle(cx, cy, (r - 1) * 0.55).stroke(T5);
}

function workbenchGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  // Vice block on one end, tool line along the back.
  if (o.w >= o.h) {
    g.rect(o.x + o.w - 10, o.y + o.h / 2 - 5, 8, 10).stroke(T4);
    line(g, o.x + 4, o.y + 5, o.x + o.w - 14, o.y + 5, T5);
  } else {
    g.rect(o.x + o.w / 2 - 5, o.y + o.h - 10, 10, 8).stroke(T4);
    line(g, o.x + 5, o.y + 4, o.x + 5, o.y + o.h - 14, T5);
  }
}

function repairBenchGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const arm = Math.min(o.w, o.h) * 0.18;
  line(g, cx - arm, cy, cx + arm, cy, T4);
  line(g, cx, cy - arm, cx, cy + arm, T4);
  const inset = Math.max(4, Math.min(o.w, o.h) * 0.12);
  g.rect(o.x + inset, o.y + inset, o.w - inset * 2, o.h - inset * 2).stroke(T5);
}

function fabricatorGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) * 0.28;
  g.circle(cx, cy, r).stroke(T4);
  for (let index = 0; index < 6; index += 1) {
    const angle = (index * Math.PI) / 3;
    line(g, cx + Math.cos(angle) * r * 0.35, cy + Math.sin(angle) * r * 0.35, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, T5);
  }
  g.circle(cx, cy, r * 0.22).stroke(T5);
}

function planningTableGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 5);
  g.rect(o.x + 7, o.y + 7, o.w - 14, o.h - 14).stroke(T5);
  line(g, o.x + o.w * 0.25, o.y + 7, o.x + o.w * 0.25, o.y + o.h - 7, T5);
  line(g, o.x + o.w * 0.62, o.y + 7, o.x + o.w * 0.62, o.y + o.h - 7, T5);
  line(g, o.x + 7, o.y + o.h * 0.48, o.x + o.w - 7, o.y + o.h * 0.48, T5);
}

function forkliftGlyph(g: Graphics, o: MapObject): void {
  const forward = o.facing ?? "E";
  const alongX = forward === "E" || forward === "W";
  const bodyLen = (alongX ? o.w : o.h) * 0.62;
  const cab = sideStrip(o, forward === "E" ? "W" : forward === "W" ? "E" : forward === "S" ? "N" : "S", bodyLen);

  body(g, cab.x, cab.y, cab.w, cab.h, T4, 2);
  g.rect(cab.x + cab.w * 0.25, cab.y + cab.h * 0.25, cab.w * 0.5, cab.h * 0.5).stroke(T5);

  // Forks: two tines projecting forward.
  if (alongX) {
    const fx = forward === "E" ? cab.x + cab.w : o.x;
    const fw = o.w - bodyLen;
    line(g, fx, o.y + o.h * 0.3, fx + fw, o.y + o.h * 0.3, T4);
    line(g, fx, o.y + o.h * 0.7, fx + fw, o.y + o.h * 0.7, T4);
  } else {
    const fy = forward === "S" ? cab.y + cab.h : o.y;
    const fh = o.h - bodyLen;
    line(g, o.x + o.w * 0.3, fy, o.x + o.w * 0.3, fy + fh, T4);
    line(g, o.x + o.w * 0.7, fy, o.x + o.w * 0.7, fy + fh, T4);
  }
}

function dumpsterGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  line(g, o.x + o.w / 2, o.y + 1, o.x + o.w / 2, o.y + o.h - 1, T5);
  line(g, o.x + 2, o.y + 3, o.x + o.w - 2, o.y + 3, T5);
}

// ---------------------------------------------------------------------------
// Medical
// ---------------------------------------------------------------------------

function ivStandGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) * 0.42;
  g.circle(cx, cy, r).stroke(T4);
  g.circle(cx, cy, 1.2).fill({ color: INK.fixture });
  for (let i = 0; i < 5; i += 1) {
    const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    line(g, cx + Math.cos(a) * r * 0.4, cy + Math.sin(a) * r * 0.4, cx + Math.cos(a) * r, cy + Math.sin(a) * r, T5);
  }
}

function medicalCartGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4, 1);
  line(g, o.x + 2, o.y + o.h / 2, o.x + o.w - 2, o.y + o.h / 2, T5);
  for (const [cx, cy] of [
    [o.x + 3, o.y + 3],
    [o.x + o.w - 3, o.y + 3],
    [o.x + 3, o.y + o.h - 3],
    [o.x + o.w - 3, o.y + o.h - 3],
  ]) {
    g.circle(cx, cy, 1.3).stroke(T5);
  }
}

function coffeeStationGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  g.circle(o.x + o.w * 0.3, o.y + o.h / 2, Math.min(o.w, o.h) * 0.22).stroke(T5);
  g.rect(o.x + o.w * 0.55, o.y + o.h * 0.25, o.w * 0.3, o.h * 0.5).stroke(T5);
}

// ---------------------------------------------------------------------------
// Site / outdoor
// ---------------------------------------------------------------------------

function treeGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) / 2 - 1;

  // Scalloped canopy: arcs bulging outward between points on the circle.
  const lobes = 9;
  g.beginPath();
  let px = cx + r * Math.cos(0);
  let py = cy + r * Math.sin(0);
  g.moveTo(px, py);
  for (let i = 1; i <= lobes; i += 1) {
    const a = (Math.PI * 2 * i) / lobes;
    const mid = (Math.PI * 2 * (i - 0.5)) / lobes;
    const nx = cx + r * Math.cos(a);
    const ny = cy + r * Math.sin(a);
    g.quadraticCurveTo(cx + r * 1.22 * Math.cos(mid), cy + r * 1.22 * Math.sin(mid), nx, ny);
    px = nx;
    py = ny;
  }
  g.stroke(T4);

  // Branch ticks from the trunk dot.
  g.circle(cx, cy, 1.6).fill({ color: INK.fixture });
  for (let i = 0; i < 5; i += 1) {
    const a = (Math.PI * 2 * i) / 5 + 0.5;
    line(g, cx + Math.cos(a) * 3, cy + Math.sin(a) * 3, cx + Math.cos(a) * r * 0.68, cy + Math.sin(a) * r * 0.68, T5);
  }
}

function plantGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) / 2 - 1;
  g.circle(cx, cy, r).stroke(T4);
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI * 2 * i) / 6;
    line(g, cx, cy, cx + Math.cos(a) * r * 0.75, cy + Math.sin(a) * r * 0.75, T5);
  }
}

function planterGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4, 1);
  // Planting circles along the long axis.
  const alongX = o.w >= o.h;
  const r = Math.min(o.w, o.h) * 0.3;
  const count = Math.max(1, Math.floor((alongX ? o.w : o.h) / (r * 3.2)));
  for (let i = 0; i < count; i += 1) {
    const at = ((alongX ? o.w : o.h) / count) * (i + 0.5);
    const px = alongX ? o.x + at : o.x + o.w / 2;
    const py = alongX ? o.y + o.h / 2 : o.y + at;
    g.circle(px, py, r).stroke(T5);
    line(g, px - r * 0.5, py, px + r * 0.5, py, T5);
    line(g, px, py - r * 0.5, px, py + r * 0.5, T5);
  }
}

function carGlyph(g: Graphics, o: MapObject): void {
  const forward = o.facing ?? (o.w >= o.h ? "E" : "S");
  const alongX = forward === "E" || forward === "W";

  body(g, o.x, o.y, o.w, o.h, T3, Math.min(o.w, o.h) * 0.22);

  // Cabin: inset rounded rect biased toward the rear.
  const len = alongX ? o.w : o.h;
  const cabinLen = len * 0.42;
  const cabinStart = forward === "E" || forward === "S" ? len * 0.28 : len * 0.3;
  const cabin = alongX
    ? { x: o.x + cabinStart, y: o.y + 4, w: cabinLen, h: o.h - 8 }
    : { x: o.x + 4, y: o.y + cabinStart, w: o.w - 8, h: cabinLen };
  g.roundRect(cabin.x, cabin.y, cabin.w, cabin.h, 4).stroke(T4);

  // Windshield line at the front of the cabin.
  if (alongX) {
    const wx = forward === "E" ? cabin.x + cabin.w : cabin.x;
    line(g, wx, cabin.y + 1, wx + (forward === "E" ? 6 : -6), o.y + o.h / 2, T5);
    line(g, wx, cabin.y + cabin.h - 1, wx + (forward === "E" ? 6 : -6), o.y + o.h / 2, T5);
  } else {
    const wy = forward === "S" ? cabin.y + cabin.h : cabin.y;
    line(g, cabin.x + 1, wy, o.x + o.w / 2, wy + (forward === "S" ? 6 : -6), T5);
    line(g, cabin.x + cabin.w - 1, wy, o.x + o.w / 2, wy + (forward === "S" ? 6 : -6), T5);
  }
}

function bikeRackGlyph(g: Graphics, o: MapObject): void {
  const alongX = o.w >= o.h;
  const loops = Math.max(2, Math.floor((alongX ? o.w : o.h) / 18));
  for (let i = 0; i < loops; i += 1) {
    const at = ((alongX ? o.w : o.h) / loops) * (i + 0.5);
    if (alongX) {
      g.roundRect(o.x + at - 5, o.y + 2, 10, o.h - 4, 5).stroke(T4);
    } else {
      g.roundRect(o.x + 2, o.y + at - 5, o.w - 4, 10, 5).stroke(T4);
    }
  }
}

function hydrantGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) / 2 - 1;
  g.circle(cx, cy, r).fill({ color: PAPER });
  g.circle(cx, cy, r).stroke(T4);
  g.circle(cx, cy, r * 0.35).stroke(T5);
  line(g, cx - r, cy, cx - r - 2.5, cy, T4);
  line(g, cx + r, cy, cx + r + 2.5, cy, T4);
}

function lampPostGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  g.circle(cx, cy, 2).fill({ color: INK.fixture });
  g.circle(cx, cy, Math.min(o.w, o.h) * 0.36).stroke(T5);
}

function bollardGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  g.circle(cx, cy, Math.min(o.w, o.h) * 0.28).stroke(T4);
  g.circle(cx, cy, 1).fill({ color: INK.fixture });
}

function kioskGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4, 1);
  line(g, o.x + 3, o.y + o.h * 0.35, o.x + o.w - 3, o.y + o.h * 0.35, T5);
}

function parkingStallGlyph(g: Graphics, o: MapObject): void {
  // Pavement marking only: three-sided hairline, open on the drive side.
  const alongX = o.w >= o.h;
  if (alongX) {
    line(g, o.x, o.y, o.x, o.y + o.h, T5);
    line(g, o.x + o.w, o.y, o.x + o.w, o.y + o.h, T5);
    line(g, o.x, o.y, o.x + o.w, o.y, T5);
  } else {
    line(g, o.x, o.y, o.x + o.w, o.y, T5);
    line(g, o.x, o.y + o.h, o.x + o.w, o.y + o.h, T5);
    line(g, o.x, o.y, o.x, o.y + o.h, T5);
  }
}

function columnGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.structure });
}

function rugGlyph(g: Graphics, o: MapObject): void {
  g.roundRect(o.x, o.y, o.w, o.h, 2).stroke(T5);
  g.roundRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8, 2).stroke(T5);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export const glyphs: Record<ObjectKind, GlyphFn> = {
  bed: (g, o) => bedGlyph(g, o),
  cot: (g, o) => bedGlyph(g, o, true),
  cabinet: cabinetGlyph,
  medicalCabinet: medicalCabinetGlyph,
  desk: deskGlyph,
  chair: chairGlyph,
  table: tableGlyph,
  conferenceTable: conferenceTableGlyph,
  counter: counterGlyph,
  receptionDesk: receptionDeskGlyph,
  serverRack: serverRackGlyph,
  shelf: shelfGlyph,
  filingCabinet: filingCabinetGlyph,
  locker: lockerGlyph,
  crateStack: crateStackGlyph,
  workbench: workbenchGlyph,
  toolCabinet: toolCabinetGlyph,
  generator: generatorGlyph,
  utilityBox: utilityBoxGlyph,
  vending: vendingGlyph,
  fridge: fridgeGlyph,
  couch: couchGlyph,
  plant: plantGlyph,
  planter: planterGlyph,
  bench: benchGlyph,
  kiosk: kioskGlyph,
  tree: treeGlyph,
  car: carGlyph,
  bikeRack: bikeRackGlyph,
  hydrant: hydrantGlyph,
  hvac: hvacGlyph,
  skylight: skylightGlyph,
  vent: ventGlyph,
  parkingStall: parkingStallGlyph,
  lampPost: lampPostGlyph,
  bollard: bollardGlyph,
  dumpster: dumpsterGlyph,
  pallet: palletGlyph,
  drum: drumGlyph,
  forklift: forkliftGlyph,
  ivStand: ivStandGlyph,
  medicalCart: medicalCartGlyph,
  coffeeStation: coffeeStationGlyph,
  washer: washerGlyph,
  toilet: toiletGlyph,
  sink: sinkGlyph,
  stove: stoveGlyph,
  column: columnGlyph,
  rug: rugGlyph,
  fabricator: fabricatorGlyph,
  bayConsole: bayConsoleGlyph,
  planningTable: planningTableGlyph,
  repairBench: repairBenchGlyph,
};

export function drawObject(g: Graphics, object: MapObject): void {
  glyphs[object.kind](g, object);
}

/**
 * Two deterministic fabrication passes. The complete static glyph replaces
 * these temporary layers when the draw-on finishes; M6 can reuse this helper
 * for any newly fabricated base object.
 */
export function drawObjectDraftLayers(outline: Graphics, detail: Graphics, object: MapObject): void {
  body(outline, object.x, object.y, object.w, object.h, T3, object.kind === "planningTable" || object.kind === "fabricator" ? 3 : 1);
  const { x, y, w, h } = object;
  if (object.kind === "locker") {
    if (h >= w) {
      line(detail, x + 3, y + 6, x + w - 3, y + 6, T5);
      line(detail, x + 3, y + 11, x + w - 3, y + 11, T5);
    } else {
      line(detail, x + 6, y + 3, x + 6, y + h - 3, T5);
      line(detail, x + 11, y + 3, x + 11, y + h - 3, T5);
    }
    return;
  }
  if (object.kind === "fabricator") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) * 0.28;
    detail.circle(cx, cy, r).stroke(T4);
    detail.circle(cx, cy, r * 0.22).stroke(T5);
    for (let index = 0; index < 6; index += 1) {
      const angle = (index * Math.PI) / 3;
      line(detail, cx + Math.cos(angle) * r * 0.35, cy + Math.sin(angle) * r * 0.35, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, T5);
    }
    return;
  }
  if (object.kind === "bayConsole") {
    const inset = Math.max(4, Math.min(w, h) * 0.14);
    detail.roundRect(x + inset, y + inset, w - inset * 2, h - inset * 2, 2).stroke(T4);
    if (w >= h) line(detail, x + w * 0.25, y + h / 2, x + w * 0.75, y + h / 2, T5);
    else line(detail, x + w / 2, y + h * 0.25, x + w / 2, y + h * 0.75, T5);
    return;
  }
  if (object.kind === "planningTable") {
    detail.rect(x + 7, y + 7, w - 14, h - 14).stroke(T5);
    line(detail, x + w * 0.25, y + 7, x + w * 0.25, y + h - 7, T5);
    line(detail, x + w * 0.62, y + 7, x + w * 0.62, y + h - 7, T5);
    line(detail, x + 7, y + h * 0.48, x + w - 7, y + h * 0.48, T5);
    return;
  }
  drawObject(detail, object);
}
