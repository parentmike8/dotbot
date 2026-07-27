import type { Graphics } from "pixi.js";
import { planningTableSurfaceRect } from "@dotbot/game/mapModel";
import type { Facing, MapObject, ObjectKind } from "@dotbot/game/types";
import { INK, PAPER, strokes, type StrokeStyle } from "./style";
import {
  drawRetailCooler,
  drawRetailCounter,
  drawRetailKiosk,
  drawRetailProduceDisplay,
  drawRetailShelf,
} from "./retailGlyphs";

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

function opposite(side: Facing): Facing {
  return side === "N" ? "S" : side === "S" ? "N" : side === "E" ? "W" : "E";
}

/** Small, readable surface dressing borrowed from architectural plan symbols. */
function paper(g: Graphics, x: number, y: number, w: number, h: number): void {
  const radius = Math.min(1.5, w * 0.12, h * 0.12);
  g.roundRect(x, y, w, h, radius).fill({ color: PAPER });
  g.roundRect(x, y, w, h, radius).stroke(T5);
  line(g, x + w * 0.2, y + h * 0.38, x + w * 0.78, y + h * 0.38, T5);
  line(g, x + w * 0.2, y + h * 0.64, x + w * 0.62, y + h * 0.64, T5);
}

function cup(g: Graphics, x: number, y: number, r: number): void {
  g.circle(x, y, r).fill({ color: PAPER });
  g.circle(x, y, r).stroke(T5);
  const handleX = x + r * 0.82;
  const handleR = r * 0.54;
  const start = -Math.PI * 0.62;
  g.moveTo(handleX + Math.cos(start) * handleR, y + Math.sin(start) * handleR);
  g.arc(handleX, y, handleR, start, Math.PI * 0.62).stroke(T5);
}

function cornerFeet(g: Graphics, x: number, y: number, w: number, h: number): void {
  const inset = Math.max(2, Math.min(w, h) * 0.1);
  const r = Math.max(0.8, Math.min(1.6, Math.min(w, h) * 0.05));
  for (const [cx, cy] of [
    [x + inset, y + inset],
    [x + w - inset, y + inset],
    [x + inset, y + h - inset],
    [x + w - inset, y + h - inset],
  ]) {
    g.circle(cx, cy, r).stroke(T5);
  }
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

  const inset = Math.max(2, Math.min(o.w, o.h) * 0.2);
  g.roundRect(o.x + inset, o.y + inset, o.w - inset * 2, o.h - inset * 2, 1.5).stroke(T5);

  // Back bar on the side opposite the facing direction.
  const back = opposite(facing);
  const bar = sideStrip({ ...o, x: o.x + 1, y: o.y + 1, w: o.w - 2, h: o.h - 2 }, back, 3.5);
  g.rect(bar.x, bar.y, bar.w, bar.h).fill({ color: PAPER });
  g.rect(bar.x, bar.y, bar.w, bar.h).stroke(T4);

  // Arm ticks make the symbol read as a chair rather than a small cabinet.
  if (facing === "N" || facing === "S") {
    line(g, o.x + 3, o.y + inset, o.x + 3, o.y + o.h - inset, T5);
    line(g, o.x + o.w - 3, o.y + inset, o.x + o.w - 3, o.y + o.h - inset, T5);
  } else {
    line(g, o.x + inset, o.y + 3, o.x + o.w - inset, o.y + 3, T5);
    line(g, o.x + inset, o.y + o.h - 3, o.x + o.w - inset, o.y + o.h - 3, T5);
  }
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
  const chair = Math.min(28, Math.max(18, Math.min(o.w, o.h) * 0.36));
  const tableRect = horizontal
    ? { x: o.x + 4, y: o.y + chair * 0.48, w: o.w - 8, h: o.h - chair * 0.96 }
    : { x: o.x + chair * 0.48, y: o.y + 4, w: o.w - chair * 0.96, h: o.h - 8 };

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

  // A few authored objects stop the table reading as an empty rounded box.
  if (horizontal) {
    paper(g, tableRect.x + tableRect.w * 0.18, tableRect.y + tableRect.h * 0.22, tableRect.w * 0.18, tableRect.h * 0.5);
    paper(g, tableRect.x + tableRect.w * 0.52, tableRect.y + tableRect.h * 0.18, tableRect.w * 0.2, tableRect.h * 0.46);
    cup(g, tableRect.x + tableRect.w * 0.82, tableRect.y + tableRect.h * 0.62, Math.max(1.4, tableRect.h * 0.08));
  } else {
    paper(g, tableRect.x + tableRect.w * 0.2, tableRect.y + tableRect.h * 0.16, tableRect.w * 0.54, tableRect.h * 0.18);
    paper(g, tableRect.x + tableRect.w * 0.26, tableRect.y + tableRect.h * 0.52, tableRect.w * 0.5, tableRect.h * 0.2);
    cup(g, tableRect.x + tableRect.w * 0.35, tableRect.y + tableRect.h * 0.82, Math.max(1.4, tableRect.w * 0.08));
  }
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
    const seatW = (o.w - 12) / seats;
    for (let i = 0; i < seats; i += 1) {
      g.roundRect(o.x + 6 + seatW * i + 1.5, o.y + 7, seatW - 3, o.h - 11, 2).stroke(T5);
    }
  } else {
    line(g, o.x + 2, o.y + 6, o.x + o.w - 2, o.y + 6, T4);
    line(g, o.x + 2, o.y + o.h - 6, o.x + o.w - 2, o.y + o.h - 6, T4);
    const seats = Math.max(2, Math.round((o.h - 12) / 44));
    const seatH = (o.h - 12) / seats;
    for (let i = 0; i < seats; i += 1) {
      g.roundRect(o.x + 7, o.y + 6 + seatH * i + 1.5, o.w - 11, seatH - 3, 2).stroke(T5);
    }
  }

  cornerFeet(g, o.x, o.y, o.w, o.h);
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

  // End supports and mounting feet are the cues used by the reference benches.
  if (o.w >= o.h) {
    g.rect(o.x + o.w * 0.12, o.y + o.h - 3, o.w * 0.08, 3).stroke(T5);
    g.rect(o.x + o.w * 0.8, o.y + o.h - 3, o.w * 0.08, 3).stroke(T5);
  } else {
    g.rect(o.x + o.w - 3, o.y + o.h * 0.12, 3, o.h * 0.08).stroke(T5);
    g.rect(o.x + o.w - 3, o.y + o.h * 0.8, 3, o.h * 0.08).stroke(T5);
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
  const seat = Math.min(28, Math.max(20, Math.min(o.w, o.h) * 0.5));
  if (alongX) {
    const cy = chairSide === "S" ? desk.y + desk.h - 4 : desk.y - seat + 4;
    chairGlyph(g, { ...o, x: o.x + o.w / 2 - seat / 2, y: cy, w: seat, h: seat, facing: chairSide === "S" ? "N" : "S" });
  } else {
    const cx = chairSide === "E" ? desk.x + desk.w - 4 : desk.x - seat + 4;
    chairGlyph(g, { ...o, x: cx, y: o.y + o.h / 2 - seat / 2, w: seat, h: seat, facing: chairSide === "E" ? "W" : "E" });
  }

  body(g, desk.x, desk.y, desk.w, desk.h, T3, 1);

  // Monitor, keyboard, paper and cup make this read as an occupied workstation.
  if (alongX) {
    const my = chairSide === "S" ? desk.y + 5 : desk.y + desk.h - 8;
    g.rect(o.x + o.w / 2 - 11, my, 22, 3).stroke(T4);
    g.rect(o.x + o.w / 2 - 9, chairSide === "S" ? desk.y + desk.h - 9 : desk.y + 5, 18, 4).stroke(T5);
    paper(g, desk.x + 5, desk.y + desk.h * 0.25, Math.min(14, desk.w * 0.22), Math.min(10, desk.h * 0.42));
    cup(g, desk.x + desk.w - 7, desk.y + desk.h / 2, Math.max(1.3, Math.min(desk.w, desk.h) * 0.07));
  } else {
    const mx = chairSide === "E" ? desk.x + 5 : desk.x + desk.w - 8;
    g.rect(mx, o.y + o.h / 2 - 11, 3, 22).stroke(T4);
    g.rect(chairSide === "E" ? desk.x + desk.w - 9 : desk.x + 5, o.y + o.h / 2 - 9, 4, 18).stroke(T5);
    paper(g, desk.x + desk.w * 0.3, desk.y + 5, Math.min(10, desk.w * 0.42), Math.min(14, desk.h * 0.22));
    cup(g, desk.x + desk.w / 2, desk.y + desk.h - 7, Math.max(1.3, Math.min(desk.w, desk.h) * 0.07));
  }
}

function counterGlyph(g: Graphics, o: MapObject): void {
  if (o.visualStyle === "retail") {
    drawRetailCounter(g, o);
    return;
  }
  body(g, o.x, o.y, o.w, o.h, T3);
  // Front edge line — counters read as built-in millwork, not tables.
  if (o.w >= o.h) {
    line(g, o.x, o.y + o.h - 3, o.x + o.w, o.y + o.h - 3, T5);
  } else {
    line(g, o.x + o.w - 3, o.y, o.x + o.w - 3, o.y + o.h, T5);
  }

  const run = o.w >= o.h ? o.w : o.h;
  const bays = Math.max(2, Math.round(run / 36));
  for (let index = 1; index < bays; index += 1) {
    if (o.w >= o.h) line(g, o.x + (o.w / bays) * index, o.y + 2, o.x + (o.w / bays) * index, o.y + o.h - 3, T5);
    else line(g, o.x + 2, o.y + (o.h / bays) * index, o.x + o.w - 3, o.y + (o.h / bays) * index, T5);
  }
  for (let index = 0; index < bays; index += 1) {
    if (o.w >= o.h) g.circle(o.x + (o.w / bays) * (index + 0.5), o.y + o.h - 6, 1).stroke(T5);
    else g.circle(o.x + o.w - 6, o.y + (o.h / bays) * (index + 0.5), 1).stroke(T5);
  }
}

function receptionDeskGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  g.rect(o.x + 4, o.y + 4, o.w - 8, o.h - 8).stroke(T5);
  const horizontal = o.w >= o.h;
  if (horizontal) {
    g.rect(o.x + o.w * 0.42, o.y + 5, o.w * 0.22, 4).stroke(T4);
    paper(g, o.x + o.w * 0.14, o.y + o.h * 0.32, o.w * 0.18, o.h * 0.38);
  } else {
    g.rect(o.x + 5, o.y + o.h * 0.42, 4, o.h * 0.22).stroke(T4);
    paper(g, o.x + o.w * 0.32, o.y + o.h * 0.14, o.w * 0.38, o.h * 0.18);
  }
}

function shelfGlyph(g: Graphics, o: MapObject): void {
  if (o.visualStyle === "retail") {
    drawRetailShelf(g, o);
    return;
  }
  body(g, o.x, o.y, o.w, o.h, T3);

  // Center spine + bay divisions along the run.
  if (o.w >= o.h) {
    line(g, o.x, o.y + o.h / 2, o.x + o.w, o.y + o.h / 2, T4);
    const bays = Math.max(2, Math.round(o.w / 30));
    for (let i = 1; i < bays; i += 1) {
      line(g, o.x + (o.w / bays) * i, o.y, o.x + (o.w / bays) * i, o.y + o.h, T5);
    }
    for (let i = 0; i < bays; i += 1) {
      const bx = o.x + (o.w / bays) * i;
      g.rect(bx + 3, o.y + 3, Math.max(2, o.w / bays - 7), Math.max(2, o.h * (0.22 + (i % 3) * 0.08))).stroke(T5);
      g.rect(bx + 4, o.y + o.h * 0.58, Math.max(2, o.w / bays - 9), Math.max(2, o.h * 0.2)).stroke(T5);
    }
  } else {
    line(g, o.x + o.w / 2, o.y, o.x + o.w / 2, o.y + o.h, T4);
    const bays = Math.max(2, Math.round(o.h / 30));
    for (let i = 1; i < bays; i += 1) {
      line(g, o.x, o.y + (o.h / bays) * i, o.x + o.w, o.y + (o.h / bays) * i, T5);
    }
    for (let i = 0; i < bays; i += 1) {
      const by = o.y + (o.h / bays) * i;
      g.rect(o.x + 3, by + 3, Math.max(2, o.w * (0.22 + (i % 3) * 0.08)), Math.max(2, o.h / bays - 7)).stroke(T5);
      g.rect(o.x + o.w * 0.58, by + 4, Math.max(2, o.w * 0.2), Math.max(2, o.h / bays - 9)).stroke(T5);
    }
  }
}

/** Open produce bins with one shallow front-panel band. The contents are
 * diagrammatic top-down marks; no line extends beyond the solid footprint. */
function produceDisplayGlyph(g: Graphics, o: MapObject): void {
  if (o.visualStyle === "retail") {
    drawRetailProduceDisplay(g, o);
    return;
  }
  body(g, o.x, o.y, o.w, o.h, T3, 3);
  const horizontal = o.w >= o.h;
  const frontDepth = Math.max(12, (horizontal ? o.h : o.w) * 0.18);
  const bins = horizontal
    ? { x: o.x + 5, y: o.y + 5, w: o.w - 10, h: o.h - frontDepth - 8 }
    : { x: o.x + frontDepth + 3, y: o.y + 5, w: o.w - frontDepth - 8, h: o.h - 10 };
  const cols = horizontal ? 4 : 2;
  const rows = horizontal ? 2 : 4;
  const cellW = bins.w / cols;
  const cellH = bins.h / rows;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const x = bins.x + col * cellW;
      const y = bins.y + row * cellH;
      g.rect(x + 1, y + 1, cellW - 2, cellH - 2).stroke(T4);
      const cx = x + cellW / 2;
      const cy = y + cellH / 2;

      if (index % 3 === 0) {
        for (const [dx, dy] of [[-0.2, -0.18], [0.18, -0.2], [-0.17, 0.2], [0.2, 0.18]]) {
          g.circle(cx + cellW * dx, cy + cellH * dy, Math.max(1.8, Math.min(cellW, cellH) * 0.1)).stroke(T5);
        }
      } else if (index % 3 === 1) {
        for (let item = -1; item <= 1; item += 1) {
          line(g, cx - cellW * 0.22, cy + item * cellH * 0.18, cx + cellW * 0.2, cy + item * cellH * 0.1, T5);
          line(g, cx + cellW * 0.2, cy + item * cellH * 0.1, cx + cellW * 0.28, cy + item * cellH * 0.02, T5);
        }
      } else {
        for (let item = -1; item <= 1; item += 1) {
          g.roundRect(cx + item * cellW * 0.2 - cellW * 0.07, cy - cellH * 0.24, cellW * 0.14, cellH * 0.48, 1).stroke(T5);
        }
      }
    }
  }

  if (horizontal) {
    line(g, o.x + 2, o.y + o.h - frontDepth, o.x + o.w - 2, o.y + o.h - frontDepth, T4);
    const drawers = 6;
    for (let index = 1; index < drawers; index += 1) {
      line(g, o.x + (o.w / drawers) * index, o.y + o.h - frontDepth + 2, o.x + (o.w / drawers) * index, o.y + o.h - 2, T5);
    }
  } else {
    line(g, o.x + frontDepth, o.y + 2, o.x + frontDepth, o.y + o.h - 2, T4);
    const drawers = 6;
    for (let index = 1; index < drawers; index += 1) {
      line(g, o.x + 2, o.y + (o.h / drawers) * index, o.x + frontDepth - 2, o.y + (o.h / drawers) * index, T5);
    }
  }
}

function floorTilesGlyph(g: Graphics, o: MapObject): void {
  const tile = 72;
  const gridStroke = { color: INK.hairline, width: 0.55, alpha: 0.32 };
  for (let x = o.x + tile; x < o.x + o.w; x += tile) {
    line(g, x, o.y, x, o.y + o.h, gridStroke);
  }
  for (let y = o.y + tile; y < o.y + o.h; y += tile) {
    line(g, o.x, y, o.x + o.w, y, gridStroke);
  }
}

function cabinetGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T4);
  // Double doors split on the long axis.
  if (o.w >= o.h) {
    line(g, o.x + o.w / 2, o.y + 1, o.x + o.w / 2, o.y + o.h - 1, T5);
    line(g, o.x + o.w / 2 - 3, o.y + o.h / 2, o.x + o.w / 2 - 1, o.y + o.h / 2, T4);
    line(g, o.x + o.w / 2 + 1, o.y + o.h / 2, o.x + o.w / 2 + 3, o.y + o.h / 2, T4);
  } else {
    line(g, o.x + 1, o.y + o.h / 2, o.x + o.w - 1, o.y + o.h / 2, T5);
    line(g, o.x + o.w / 2, o.y + o.h / 2 - 3, o.x + o.w / 2, o.y + o.h / 2 - 1, T4);
    line(g, o.x + o.w / 2, o.y + o.h / 2 + 1, o.x + o.w / 2, o.y + o.h / 2 + 3, T4);
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
  body(g, o.x, o.y, o.w, o.h, T3);
  const vertical = o.h >= o.w;
  const drawers = 3;
  for (let i = 0; i < drawers; i += 1) {
    if (vertical) {
      if (i > 0) line(g, o.x + 1, o.y + (o.h / drawers) * i, o.x + o.w - 1, o.y + (o.h / drawers) * i, T5);
      const cy = o.y + (o.h / drawers) * (i + 0.5);
      line(g, o.x + o.w * 0.35, cy, o.x + o.w * 0.65, cy, T4);
      g.rect(o.x + o.w * 0.38, cy - 4, o.w * 0.24, 2.5).stroke(T5);
    } else {
      if (i > 0) line(g, o.x + (o.w / drawers) * i, o.y + 1, o.x + (o.w / drawers) * i, o.y + o.h - 1, T5);
      const cx = o.x + (o.w / drawers) * (i + 0.5);
      line(g, cx, o.y + o.h * 0.35, cx, o.y + o.h * 0.65, T4);
      g.rect(cx - 1.25, o.y + o.h * 0.38, 2.5, o.h * 0.24).stroke(T5);
    }
  }
}

function lockerGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  const vertical = o.h >= o.w;
  const run = vertical ? o.h : o.w;
  const doors = Math.max(2, Math.min(4, Math.round(run / 28)));
  // Individual doors, vent pairs and handles turn the generic box into a locker bank.
  if (vertical) {
    for (let index = 0; index < doors; index += 1) {
      const y = o.y + (o.h / doors) * index;
      if (index > 0) line(g, o.x + 1, y, o.x + o.w - 1, y, T5);
      line(g, o.x + 4, y + 5, o.x + o.w - 4, y + 5, T5);
      line(g, o.x + 4, y + 8, o.x + o.w - 4, y + 8, T5);
      g.circle(o.x + o.w - 5, y + (o.h / doors) * 0.62, 1).stroke(T4);
    }
  } else {
    for (let index = 0; index < doors; index += 1) {
      const x = o.x + (o.w / doors) * index;
      if (index > 0) line(g, x, o.y + 1, x, o.y + o.h - 1, T5);
      line(g, x + 5, o.y + 4, x + 5, o.y + o.h - 4, T5);
      line(g, x + 8, o.y + 4, x + 8, o.y + o.h - 4, T5);
      g.circle(x + (o.w / doors) * 0.62, o.y + o.h - 5, 1).stroke(T4);
    }
  }
}

function bayConsoleGlyph(g: Graphics, o: MapObject): void {
  const approach = o.facing ?? (o.w >= o.h ? "S" : "E");
  const wall = opposite(approach);
  const alongX = approach === "N" || approach === "S";
  const depth = (alongX ? o.h : o.w) * 0.62;
  const consoleRect = sideStrip(o, wall, depth, 1);
  const chairSize = Math.min(30, (alongX ? o.h : o.w) - 4);

  // Chair first; the console overlaps its leading edge like the reference desks.
  if (alongX) {
    const cy = approach === "S" ? o.y + o.h - chairSize : o.y;
    chairGlyph(g, { ...o, x: o.x + o.w / 2 - chairSize / 2, y: cy, w: chairSize, h: chairSize, facing: opposite(approach) });
  } else {
    const cx = approach === "E" ? o.x + o.w - chairSize : o.x;
    chairGlyph(g, { ...o, x: cx, y: o.y + o.h / 2 - chairSize / 2, w: chairSize, h: chairSize, facing: opposite(approach) });
  }

  body(g, consoleRect.x, consoleRect.y, consoleRect.w, consoleRect.h, T3, 2);
  if (alongX) {
    const screenY = wall === "N" ? consoleRect.y + 4 : consoleRect.y + consoleRect.h - 10;
    g.roundRect(consoleRect.x + consoleRect.w * 0.18, screenY, consoleRect.w * 0.28, 6, 1).stroke(T4);
    g.roundRect(consoleRect.x + consoleRect.w * 0.54, screenY, consoleRect.w * 0.28, 6, 1).stroke(T4);
    g.rect(consoleRect.x + consoleRect.w * 0.28, wall === "N" ? consoleRect.y + consoleRect.h - 7 : consoleRect.y + 3, consoleRect.w * 0.44, 4).stroke(T5);
    for (let index = 0; index < 3; index += 1) g.circle(consoleRect.x + consoleRect.w * (0.2 + index * 0.1), consoleRect.y + consoleRect.h / 2, 1.2).stroke(T5);
  } else {
    const screenX = wall === "W" ? consoleRect.x + 4 : consoleRect.x + consoleRect.w - 10;
    g.roundRect(screenX, consoleRect.y + consoleRect.h * 0.18, 6, consoleRect.h * 0.28, 1).stroke(T4);
    g.roundRect(screenX, consoleRect.y + consoleRect.h * 0.54, 6, consoleRect.h * 0.28, 1).stroke(T4);
    g.rect(wall === "W" ? consoleRect.x + consoleRect.w - 7 : consoleRect.x + 3, consoleRect.y + consoleRect.h * 0.28, 4, consoleRect.h * 0.44).stroke(T5);
    for (let index = 0; index < 3; index += 1) g.circle(consoleRect.x + consoleRect.w / 2, consoleRect.y + consoleRect.h * (0.2 + index * 0.1), 1.2).stroke(T5);
  }
}

function toolCabinetGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  line(g, o.x + 1, o.y + o.h / 2, o.x + o.w - 1, o.y + o.h / 2, T5);
  line(g, o.x + o.w / 2, o.y + o.h / 2, o.x + o.w / 2, o.y + o.h - 1, T5);
  line(g, o.x + o.w * 0.24, o.y + o.h * 0.24, o.x + o.w * 0.45, o.y + o.h * 0.4, T4);
  line(g, o.x + o.w * 0.58, o.y + o.h * 0.4, o.x + o.w * 0.78, o.y + o.h * 0.2, T4);
  for (const fx of [0.25, 0.75]) line(g, o.x + o.w * fx - 3, o.y + o.h * 0.72, o.x + o.w * fx + 3, o.y + o.h * 0.72, T4);
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

function serverRackGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3);
  const vertical = o.h >= o.w;
  const slots = Math.max(3, Math.floor((vertical ? o.h : o.w) / 12));
  for (let i = 0; i < slots; i += 1) {
    if (vertical) {
      const y = o.y + (o.h / slots) * i;
      if (i > 0) line(g, o.x + 3, y, o.x + o.w - 3, y, T5);
      g.circle(o.x + 6, y + o.h / slots / 2, 1).stroke(T5);
      line(g, o.x + o.w * 0.36, y + o.h / slots / 2, o.x + o.w - 5, y + o.h / slots / 2, T5);
    } else {
      const x = o.x + (o.w / slots) * i;
      if (i > 0) line(g, x, o.y + 3, x, o.y + o.h - 3, T5);
      g.circle(x + o.w / slots / 2, o.y + 6, 1).stroke(T5);
      line(g, x + o.w / slots / 2, o.y + o.h * 0.36, x + o.w / slots / 2, o.y + o.h - 5, T5);
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
  if (o.visualStyle === "retail") {
    drawRetailCooler(g, o);
    return;
  }
  body(g, o.x, o.y, o.w, o.h, T3);
  const hinge = o.facing ?? "N";

  // Long refrigerator runs are retail glass-door coolers. Their stocked
  // shelves and door frames stay entirely inside the solid authored bounds,
  // preserving a literal plan-view footprint while making the fixture read at
  // normal play zoom.
  if (Math.max(o.w, o.h) >= 90) {
    const horizontal = hinge === "N" || hinge === "S";
    const run = horizontal ? o.w : o.h;
    const bays = Math.max(2, Math.round(run / 48));
    const bay = run / bays;

    for (let index = 0; index < bays; index += 1) {
      if (horizontal) {
        const x = o.x + bay * index;
        if (index > 0) line(g, x, o.y + 2, x, o.y + o.h - 2, T4);
        g.rect(x + 4, o.y + 4, bay - 8, o.h - 8).stroke(T5);
        line(g, x + 5, o.y + o.h * 0.5, x + bay - 5, o.y + o.h * 0.5, T5);
        for (let item = 0; item < 3; item += 1) {
          const cx = x + bay * (0.24 + item * 0.26);
          g.rect(cx - 2, o.y + 9, 4, Math.max(5, o.h * 0.2 + ((index + item) % 2) * 3)).stroke(T5);
          g.circle(cx, o.y + o.h * 0.69, Math.max(1.5, Math.min(3, bay * 0.07))).stroke(T5);
        }
        const handleY = hinge === "S" ? o.y + o.h - 8 : o.y + 8;
        line(g, x + bay - 7, handleY - 3, x + bay - 7, handleY + 3, T4);
      } else {
        const y = o.y + bay * index;
        if (index > 0) line(g, o.x + 2, y, o.x + o.w - 2, y, T4);
        g.rect(o.x + 4, y + 4, o.w - 8, bay - 8).stroke(T5);
        line(g, o.x + o.w * 0.5, y + 5, o.x + o.w * 0.5, y + bay - 5, T5);
        for (let item = 0; item < 3; item += 1) {
          const cy = y + bay * (0.24 + item * 0.26);
          g.rect(o.x + 8, cy - 2, Math.max(5, o.w * 0.2 + ((index + item) % 2) * 3), 4).stroke(T5);
          g.circle(o.x + o.w * 0.69, cy, Math.max(1.5, Math.min(3, bay * 0.07))).stroke(T5);
        }
        const handleX = hinge === "E" ? o.x + o.w - 8 : o.x + 8;
        line(g, handleX - 3, y + bay - 7, handleX + 3, y + bay - 7, T4);
      }
    }
    return;
  }

  // Door split: fridges read as a box with a door line + handle tick.
  if (hinge === "N" || hinge === "S") {
    const y = hinge === "N" ? o.y + o.h * 0.35 : o.y + o.h * 0.65;
    line(g, o.x + 1, y, o.x + o.w - 1, y, T5);
    line(g, o.x + o.w - 5, y + (hinge === "N" ? 4 : -4), o.x + o.w - 5, y + (hinge === "N" ? 10 : -10), T4);
  } else {
    const x = hinge === "W" ? o.x + o.w * 0.35 : o.x + o.w * 0.65;
    line(g, x, o.y + 1, x, o.y + o.h - 1, T5);
    line(g, x + (hinge === "W" ? 4 : -4), o.y + o.h - 5, x + (hinge === "W" ? 10 : -10), o.y + o.h - 5, T4);
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
  // Crates are solid anchors, never pale floor annotations. Their closed T3
  // outlines must carry the same visual promise as their collision boxes.
  body(g, o.x, o.y + o.h - s, s, s, T3);
  line(g, o.x, o.y + o.h - s, o.x + s, o.y + o.h, T4);
  line(g, o.x + s, o.y + o.h - s, o.x, o.y + o.h, T4);
  body(g, o.x + o.w - s, o.y, s, s, T3);
  line(g, o.x + o.w - s, o.y, o.x + o.w, o.y + s, T4);
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
  // Vice, drawers, tool silhouettes and a stool give the bench an authored footprint.
  if (o.w >= o.h) {
    g.rect(o.x + o.w - 10, o.y + o.h / 2 - 5, 8, 10).stroke(T4);
    line(g, o.x + 4, o.y + 5, o.x + o.w - 14, o.y + 5, T5);
    line(g, o.x + o.w * 0.18, o.y + o.h * 0.48, o.x + o.w * 0.32, o.y + o.h * 0.72, T4);
    g.circle(o.x + o.w * 0.5, o.y + o.h * 0.62, Math.max(1.5, o.h * 0.08)).stroke(T5);
    g.rect(o.x + 4, o.y + o.h - 10, o.w * 0.22, 7).stroke(T5);
  } else {
    g.rect(o.x + o.w / 2 - 5, o.y + o.h - 10, 10, 8).stroke(T4);
    line(g, o.x + 5, o.y + 4, o.x + 5, o.y + o.h - 14, T5);
    line(g, o.x + o.w * 0.48, o.y + o.h * 0.18, o.x + o.w * 0.72, o.y + o.h * 0.32, T4);
    g.circle(o.x + o.w * 0.62, o.y + o.h * 0.5, Math.max(1.5, o.w * 0.08)).stroke(T5);
    g.rect(o.x + o.w - 10, o.y + 4, 7, o.h * 0.22).stroke(T5);
  }
  cornerFeet(g, o.x, o.y, o.w, o.h);
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
  if (o.w >= o.h) {
    g.rect(o.x + 4, o.y + 4, o.w * 0.18, o.h - 8).stroke(T5);
    g.circle(o.x + o.w - 8, o.y + 8, 2).stroke(T5);
  } else {
    g.rect(o.x + 4, o.y + 4, o.w - 8, o.h * 0.18).stroke(T5);
    g.circle(o.x + 8, o.y + o.h - 8, 2).stroke(T5);
  }
  cornerFeet(g, o.x, o.y, o.w, o.h);
}

function fabricatorGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const horizontal = o.w >= o.h;
  const r = Math.min(o.w, o.h) * 0.25;
  // Central fabrication chamber, flanked by a control screen and material drawers.
  g.circle(cx, cy, r).stroke(T4);
  for (let index = 0; index < 6; index += 1) {
    const angle = (index * Math.PI) / 3;
    line(g, cx + Math.cos(angle) * r * 0.35, cy + Math.sin(angle) * r * 0.35, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, T5);
  }
  g.circle(cx, cy, r * 0.22).stroke(T5);
  if (horizontal) {
    g.roundRect(o.x + 5, o.y + 5, o.w * 0.2, o.h * 0.42, 1).stroke(T4);
    g.rect(o.x + 6, o.y + o.h * 0.62, o.w * 0.2, o.h * 0.18).stroke(T5);
    g.rect(o.x + o.w * 0.74, o.y + 5, o.w * 0.2, o.h - 10).stroke(T5);
    line(g, o.x + o.w * 0.75, o.y + o.h * 0.5, o.x + o.w * 0.93, o.y + o.h * 0.5, T5);
    g.circle(o.x + o.w * 0.16, o.y + o.h * 0.72, 1.1).stroke(T4);
  } else {
    g.roundRect(o.x + 5, o.y + 5, o.w * 0.42, o.h * 0.2, 1).stroke(T4);
    g.rect(o.x + o.w * 0.62, o.y + 6, o.w * 0.18, o.h * 0.2).stroke(T5);
    g.rect(o.x + 5, o.y + o.h * 0.74, o.w - 10, o.h * 0.2).stroke(T5);
    line(g, o.x + o.w * 0.5, o.y + o.h * 0.75, o.x + o.w * 0.5, o.y + o.h * 0.93, T5);
    g.circle(o.x + o.w * 0.72, o.y + o.h * 0.16, 1.1).stroke(T4);
  }
  cornerFeet(g, o.x, o.y, o.w, o.h);
}

function planningTableGlyph(g: Graphics, o: MapObject): void {
  const chair = Math.min(30, Math.max(26, Math.min(o.h * 0.4, o.w * 0.26)));
  const table = planningTableSurfaceRect(o);

  chairGlyph(g, { ...o, x: o.x + o.w * 0.28 - chair / 2, y: o.y, w: chair, h: chair, facing: "S" });
  chairGlyph(g, { ...o, x: o.x + o.w * 0.72 - chair / 2, y: o.y, w: chair, h: chair, facing: "S" });
  chairGlyph(g, { ...o, x: o.x + o.w * 0.28 - chair / 2, y: o.y + o.h - chair, w: chair, h: chair, facing: "N" });
  chairGlyph(g, { ...o, x: o.x + o.w * 0.72 - chair / 2, y: o.y + o.h - chair, w: chair, h: chair, facing: "N" });

  body(g, table.x, table.y, table.w, table.h, T3, 4);
  g.roundRect(table.x + 4, table.y + 4, table.w - 8, table.h - 8, 2).stroke(T5);
  paper(g, table.x + table.w * 0.13, table.y + table.h * 0.2, table.w * 0.24, table.h * 0.5);
  paper(g, table.x + table.w * 0.53, table.y + table.h * 0.16, table.w * 0.23, table.h * 0.42);
  line(g, table.x + table.w * 0.38, table.y + table.h * 0.72, table.x + table.w * 0.68, table.y + table.h * 0.62, T4);
  g.circle(table.x + table.w * 0.46, table.y + table.h * 0.68, 1.4).stroke(T4);
  cup(g, table.x + table.w * 0.84, table.y + table.h * 0.72, Math.max(1.3, table.h * 0.07));
}

function draftingTableGlyph(g: Graphics, o: MapObject): void {
  const approach = o.facing ?? (o.w >= o.h ? "S" : "E");
  const wall = opposite(approach);
  const alongX = approach === "N" || approach === "S";
  const chairSize = Math.min(30, Math.max(24, (alongX ? o.h : o.w) * 0.42));
  const tableDepth = (alongX ? o.h : o.w) * 0.7;
  const table = sideStrip(o, wall, tableDepth, 1);

  // One large operator chair makes this read as a work station, while the
  // oversized plan sheet separates it from the four-seat contracts table.
  if (alongX) {
    const y = approach === "S" ? o.y + o.h - chairSize : o.y;
    chairGlyph(g, { ...o, x: o.x + o.w / 2 - chairSize / 2, y, w: chairSize, h: chairSize, facing: opposite(approach) });
  } else {
    const x = approach === "E" ? o.x + o.w - chairSize : o.x;
    chairGlyph(g, { ...o, x, y: o.y + o.h / 2 - chairSize / 2, w: chairSize, h: chairSize, facing: opposite(approach) });
  }

  body(g, table.x, table.y, table.w, table.h, T3, 3);
  const px = table.x + Math.max(4, table.w * 0.08);
  const py = table.y + Math.max(4, table.h * 0.12);
  const pw = table.w - Math.max(8, table.w * 0.2);
  const ph = table.h - Math.max(8, table.h * 0.24);
  body(g, px, py, pw, ph, T5, 1);

  // A miniature floor plan and drafting tools on the sheet.
  g.rect(px + pw * 0.1, py + ph * 0.12, pw * 0.34, ph * 0.34).stroke(T5);
  g.rect(px + pw * 0.53, py + ph * 0.12, pw * 0.34, ph * 0.58).stroke(T5);
  line(g, px + pw * 0.1, py + ph * 0.58, px + pw * 0.43, py + ph * 0.58, T5);
  line(g, px + pw * 0.26, py + ph * 0.12, px + pw * 0.26, py + ph * 0.46, T5);
  line(g, px + pw * 0.7, py + ph * 0.12, px + pw * 0.7, py + ph * 0.7, T5);
  line(g, px + pw * 0.06, py + ph * 0.84, px + pw * 0.54, py + ph * 0.75, T4);
  g.circle(px + pw * 0.82, py + ph * 0.84, Math.max(1.3, Math.min(pw, ph) * 0.06)).stroke(T4);
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
  if (o.visualStyle === "retail") {
    drawRetailShelf(g, o);
    return;
  }
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
  const machine = { x: o.x + 4, y: o.y + 5, w: o.w * 0.48, h: o.h - 10 };
  g.roundRect(machine.x, machine.y, machine.w, machine.h, 2).stroke(T4);
  g.rect(machine.x + 5, machine.y + 5, machine.w - 10, machine.h * 0.24).stroke(T5);
  g.circle(machine.x + machine.w * 0.34, machine.y + machine.h * 0.62, Math.max(1.4, machine.h * 0.08)).stroke(T5);
  g.circle(machine.x + machine.w * 0.66, machine.y + machine.h * 0.62, Math.max(1.4, machine.h * 0.08)).stroke(T5);
  const cupRadius = Math.max(2, Math.min(o.w, o.h) * 0.1);
  cup(g, o.x + o.w * 0.66, o.y + o.h * 0.36, cupRadius);
  cup(g, o.x + o.w * 0.82, o.y + o.h * 0.62, cupRadius);
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
  g.circle(cx, cy, r * 0.2).stroke(T5);
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI * 2 * i) / 8;
    const lx = cx + Math.cos(a) * r * 0.56;
    const ly = cy + Math.sin(a) * r * 0.56;
    g.ellipse(lx, ly, Math.max(1.8, r * 0.22), Math.max(1.1, r * 0.12)).stroke(T5);
    line(g, cx, cy, cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78, T5);
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
  if (o.visualStyle === "retail") {
    drawRetailKiosk(g, o);
    return;
  }
  body(g, o.x, o.y, o.w, o.h, T4, 2);
  g.roundRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8, 2).fill({ color: INK.plate, alpha: 0.45 });
  g.roundRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8, 2).stroke(T4);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const radius = Math.min(o.w, o.h) * 0.26;
  g.circle(cx, cy, radius).fill({ color: PAPER });
  g.circle(cx, cy, radius).stroke(T4);
  g.circle(cx, cy, radius * 0.42).stroke(T5);
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI / 2;
    line(g,
      cx + Math.cos(angle) * radius * 0.48,
      cy + Math.sin(angle) * radius * 0.48,
      cx + Math.cos(angle) * radius * 0.88,
      cy + Math.sin(angle) * radius * 0.88,
      T4,
    );
  }
  for (const [x, y] of [
    [o.x + 8, o.y + 8],
    [o.x + o.w - 8, o.y + 8],
    [o.x + 8, o.y + o.h - 8],
    [o.x + o.w - 8, o.y + o.h - 8],
  ]) g.circle(x, y, 1.5).stroke(T5);
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

function listeningPostGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  g.arc(cx, cy, Math.min(o.w, o.h) * 0.18, -Math.PI * 0.8, Math.PI * 0.8).stroke(T3);
  g.arc(cx, cy, Math.min(o.w, o.h) * 0.32, -Math.PI * 0.8, Math.PI * 0.8).stroke(T5);
  g.circle(cx, cy, 2).fill({ color: INK.structure });
}

function signalMastGlyph(g: Graphics, o: MapObject): void {
  body(g, o.x, o.y, o.w, o.h, T3, 2);
  const cx = o.x + o.w / 2;
  line(g, cx, o.y + 5, cx, o.y + o.h - 5, T3);
  line(g, cx, o.y + 7, cx - Math.min(12, o.w * 0.2), o.y + o.h - 7, T5);
  line(g, cx, o.y + 7, cx + Math.min(12, o.w * 0.2), o.y + o.h - 7, T5);
  g.arc(cx, o.y + 8, Math.min(8, o.w * 0.12), Math.PI, 0).stroke(T5);
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
  produceDisplay: produceDisplayGlyph,
  floorTiles: floorTilesGlyph,
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
  draftingTable: draftingTableGlyph,
  repairBench: repairBenchGlyph,
  listeningPost: listeningPostGlyph,
  signalMast: signalMastGlyph,
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
  body(outline, object.x, object.y, object.w, object.h, T3, object.kind === "planningTable" || object.kind === "draftingTable" || object.kind === "fabricator" ? 3 : 1);
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
  if (object.kind === "draftingTable") {
    detail.rect(x + 7, y + 7, w - 14, h - 14).stroke(T5);
    detail.rect(x + 12, y + 12, (w - 28) * 0.4, (h - 28) * 0.42).stroke(T5);
    detail.rect(x + w * 0.56, y + 12, (w - 28) * 0.34, h - 28).stroke(T5);
    line(detail, x + 12, y + h - 13, x + w * 0.5, y + h - 18, T4);
    return;
  }
  drawObject(detail, object);
}
