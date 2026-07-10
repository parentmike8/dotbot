import type { Graphics } from "pixi.js";
import type { MapObject, ObjectKind } from "../types";

/**
 * Object glyph library: top-down architectural line art.
 *
 * Discipline: white (or near-white) fills so objects sit on top of floor
 * seams, ink outlines at width 2, interior detail at 1.25–1.5. No color —
 * color belongs to Dot Bots and Dots only.
 */

export const INK = {
  line: 0x1c1f24,
  soft: 0x565e66,
  faint: 0xb9c0c8,
  fill: 0xffffff,
  fillSoft: 0xf3f4f6,
  paper: 0xffffff,
} as const;

const stroke = (width = 2, color: number = INK.line) => ({ color, width });

type GlyphFn = (g: Graphics, o: MapObject) => void;

function outlined(g: Graphics, o: MapObject, radius = 3): void {
  g.roundRect(o.x, o.y, o.w, o.h, radius).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, radius).stroke(stroke());
}

/** Bed / cot: frame, pillow at the `facing` end, blanket fold across the middle. */
function bedGlyph(g: Graphics, o: MapObject, cot = false): void {
  outlined(g, o, cot ? 8 : 4);

  const vertical = o.h >= o.w;
  const pillowDepth = (vertical ? o.h : o.w) * 0.24;
  const inset = 5;

  if (vertical) {
    const pillowY = o.facing === "S" ? o.y + o.h - pillowDepth - inset : o.y + inset;
    g.roundRect(o.x + inset, pillowY, o.w - inset * 2, pillowDepth, 4).stroke(stroke(1.5));
    const foldY = o.facing === "S" ? o.y + o.h * 0.38 : o.y + o.h * 0.62;
    g.moveTo(o.x + 3, foldY).lineTo(o.x + o.w - 3, foldY).stroke(stroke(1.5));
    if (!cot) {
      g.moveTo(o.x + 3, foldY + 7).lineTo(o.x + o.w - 3, foldY + 7).stroke(stroke(1.25, INK.soft));
    }
  } else {
    const pillowX = o.facing === "E" ? o.x + o.w - pillowDepth - inset : o.x + inset;
    g.roundRect(pillowX, o.y + inset, pillowDepth, o.h - inset * 2, 4).stroke(stroke(1.5));
    const foldX = o.facing === "E" ? o.x + o.w * 0.38 : o.x + o.w * 0.62;
    g.moveTo(foldX, o.y + 3).lineTo(foldX, o.y + o.h - 3).stroke(stroke(1.5));
    if (!cot) {
      g.moveTo(foldX + 7, o.y + 3).lineTo(foldX + 7, o.y + o.h - 3).stroke(stroke(1.25, INK.soft));
    }
  }
}

/** Chair: seat with a back bar on the side opposite `facing`. */
function chairGlyph(g: Graphics, o: MapObject): void {
  g.roundRect(o.x, o.y, o.w, o.h, 5).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, 5).stroke(stroke(1.5));

  const facing = o.facing ?? "S";
  if (facing === "S") {
    g.moveTo(o.x + 2, o.y + 3).lineTo(o.x + o.w - 2, o.y + 3).stroke(stroke(1.5));
  } else if (facing === "N") {
    g.moveTo(o.x + 2, o.y + o.h - 3).lineTo(o.x + o.w - 2, o.y + o.h - 3).stroke(stroke(1.5));
  } else if (facing === "E") {
    g.moveTo(o.x + 3, o.y + 2).lineTo(o.x + 3, o.y + o.h - 2).stroke(stroke(1.5));
  } else {
    g.moveTo(o.x + o.w - 3, o.y + 2).lineTo(o.x + o.w - 3, o.y + o.h - 2).stroke(stroke(1.5));
  }
}

/** Desk with a tucked chair on the `facing` side. */
function deskGlyph(g: Graphics, o: MapObject): void {
  const chairSide = o.facing ?? "S";
  const deskH = o.h * 0.58;
  const deskY = chairSide === "S" ? o.y : o.y + o.h - deskH;

  g.roundRect(o.x, deskY, o.w, deskH, 3).fill({ color: INK.fill });
  g.roundRect(o.x, deskY, o.w, deskH, 3).stroke(stroke());
  // Monitor.
  g.rect(o.x + o.w / 2 - 11, deskY + deskH / 2 - 4, 22, 8).stroke(stroke(1.25));

  const chairSize = Math.min(24, o.h * 0.36);
  const chairY = chairSide === "S" ? o.y + o.h - chairSize : o.y;
  chairGlyph(g, {
    ...o,
    x: o.x + o.w / 2 - chairSize / 2,
    y: chairY,
    w: chairSize,
    h: chairSize,
    facing: chairSide === "S" ? "N" : "S",
  });
}

function tableGlyph(g: Graphics, o: MapObject): void {
  outlined(g, o, 8);
  const chairW = 20;
  for (const cx of [o.x + o.w * 0.3, o.x + o.w * 0.7]) {
    g.roundRect(cx - chairW / 2, o.y - 14, chairW, 11, 3).stroke(stroke(1.25));
    g.roundRect(cx - chairW / 2, o.y + o.h + 3, chairW, 11, 3).stroke(stroke(1.25));
  }
}

function conferenceTableGlyph(g: Graphics, o: MapObject): void {
  g.roundRect(o.x, o.y, o.w, o.h, o.h / 3).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, o.h / 3).stroke(stroke());

  const chairW = 18;
  const count = Math.max(2, Math.floor(o.w / 34));
  for (let i = 0; i < count; i += 1) {
    const cx = o.x + ((i + 0.5) * o.w) / count;
    g.roundRect(cx - chairW / 2, o.y - 13, chairW, 10, 3).stroke(stroke(1.25));
    g.roundRect(cx - chairW / 2, o.y + o.h + 3, chairW, 10, 3).stroke(stroke(1.25));
  }
  g.roundRect(o.x - 13, o.y + o.h / 2 - chairW / 2, 10, chairW, 3).stroke(stroke(1.25));
  g.roundRect(o.x + o.w + 3, o.y + o.h / 2 - chairW / 2, 10, chairW, 3).stroke(stroke(1.25));
}

function counterGlyph(g: Graphics, o: MapObject): void {
  outlined(g, o, 3);
  if (o.w >= o.h) {
    g.moveTo(o.x + 4, o.y + o.h / 2).lineTo(o.x + o.w - 4, o.y + o.h / 2).stroke(stroke(1.25));
  } else {
    g.moveTo(o.x + o.w / 2, o.y + 4).lineTo(o.x + o.w / 2, o.y + o.h - 4).stroke(stroke(1.25));
  }
}

function receptionDeskGlyph(g: Graphics, o: MapObject): void {
  outlined(g, o, 6);
  // Work surface line and a terminal.
  if (o.w >= o.h) {
    g.moveTo(o.x + 5, o.y + o.h * 0.45).lineTo(o.x + o.w - 5, o.y + o.h * 0.45).stroke(stroke(1.25));
    g.rect(o.x + o.w * 0.28 - 8, o.y + 5, 16, 7).stroke(stroke(1.25));
  } else {
    g.moveTo(o.x + o.w * 0.45, o.y + 5).lineTo(o.x + o.w * 0.45, o.y + o.h - 5).stroke(stroke(1.25));
    g.rect(o.x + 5, o.y + o.h * 0.28 - 8, 7, 16).stroke(stroke(1.25));
  }
}

function serverRackGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  const step = 8;
  if (o.h >= o.w) {
    for (let y = o.y + 6; y < o.y + o.h - 4; y += step) {
      g.moveTo(o.x + 4, y).lineTo(o.x + o.w - 4, y).stroke(stroke(1.25));
    }
  } else {
    for (let x = o.x + 6; x < o.x + o.w - 4; x += step) {
      g.moveTo(x, o.y + 4).lineTo(x, o.y + o.h - 4).stroke(stroke(1.25));
    }
  }
}

function shelfGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  if (o.h >= o.w) {
    const bays = Math.max(2, Math.round(o.h / 46));
    for (let i = 1; i < bays; i += 1) {
      const y = o.y + (i * o.h) / bays;
      g.moveTo(o.x, y).lineTo(o.x + o.w, y).stroke(stroke(1.25));
    }
    g.moveTo(o.x + o.w / 2, o.y + 2).lineTo(o.x + o.w / 2, o.y + o.h - 2).stroke(stroke(1, INK.soft));
  } else {
    const bays = Math.max(2, Math.round(o.w / 46));
    for (let i = 1; i < bays; i += 1) {
      const x = o.x + (i * o.w) / bays;
      g.moveTo(x, o.y).lineTo(x, o.y + o.h).stroke(stroke(1.25));
    }
    g.moveTo(o.x + 2, o.y + o.h / 2).lineTo(o.x + o.w - 2, o.y + o.h / 2).stroke(stroke(1, INK.soft));
  }
}

function drawerStack(g: Graphics, o: MapObject, drawers: number): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  for (let i = 1; i < drawers; i += 1) {
    const y = o.y + (i * o.h) / drawers;
    g.moveTo(o.x, y).lineTo(o.x + o.w, y).stroke(stroke(1.25));
  }
  for (let i = 0; i < drawers; i += 1) {
    const cy = o.y + ((i + 0.5) * o.h) / drawers;
    g.moveTo(o.x + o.w / 2 - 4, cy).lineTo(o.x + o.w / 2 + 4, cy).stroke(stroke(1.25));
  }
}

function cabinetGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  const mid = o.w >= o.h ? o.x + o.w / 2 : o.x + o.w / 2;
  g.moveTo(mid, o.y + 2).lineTo(mid, o.y + o.h - 2).stroke(stroke(1.25));
}

function medicalCabinetGlyph(g: Graphics, o: MapObject): void {
  cabinetGlyph(g, o);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  g.moveTo(cx, cy - 5).lineTo(cx, cy + 5).stroke(stroke(1.5));
  g.moveTo(cx - 5, cy).lineTo(cx + 5, cy).stroke(stroke(1.5));
}

function lockerGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  // Vent slits + handle.
  g.moveTo(o.x + 5, o.y + 7).lineTo(o.x + o.w - 5, o.y + 7).stroke(stroke(1));
  g.moveTo(o.x + 5, o.y + 12).lineTo(o.x + o.w - 5, o.y + 12).stroke(stroke(1));
  g.moveTo(o.x + o.w - 6, o.y + o.h * 0.55).lineTo(o.x + o.w - 6, o.y + o.h * 0.55 + 6).stroke(stroke(1.5));
}

function crateStackGlyph(g: Graphics, o: MapObject): void {
  const s = Math.min(o.w, o.h);
  g.rect(o.x, o.y + o.h - s, s, s).fill({ color: INK.fill });
  g.rect(o.x, o.y + o.h - s, s, s).stroke(stroke());
  g.moveTo(o.x, o.y + o.h - s).lineTo(o.x + s, o.y + o.h).stroke(stroke(1.25));
  g.moveTo(o.x + s, o.y + o.h - s).lineTo(o.x, o.y + o.h).stroke(stroke(1.25));

  const top = s * 0.72;
  g.rect(o.x + s * 0.5, o.y + o.h - s - top * 0.5, top, top).fill({ color: INK.fill });
  g.rect(o.x + s * 0.5, o.y + o.h - s - top * 0.5, top, top).stroke(stroke());
}

function workbenchGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  g.moveTo(o.x, o.y + o.h * 0.5).lineTo(o.x + o.w, o.y + o.h * 0.5).stroke(stroke(1.25));
  g.circle(o.x + 14, o.y + o.h * 0.27, 3.5).stroke(stroke(1.25));
  g.rect(o.x + o.w - 26, o.y + 5, 17, 6).stroke(stroke(1.25));
  g.moveTo(o.x + o.w * 0.4, o.y + 5).lineTo(o.x + o.w * 0.52, o.y + 9).stroke(stroke(1.25));
}

function generatorGlyph(g: Graphics, o: MapObject): void {
  g.roundRect(o.x, o.y, o.w, o.h, 4).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, 4).stroke(stroke());
  // Dial + hatched vent panel.
  g.circle(o.x + o.w * 0.26, o.y + o.h / 2, o.h * 0.24).stroke(stroke(1.5));
  g.moveTo(o.x + o.w * 0.26, o.y + o.h / 2)
    .lineTo(o.x + o.w * 0.26 + o.h * 0.17, o.y + o.h / 2 - o.h * 0.14)
    .stroke(stroke(1.25));
  for (let i = 0; i < 4; i += 1) {
    const x = o.x + o.w * 0.52 + i * 7;
    g.moveTo(x, o.y + 6).lineTo(x, o.y + o.h - 6).stroke(stroke(1.25));
  }
}

function utilityBoxGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke(1.5));
  g.rect(o.x + 4, o.y + 4, o.w - 8, o.h - 8).stroke(stroke(1));
}

function vendingGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  // Selection grid + tray slot.
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      g.rect(o.x + 5 + j * 8, o.y + 5 + i * 8, 5, 5).stroke(stroke(1));
    }
  }
  g.rect(o.x + 5, o.y + o.h - 9, o.w - 10, 5).stroke(stroke(1.25));
}

function fridgeGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke());
  const handleSide = o.facing === "W" ? o.x + 5 : o.x + o.w - 5;
  g.moveTo(handleSide, o.y + 6).lineTo(handleSide, o.y + o.h * 0.45).stroke(stroke(1.5));
  g.moveTo(o.x + 2, o.y + o.h * 0.55).lineTo(o.x + o.w - 2, o.y + o.h * 0.55).stroke(stroke(1.25));
}

function couchGlyph(g: Graphics, o: MapObject): void {
  g.roundRect(o.x, o.y, o.w, o.h, 8).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, 8).stroke(stroke());

  const facing = o.facing ?? "S";
  if (facing === "E" || facing === "W") {
    const backX = facing === "E" ? o.x + 5 : o.x + o.w - 5;
    g.moveTo(backX, o.y + 4).lineTo(backX, o.y + o.h - 4).stroke(stroke(1.5));
    g.moveTo(o.x + 3, o.y + o.h / 2).lineTo(o.x + o.w - 3, o.y + o.h / 2).stroke(stroke(1.25));
  } else {
    const backY = facing === "S" ? o.y + 5 : o.y + o.h - 5;
    g.moveTo(o.x + 4, backY).lineTo(o.x + o.w - 4, backY).stroke(stroke(1.5));
    g.moveTo(o.x + o.w / 2, o.y + 3).lineTo(o.x + o.w / 2, o.y + o.h - 3).stroke(stroke(1.25));
  }
}

function plantGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) / 2;
  g.circle(cx, cy, r).fill({ color: INK.fill });
  g.circle(cx, cy, r).stroke(stroke(1.5));
  for (let i = 0; i < 5; i += 1) {
    const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    g.moveTo(cx, cy)
      .lineTo(cx + Math.cos(angle) * r * 0.72, cy + Math.sin(angle) * r * 0.72)
      .stroke(stroke(1.25));
  }
}

function planterGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fill });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke(1.5));
  plantGlyph(g, { ...o, x: o.x + 4, y: o.y + 4, w: o.w - 8, h: o.h - 8 });
}

function benchGlyph(g: Graphics, o: MapObject): void {
  g.roundRect(o.x, o.y, o.w, o.h, 4).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, 4).stroke(stroke());
  if (o.w >= o.h) {
    g.moveTo(o.x + 3, o.y + o.h / 2).lineTo(o.x + o.w - 3, o.y + o.h / 2).stroke(stroke(1.25));
    g.moveTo(o.x + o.w * 0.33, o.y + 2).lineTo(o.x + o.w * 0.33, o.y + o.h - 2).stroke(stroke(1, INK.soft));
    g.moveTo(o.x + o.w * 0.66, o.y + 2).lineTo(o.x + o.w * 0.66, o.y + o.h - 2).stroke(stroke(1, INK.soft));
  } else {
    g.moveTo(o.x + o.w / 2, o.y + 3).lineTo(o.x + o.w / 2, o.y + o.h - 3).stroke(stroke(1.25));
    g.moveTo(o.x + 2, o.y + o.h * 0.33).lineTo(o.x + o.w - 2, o.y + o.h * 0.33).stroke(stroke(1, INK.soft));
    g.moveTo(o.x + 2, o.y + o.h * 0.66).lineTo(o.x + o.w - 2, o.y + o.h * 0.66).stroke(stroke(1, INK.soft));
  }
}

function kioskGlyph(g: Graphics, o: MapObject): void {
  g.roundRect(o.x, o.y, o.w, o.h, 4).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, 4).stroke(stroke());
  g.moveTo(o.x + 5, o.y + o.h - 6).lineTo(o.x + o.w - 5, o.y + o.h - 6).stroke(stroke(1.25));
  g.rect(o.x + o.w / 2 - 7, o.y + 4, 14, 8).stroke(stroke(1.25));
}

function treeGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) / 2;

  g.circle(cx, cy, r).fill({ color: INK.paper, alpha: 0.85 });
  g.circle(cx, cy, r).stroke(stroke(1.5, INK.faint));
  g.circle(cx, cy, r * 0.62).stroke(stroke(1.25, INK.faint));

  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI * 2 * i) / 6 + 0.35;
    g.moveTo(cx + Math.cos(angle) * r * 0.3, cy + Math.sin(angle) * r * 0.3)
      .lineTo(cx + Math.cos(angle) * r * 0.88, cy + Math.sin(angle) * r * 0.88)
      .stroke(stroke(1, INK.faint));
  }

  g.circle(cx, cy, 3).fill({ color: INK.soft });
}

function carGlyph(g: Graphics, o: MapObject): void {
  const vertical = o.h > o.w;
  g.roundRect(o.x, o.y, o.w, o.h, Math.min(o.w, o.h) * 0.22).fill({ color: INK.fill });
  g.roundRect(o.x, o.y, o.w, o.h, Math.min(o.w, o.h) * 0.22).stroke(stroke());

  if (vertical) {
    const frontY = o.facing === "S" ? o.y + o.h : o.y;
    const dir = o.facing === "S" ? -1 : 1;
    // Windshield + rear glass.
    g.moveTo(o.x + 5, frontY + dir * o.h * 0.28).lineTo(o.x + o.w - 5, frontY + dir * o.h * 0.28).stroke(stroke(1.25));
    g.moveTo(o.x + 5, frontY + dir * o.h * 0.78).lineTo(o.x + o.w - 5, frontY + dir * o.h * 0.78).stroke(stroke(1.25));
    g.roundRect(o.x + 4, Math.min(frontY + dir * o.h * 0.3, frontY + dir * o.h * 0.76), o.w - 8, o.h * 0.44, 4).stroke(stroke(1.25));
    g.rect(o.x - 3, o.y + o.h * 0.3, 4, 7).fill({ color: INK.line });
    g.rect(o.x + o.w - 1, o.y + o.h * 0.3, 4, 7).fill({ color: INK.line });
  } else {
    const frontX = o.facing === "E" ? o.x + o.w : o.x;
    const dir = o.facing === "E" ? -1 : 1;
    g.moveTo(frontX + dir * o.w * 0.28, o.y + 5).lineTo(frontX + dir * o.w * 0.28, o.y + o.h - 5).stroke(stroke(1.25));
    g.moveTo(frontX + dir * o.w * 0.78, o.y + 5).lineTo(frontX + dir * o.w * 0.78, o.y + o.h - 5).stroke(stroke(1.25));
    g.roundRect(Math.min(frontX + dir * o.w * 0.3, frontX + dir * o.w * 0.76), o.y + 4, o.w * 0.44, o.h - 8, 4).stroke(stroke(1.25));
    g.rect(o.x + o.w * 0.3, o.y - 3, 7, 4).fill({ color: INK.line });
    g.rect(o.x + o.w * 0.3, o.y + o.h - 1, 7, 4).fill({ color: INK.line });
  }
}

function bikeRackGlyph(g: Graphics, o: MapObject): void {
  const horizontal = o.w >= o.h;
  const count = Math.max(3, Math.floor((horizontal ? o.w : o.h) / 20));
  for (let i = 0; i < count; i += 1) {
    if (horizontal) {
      const x = o.x + ((i + 0.5) * o.w) / count;
      g.moveTo(x - 6, o.y + o.h)
        .arc(x, o.y + o.h, 6, Math.PI, 0)
        .stroke(stroke(1.5, INK.soft));
    } else {
      const y = o.y + ((i + 0.5) * o.h) / count;
      g.moveTo(o.x + o.w, y - 6)
        .arc(o.x + o.w, y, 6, -Math.PI / 2, Math.PI / 2)
        .stroke(stroke(1.5, INK.soft));
    }
  }
}

function hydrantGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) / 2;
  g.circle(cx, cy, r).fill({ color: INK.fill });
  g.circle(cx, cy, r).stroke(stroke(1.5));
  g.circle(cx, cy, r * 0.35).stroke(stroke(1));
  g.rect(cx - r - 2, cy - 2, 3, 4).fill({ color: INK.line });
  g.rect(cx + r - 1, cy - 2, 3, 4).fill({ color: INK.line });
}

function hvacGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fillSoft });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke(1.5, INK.soft));
  // Fan circle with blades.
  const fanR = Math.min(o.w, o.h) * 0.32;
  const fx = o.x + o.w * 0.32;
  const fy = o.y + o.h / 2;
  g.circle(fx, fy, fanR).stroke(stroke(1.25, INK.soft));
  for (let i = 0; i < 3; i += 1) {
    const angle = (Math.PI * 2 * i) / 3;
    g.moveTo(fx, fy).lineTo(fx + Math.cos(angle) * fanR * 0.85, fy + Math.sin(angle) * fanR * 0.85).stroke(stroke(1, INK.soft));
  }
  // Grille.
  for (let x = o.x + o.w * 0.58; x < o.x + o.w - 5; x += 6) {
    g.moveTo(x, o.y + 5).lineTo(x, o.y + o.h - 5).stroke(stroke(1, INK.soft));
  }
}

function skylightGlyph(g: Graphics, o: MapObject): void {
  g.rect(o.x, o.y, o.w, o.h).fill({ color: INK.fillSoft, alpha: 0.7 });
  g.rect(o.x, o.y, o.w, o.h).stroke(stroke(1.5, INK.soft));
  g.moveTo(o.x, o.y).lineTo(o.x + o.w, o.y + o.h).stroke(stroke(1, INK.faint));
  g.moveTo(o.x + o.w / 2, o.y).lineTo(o.x + o.w / 2, o.y + o.h).stroke(stroke(1, INK.faint));
}

function ventGlyph(g: Graphics, o: MapObject): void {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const r = Math.min(o.w, o.h) / 2;
  g.circle(cx, cy, r).fill({ color: INK.fillSoft });
  g.circle(cx, cy, r).stroke(stroke(1.25, INK.soft));
  g.circle(cx, cy, r * 0.5).stroke(stroke(1, INK.soft));
}

function parkingStallGlyph(g: Graphics, o: MapObject): void {
  // Painted stall: three sides, open toward the aisle (west by convention).
  g.moveTo(o.x + o.w, o.y)
    .lineTo(o.x, o.y)
    .lineTo(o.x, o.y + o.h)
    .lineTo(o.x + o.w, o.y + o.h)
    .stroke(stroke(2, INK.faint));
}

export const glyphs: Record<ObjectKind, GlyphFn> = {
  bed: (g, o) => bedGlyph(g, o, false),
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
  filingCabinet: (g, o) => drawerStack(g, o, Math.max(2, Math.round(o.h / 18))),
  locker: lockerGlyph,
  crateStack: crateStackGlyph,
  workbench: workbenchGlyph,
  toolCabinet: (g, o) => drawerStack(g, o, 2),
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
};

export function drawObject(g: Graphics, object: MapObject): void {
  glyphs[object.kind](g, object);
}
