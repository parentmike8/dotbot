import type { Graphics } from "pixi.js";
import type { MapObject, Rect } from "@dotbot/game/types";
import { INK, PAPER, strokes } from "./style";

/**
 * One physical drawing scale for every retail fixture. Nothing in this file
 * stretches an independently-authored illustration: fixtures are assembled
 * from the same world-unit frames, packages, handles, and worktop marks.
 */
export const RETAIL_SCALE = {
  frame: 4,
  product: 10,
  productGap: 4,
  control: 6,
  cornerRadius: 3,
} as const;

type ProductKind = 0 | 1 | 2 | 3 | 4 | 5;

function body(g: Graphics, rect: Rect, radius: number = RETAIL_SCALE.cornerRadius): void {
  g.roundRect(rect.x, rect.y, rect.w, rect.h, radius).fill({ color: PAPER });
  g.roundRect(rect.x, rect.y, rect.w, rect.h, radius).stroke(strokes.anchor);
}

function line(g: Graphics, x1: number, y1: number, x2: number, y2: number, strong = false): void {
  g.moveTo(x1, y1).lineTo(x2, y2).stroke(strong ? strokes.fixture : strokes.hairline);
}

function inset(rect: Rect, amount: number): Rect {
  return {
    x: rect.x + amount,
    y: rect.y + amount,
    w: Math.max(0, rect.w - amount * 2),
    h: Math.max(0, rect.h - amount * 2),
  };
}

function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/** Part tops are deliberately orientation-neutral. A rack can rotate in plan
 * without turning its contents into side-view bottles or human-scale goods. */
function productTop(g: Graphics, cx: number, cy: number, kind: ProductKind): void {
  const size = RETAIL_SCALE.product;
  const half = size / 2;

  if (kind === 0) {
    g.circle(cx, cy, half).fill({ color: PAPER });
    g.circle(cx, cy, half).stroke(strokes.fixture);
    g.circle(cx, cy, half * 0.48).stroke(strokes.fixture);
    for (let index = 0; index < 3; index += 1) {
      const angle = -Math.PI / 2 + index * (Math.PI * 2 / 3);
      line(g, cx + Math.cos(angle) * half * 0.58, cy + Math.sin(angle) * half * 0.58,
        cx + Math.cos(angle) * half * 0.86, cy + Math.sin(angle) * half * 0.86);
    }
    return;
  }

  if (kind === 1) {
    g.roundRect(cx - half, cy - half * 0.72, size, half * 1.44, 2).fill({ color: PAPER });
    g.roundRect(cx - half, cy - half * 0.72, size, half * 1.44, 2).stroke(strokes.fixture);
    line(g, cx - half * 0.55, cy - 1.4, cx + half * 0.55, cy - 1.4);
    line(g, cx - half * 0.28, cy + 1.6, cx + half * 0.28, cy + 1.6);
    return;
  }

  if (kind === 2) {
    g.circle(cx, cy, half).fill({ color: PAPER });
    g.circle(cx, cy, half).stroke(strokes.fixture);
    const start = -Math.PI * 0.15;
    g.moveTo(cx + Math.cos(start) * half * 0.66, cy + Math.sin(start) * half * 0.66)
      .arc(cx, cy, half * 0.66, start, Math.PI * 1.45)
      .stroke(strokes.hairline);
    g.circle(cx, cy, half * 0.22).stroke(strokes.fixture);
    return;
  }

  if (kind === 3) {
    g.rect(cx - half, cy - half * 0.72, size, half * 1.44).fill({ color: PAPER });
    g.rect(cx - half, cy - half * 0.72, size, half * 1.44).stroke(strokes.fixture);
    g.rect(cx - 1.8, cy - 1.8, 3.6, 3.6).stroke(strokes.hairline);
    for (const offset of [-2.5, 2.5]) {
      g.circle(cx - half + 1.4, cy + offset, 0.7).fill({ color: INK.fixture });
      g.circle(cx + half - 1.4, cy + offset, 0.7).fill({ color: INK.fixture });
    }
    return;
  }

  if (kind === 4) {
    g.roundRect(cx - half * 0.58, cy - half, half * 1.16, size, half * 0.55).fill({ color: PAPER });
    g.roundRect(cx - half * 0.58, cy - half, half * 1.16, size, half * 0.55).stroke(strokes.fixture);
    g.circle(cx, cy - half * 0.45, 1.1).stroke(strokes.hairline);
    g.circle(cx, cy + half * 0.45, 1.1).stroke(strokes.hairline);
    return;
  }

  g.roundRect(cx - half, cy - half, size, size, 2).fill({ color: PAPER });
  g.roundRect(cx - half, cy - half, size, size, 2).stroke(strokes.fixture);
  for (const [dx, dy] of [[-2.2, 2], [0, -2.2], [2.2, 2]]) {
    line(g, cx, cy, cx + dx, cy + dy);
    g.circle(cx + dx, cy + dy, 0.8).stroke(strokes.hairline);
  }
}

export type RetailProductMark = {
  cx: number;
  cy: number;
  kind: ProductKind;
  size: number;
};

export function retailProductLayout(rect: Rect, seed: number): RetailProductMark[] {
  const step = RETAIL_SCALE.product + RETAIL_SCALE.productGap;
  const cols = Math.max(1, Math.floor((rect.w + RETAIL_SCALE.productGap) / step));
  const rows = Math.max(1, Math.floor((rect.h + RETAIL_SCALE.productGap) / step));
  const usedW = (cols - 1) * step + RETAIL_SCALE.product;
  const usedH = (rows - 1) * step + RETAIL_SCALE.product;
  const startX = rect.x + (rect.w - usedW) / 2 + RETAIL_SCALE.product / 2;
  const startY = rect.y + (rect.h - usedH) / 2 + RETAIL_SCALE.product / 2;
  const marks: RetailProductMark[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      marks.push({
        cx: startX + col * step,
        cy: startY + row * step,
        kind: ((seed + row * 5 + col * 3) % 6) as ProductKind,
        size: RETAIL_SCALE.product,
      });
    }
  }

  return marks;
}

function productField(g: Graphics, rect: Rect, seed: number): void {
  const marks = retailProductLayout(rect, seed);
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    // Larger displays keep a few deliberate open sockets. This avoids the
    // stamped-wallpaper repetition of a perfectly full human retail shelf.
    if (marks.length > 8 && (seed * 7 + index * 5) % 17 === 0) continue;
    productTop(g, mark.cx, mark.cy, mark.kind);
  }
}

function shelfLanes(g: Graphics, rect: Rect, seed: number): void {
  const horizontal = rect.w >= rect.h;
  const inner = inset(rect, RETAIL_SCALE.frame);
  const laneGap = RETAIL_SCALE.frame;

  if (horizontal) {
    const laneH = (inner.h - laneGap) / 2;
    const upper = { x: inner.x, y: inner.y, w: inner.w, h: laneH };
    const lower = { x: inner.x, y: inner.y + laneH + laneGap, w: inner.w, h: laneH };
    line(g, inner.x, inner.y + laneH + laneGap / 2, inner.x + inner.w, inner.y + laneH + laneGap / 2, true);
    productField(g, inset(upper, 2), seed);
    productField(g, inset(lower, 2), seed + 2);
  } else {
    const laneW = (inner.w - laneGap) / 2;
    const left = { x: inner.x, y: inner.y, w: laneW, h: inner.h };
    const right = { x: inner.x + laneW + laneGap, y: inner.y, w: laneW, h: inner.h };
    line(g, inner.x + laneW + laneGap / 2, inner.y, inner.x + laneW + laneGap / 2, inner.y + inner.h, true);
    productField(g, inset(left, 2), seed);
    productField(g, inset(right, 2), seed + 2);
  }
}

export function drawRetailShelf(g: Graphics, o: MapObject): void {
  body(g, o);
  g.roundRect(o.x + 3, o.y + 3, o.w - 6, o.h - 6, 1).stroke(strokes.fixture);
  shelfLanes(g, o, hashSeed(o.id) % 19);

  // Small mounting feet stay within the authored rectangle.
  const r = 1.5;
  for (const [x, y] of [
    [o.x + 4, o.y + 4],
    [o.x + o.w - 4, o.y + 4],
    [o.x + 4, o.y + o.h - 4],
    [o.x + o.w - 4, o.y + o.h - 4],
  ]) g.circle(x, y, r).stroke(strokes.hairline);
}

export function drawRetailCooler(g: Graphics, o: MapObject): void {
  body(g, o);
  const horizontal = o.w >= o.h;
  const run = horizontal ? o.w : o.h;
  const bayCount = Math.max(2, Math.round(run / 52));
  const bayRun = run / bayCount;
  const insetAmount = RETAIL_SCALE.frame;

  for (let index = 0; index < bayCount; index += 1) {
    const bay: Rect = horizontal
      ? { x: o.x + index * bayRun + insetAmount, y: o.y + insetAmount, w: bayRun - insetAmount * 2, h: o.h - insetAmount * 2 }
      : { x: o.x + insetAmount, y: o.y + index * bayRun + insetAmount, w: o.w - insetAmount * 2, h: bayRun - insetAmount * 2 };

    g.rect(bay.x, bay.y, bay.w, bay.h).fill({ color: index % 2 === 0 ? INK.glass : INK.plate, alpha: 0.62 });
    g.rect(bay.x, bay.y, bay.w, bay.h).stroke(strokes.fixture);
    productField(g, inset(bay, 5), index * 3 + hashSeed(o.id) % 11);

    // The door handle is a plan mark on the room-facing edge, never a front panel.
    if (horizontal) {
      const y = (o.facing ?? "S") === "N" ? bay.y + 4 : bay.y + bay.h - 4;
      line(g, bay.x + bay.w - 7, y, bay.x + bay.w - 2, y, true);
    } else {
      const x = (o.facing ?? "W") === "E" ? bay.x + bay.w - 4 : bay.x + 4;
      line(g, x, bay.y + bay.h - 7, x, bay.y + bay.h - 2, true);
    }
  }
}

export function drawRetailProduceDisplay(g: Graphics, o: MapObject): void {
  body(g, o, 4);
  const frame = RETAIL_SCALE.frame + 1;
  const inner = inset(o, frame);
  const cols = o.w >= o.h ? 4 : 3;
  const rows = o.w >= o.h ? 3 : 4;
  const cellW = inner.w / cols;
  const cellH = inner.h / rows;
  const rowSpans = o.w >= o.h
    ? [[2, 1, 1], [1, 1, 1, 1], [1, 1, 2]]
    : [[1, 1, 1], [2, 1], [1, 2], [1, 1, 1]];

  for (let row = 0; row < rows; row += 1) {
    let col = 0;
    for (const span of rowSpans[row]) {
      const cell = {
        x: inner.x + col * cellW + 2,
        y: inner.y + row * cellH + 2,
        w: cellW * span - 4,
        h: cellH - 4,
      };
      if ((row + col) % 3 === 0) {
        g.roundRect(cell.x, cell.y, cell.w, cell.h, 2).fill({ color: INK.plate, alpha: 0.72 });
      }
      g.roundRect(cell.x, cell.y, cell.w, cell.h, 2).stroke(strokes.fixture);
      const cellSeed = row * cols * 3 + col * 5 + span;
      productField(g, inset(cell, 5), cellSeed);
      if ((row + col) % 4 === 1) {
        line(g, cell.x + 5, cell.y + cell.h - 5, cell.x + cell.w - 5, cell.y + cell.h - 5);
        for (let pin = 0; pin < 3; pin += 1) {
          g.circle(cell.x + 8 + pin * 6, cell.y + cell.h - 5, 1).stroke(strokes.hairline);
        }
      }
      col += span;
    }
  }
}

function serviceDock(g: Graphics, rect: Rect): void {
  const dock = inset(rect, 5);
  g.roundRect(dock.x, dock.y, dock.w, dock.h, 4).fill({ color: INK.plate, alpha: 0.7 });
  g.roundRect(dock.x, dock.y, dock.w, dock.h, 4).stroke(strokes.fixture);
  const cx = dock.x + dock.w / 2;
  const cy = dock.y + dock.h / 2;
  const radius = Math.min(dock.w, dock.h) * 0.28;
  g.circle(cx, cy, radius).stroke(strokes.fixture);
  g.circle(cx, cy, radius * 0.45).stroke(strokes.hairline);
  for (let index = 0; index < 3; index += 1) {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / 3);
    line(g, cx + Math.cos(angle) * radius * 0.55, cy + Math.sin(angle) * radius * 0.55,
      cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, true);
  }
}

function register(g: Graphics, rect: Rect): void {
  const screen = { x: rect.x + 5, y: rect.y + 5, w: rect.w * 0.48, h: rect.h - 10 };
  g.roundRect(screen.x, screen.y, screen.w, screen.h, 2).fill({ color: INK.glass, alpha: 0.5 });
  g.roundRect(screen.x, screen.y, screen.w, screen.h, 2).stroke(strokes.fixture);
  const keyX = rect.x + rect.w * 0.62;
  const keyY = rect.y + rect.h * 0.28;
  const key = RETAIL_SCALE.control;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      g.roundRect(keyX + col * (key + 2), keyY + row * (key + 2), key, key, 1).stroke(strokes.hairline);
    }
  }
}

function counterWorktop(g: Graphics, rect: Rect): void {
  const module = Math.min(64, rect.w * 0.24);
  serviceDock(g, { x: rect.x + 5, y: rect.y + 5, w: module, h: rect.h - 10 });
  const trays = { x: rect.x + module + 10, y: rect.y + 6, w: module, h: rect.h - 12 };
  g.rect(trays.x, trays.y, trays.w, trays.h).stroke(strokes.fixture);
  productField(g, inset(trays, 5), 1);
  const prepX = trays.x + trays.w + 8;
  const deck = { x: prepX, y: rect.y + 7, w: rect.x + rect.w - prepX - 7, h: rect.h - 14 };
  g.roundRect(deck.x, deck.y, deck.w, deck.h, 2).fill({ color: INK.plate, alpha: 0.55 });
  g.roundRect(deck.x, deck.y, deck.w, deck.h, 2).stroke(strokes.fixture);
  const midY = deck.y + deck.h / 2;
  line(g, deck.x + 7, midY, deck.x + deck.w - 7, midY, true);
  for (let index = 0; index < 4; index += 1) {
    const x = deck.x + 12 + index * Math.max(12, (deck.w - 24) / 3);
    g.circle(x, midY, 2.3).stroke(strokes.hairline);
    line(g, x, deck.y + 6, x, deck.y + deck.h - 6);
  }
}

function counterRegisterRun(g: Graphics, rect: Rect): void {
  const reg = { x: rect.x + 5, y: rect.y + rect.h * 0.42, w: rect.w - 10, h: Math.min(72, rect.h * 0.4) };
  register(g, reg);
  const belt = { x: rect.x + 7, y: rect.y + 7, w: rect.w - 14, h: Math.max(30, reg.y - rect.y - 16) };
  g.roundRect(belt.x, belt.y, belt.w, belt.h, 2).stroke(strokes.fixture);
  for (let y = belt.y + 6; y < belt.y + belt.h; y += 7) line(g, belt.x + 3, y, belt.x + belt.w - 3, y);
  const terminal = { x: rect.x + rect.w * 0.58, y: reg.y + reg.h + 8, w: rect.w * 0.28, h: 28 };
  g.roundRect(terminal.x, terminal.y, terminal.w, terminal.h, 2).stroke(strokes.fixture);
  g.rect(terminal.x + 4, terminal.y + 4, terminal.w - 8, 8).fill({ color: INK.glass, alpha: 0.5 });
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      g.circle(terminal.x + 6 + col * 7, terminal.y + 18 + row * 6, 1.4).stroke(strokes.hairline);
    }
  }
}

function counterDisplayRun(g: Graphics, rect: Rect): void {
  const inner = inset(rect, 6);
  const modules = Math.max(3, Math.floor(inner.w / 48));
  const moduleW = inner.w / modules;
  for (let index = 0; index < modules; index += 1) {
    const module = { x: inner.x + index * moduleW + 2, y: inner.y + 2, w: moduleW - 4, h: inner.h - 4 };
    g.roundRect(module.x, module.y, module.w, module.h, 2).stroke(strokes.fixture);
    productField(g, inset(module, 5), index + 2);
  }
}

export function drawRetailCounter(g: Graphics, o: MapObject): void {
  if (o.collisionParts?.length === 3) {
    const [topPart, leftPart, bottomPart] = o.collisionParts;
    const top = { x: o.x + topPart.x, y: o.y + topPart.y, w: topPart.w, h: topPart.h };
    const left = { x: o.x + leftPart.x, y: o.y + leftPart.y, w: leftPart.w, h: leftPart.h };
    const bottom = { x: o.x + bottomPart.x, y: o.y + bottomPart.y, w: bottomPart.w, h: bottomPart.h };
    const innerX = left.x + left.w;
    const points = [
      top.x, top.y,
      top.x + top.w, top.y,
      top.x + top.w, top.y + top.h,
      innerX, top.y + top.h,
      innerX, bottom.y,
      bottom.x + bottom.w, bottom.y,
      bottom.x + bottom.w, bottom.y + bottom.h,
      bottom.x, bottom.y + bottom.h,
      bottom.x, top.y,
    ];
    g.poly(points).fill({ color: PAPER });
    g.poly(points).stroke(strokes.anchor);
    line(g, innerX, top.y + top.h, top.x + top.w, top.y + top.h, true);
    line(g, innerX, top.y + top.h, innerX, bottom.y, true);
    line(g, innerX, bottom.y, bottom.x + bottom.w, bottom.y, true);
    counterWorktop(g, inset(top, 3));
    counterRegisterRun(g, inset(left, 3));
    counterDisplayRun(g, inset(bottom, 3));
    return;
  }

  body(g, o, 2);
  g.roundRect(o.x + 3, o.y + 3, o.w - 6, o.h - 6, 1).stroke(strokes.fixture);
  const horizontal = o.w >= o.h;
  const facing = o.facing ?? (horizontal ? "S" : "E");

  if (horizontal && facing === "S") {
    counterWorktop(g, o);
    return;
  }

  if (!horizontal) {
    counterRegisterRun(g, o);
    return;
  }

  counterDisplayRun(g, o);
}

export function drawRetailKiosk(g: Graphics, o: MapObject): void {
  body(g, o, 4);
  const inner = inset(o, 6);
  g.roundRect(inner.x, inner.y, inner.w, inner.h, 3).fill({ color: INK.plate, alpha: 0.5 });
  g.roundRect(inner.x, inner.y, inner.w, inner.h, 3).stroke(strokes.fixture);

  // Strict plan view: a circular service dock and radial clamps seen from
  // above. There is no upright screen, keypad, slot, or implied front face.
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  const radius = Math.min(inner.w, inner.h) * 0.27;
  g.circle(cx, cy, radius).fill({ color: PAPER });
  g.circle(cx, cy, radius).stroke(strokes.fixture);
  g.circle(cx, cy, radius * 0.42).stroke(strokes.hairline);
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI / 2;
    line(g,
      cx + Math.cos(angle) * radius * 0.48,
      cy + Math.sin(angle) * radius * 0.48,
      cx + Math.cos(angle) * radius * 0.88,
      cy + Math.sin(angle) * radius * 0.88,
      true,
    );
  }

  const socketOffsetX = inner.w * 0.38;
  const socketOffsetY = inner.h * 0.38;
  for (const [x, y] of [
    [cx - socketOffsetX, cy - socketOffsetY],
    [cx + socketOffsetX, cy - socketOffsetY],
    [cx - socketOffsetX, cy + socketOffsetY],
    [cx + socketOffsetX, cy + socketOffsetY],
  ]) {
    g.circle(x, y, 2).stroke(strokes.hairline);
  }
}
