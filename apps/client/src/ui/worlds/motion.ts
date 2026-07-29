import { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import { jitter, shade } from "../../game/renderer/model/tone";
import { GROUND, inPoly, ribbon } from "./terrain";

/**
 * Motion, and the one line that has to stay drawn across it.
 *
 * This is not a departure from the drawing language — it is the language's fourth rule
 * finally being satisfied. `tone.ts` says "NOTHING IN MOTION IS DRAWN STATICALLY … a
 * frozen moving thing reads as an artefact and promises animation the renderer never
 * delivers", and every consequence drawn from it so far has been subtractive: no smoke,
 * no spray, a stationary guard grille instead of fan blades. That was the correct
 * reading while the renderer had no animation. The rule's own justification is a
 * conditional, and once the renderer DOES deliver, it points the other way: draw the
 * moving thing moving.
 *
 * So water flows, canopy sways, and the HVAC fan on every Downtown roof is now drawing
 * a grille for a reason that has expired.
 *
 * The line that matters is not "should it move" but **who owns the motion**:
 *
 * - AMBIENT motion is cosmetic. It is a pure function of the client clock, it touches no
 *   simulation state, it is never replicated, and if two players see slightly different
 *   frames of it nothing is wrong. Flowing water, swaying canopy, drifting dust, a
 *   turning windmill. Cost: one `Graphics` redrawn per frame. Netcode risk: zero.
 *
 * - TRAVERSAL motion moves a DotBot. That is simulation. It has to live in
 *   `packages/game`, be deterministic, be replicated, and be predicted client-side, or a
 *   player gets dragged downstream on the server and snaps back on their own screen.
 *
 * Everything in this file is the first kind. The second kind is the expensive kind, and
 * it splits again by how hard it is:
 *
 * - A CURRENT is cheap: a region plus a velocity vector, added to a bot's movement the
 *   same way a dash impulse already is. No new entity, no attachment, no ownership. A
 *   river that carries you downstream is a few days of work, tests included.
 * - A VEHICLE is expensive: a gondola, a mine cart, a handcar. The bot's position
 *   becomes relative to a mover, which means a moving reference frame in a predicted
 *   netcode — the classic hard problem, because the platform's position at the tick the
 *   client predicts and at the tick the server simulates must agree exactly.
 *
 * Both are worth having. They are not worth having in the same milestone, and a current
 * buys most of the delight for a fraction of the risk.
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** A looping 0..1 phase. Everything ambient is built from these. */
export function phase(tMs: number, periodMs: number, offset = 0): number {
  return (((tMs / periodMs) + offset) % 1 + 1) % 1;
}

/** A smooth −1..1 oscillation. */
export function wave(tMs: number, periodMs: number, offset = 0): number {
  return Math.sin(phase(tMs, periodMs, offset) * Math.PI * 2);
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export type Flow = {
  id: string;
  /** Centreline, downstream. */
  spine: Vec2[];
  /** Channel width at 0..1 along the spine. */
  width: (t: number) => number;
  /** World units per second the surface appears to move. */
  speed: number;
  /** How many streaks. Density reads as pace as much as speed does. */
  count?: number;
};

/** Sample a point and its downstream direction at 0..1 along a spine. */
export function alongSpine(spine: Vec2[], t: number): { at: Vec2; dir: Vec2 } {
  const clamped = Math.max(0, Math.min(0.9999, t));
  const span = 1 / (spine.length - 1);
  const index = Math.min(spine.length - 2, Math.floor(clamped / span));
  const local = (clamped - index * span) / span;
  const a = spine[index];
  const b = spine[index + 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    at: { x: a.x + dx * local, y: a.y + dy * local },
    dir: { x: dx / len, y: dy / len },
  };
}

/** Total spine length, so a streak's speed is in world units and not in "per cent per second". */
function spineLength(spine: Vec2[]): number {
  let total = 0;
  for (let i = 0; i < spine.length - 1; i += 1) {
    total += Math.hypot(spine[i + 1].x - spine[i].x, spine[i + 1].y - spine[i].y);
  }
  return total;
}

/**
 * Flowing water: streaks carried downstream, wrapping at the end.
 *
 * Drawn as elongated highlights aligned to the flow, not as ripples or foam. The
 * language is achromatic and value-driven, so the only honest way to show movement is
 * for the highlight to BE the movement — a bright line that travels. It also means the
 * speed is legible: a fast reach and a slow pool differ by how fast the streaks go and
 * how stretched they are, which is exactly the information a player needs if the
 * current is going to move them.
 */
export function drawFlow(g: Graphics, flow: Flow, tMs: number): void {
  const banks = ribbon(flow.spine, flow.width);
  const length = spineLength(flow.spine);
  const count = flow.count ?? Math.round(length / 46);
  const cycleMs = (length / flow.speed) * 1000;

  for (let i = 0; i < count; i += 1) {
    // Each streak has its own lane and its own phase, so they do not march in step.
    const lane = jitter(flow.id, i) * 2 - 1;
    const t = phase(tMs, cycleMs, jitter(flow.id, i + 40));
    const { at, dir } = alongSpine(flow.spine, t);
    const half = flow.width(t) / 2;
    const nx = -dir.y;
    const ny = dir.x;
    const px = at.x + nx * lane * half * 0.72;
    const py = at.y + ny * lane * half * 0.72;
    if (!inPoly({ x: px, y: py }, banks)) continue;

    /**
     * Short, soft and sparse — because long straight highlights down the middle of a
     * dark channel read as lane markings on a road, which is precisely what the first
     * render of the creek looked like. What separates water from asphalt is that the
     * highlight is broken and travelling, not that it is bright.
     */
    const fade = Math.min(1, Math.min(t, 1 - t) * 7);
    const len = 9 + jitter(flow.id, i + 80) * 16;
    const wobble = wave(tMs, 1900, jitter(flow.id, i + 60)) * 3.4;
    const bend = wave(tMs, 2600, jitter(flow.id, i + 70)) * 2.2;

    g.moveTo(px - dir.x * len * 0.5 + nx * wobble, py - dir.y * len * 0.5 + ny * wobble)
      .quadraticCurveTo(
        px + nx * (wobble + bend), py + ny * (wobble + bend),
        px + dir.x * len * 0.5 + nx * wobble, py + dir.y * len * 0.5 + ny * wobble,
      )
      .stroke({
        color: shade(GROUND.shallow, 1.34),
        width: 1.4 + jitter(flow.id, i + 20) * 1.3,
        alpha: 0.26 * fade,
        cap: "round",
      });
  }
}

/**
 * A still surface that is nonetheless alive: a pool, a cenote, a trough.
 *
 * No translation at all — just a slow breathing of the highlights. Standing water that
 * scrolls looks like a river with nowhere to go, and the difference between still and
 * flowing water is information a player uses.
 */
export function drawStillWater(g: Graphics, points: Vec2[], id: string, tMs: number): void {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x / points.length;
    cy += p.y / points.length;
  }
  for (let i = 0; i < 7; i += 1) {
    const a = jitter(id, i) * Math.PI * 2;
    const d = jitter(id, i + 30) * 0.62;
    const breathe = 0.5 + wave(tMs, 3400 + i * 420, jitter(id, i + 70)) * 0.5;
    let extent = 0;
    for (const p of points) extent = Math.max(extent, Math.hypot(p.x - cx, p.y - cy));
    const px = cx + Math.cos(a) * d * extent;
    const py = cy + Math.sin(a) * d * extent;
    if (!inPoly({ x: px, y: py }, points)) continue;
    const w = 30 + jitter(id, i + 50) * 52;
    g.roundRect(px - w / 2, py, w * (0.7 + breathe * 0.3), 2.6, 1.3)
      .fill({ color: shade(GROUND.shallow, 1.5), alpha: 0.12 + breathe * 0.2 });
  }
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type Drift = {
  id: string;
  count: number;
  /** World units per second. */
  velocity: Vec2;
  /** Where drifters live. Anything leaving wraps back in. */
  bounds: { x: number; y: number; w: number; h: number };
  size: [number, number];
  color: number;
  alpha?: number;
  /** How far a drifter wanders across its own path. */
  waver?: number;
};

/**
 * Loose matter carried on the air: leaves, dust, ash, pollen, tumbleweed.
 *
 * The cheapest life-per-byte in the whole file. A dozen specks moving across a still
 * frame does more to make a place feel inhabited than any amount of extra fixture
 * detail, and it costs one wrapped modulo per speck.
 */
export function drawDrift(g: Graphics, drift: Drift, tMs: number): void {
  const seconds = tMs / 1000;
  for (let i = 0; i < drift.count; i += 1) {
    const spread = 0.6 + jitter(drift.id, i) * 0.8;
    const travelX = drift.velocity.x * spread * seconds;
    const travelY = drift.velocity.y * spread * seconds;
    const startX = drift.bounds.x + jitter(drift.id, i + 11) * drift.bounds.w;
    const startY = drift.bounds.y + jitter(drift.id, i + 21) * drift.bounds.h;
    const waver = drift.waver ?? 9;
    const x = drift.bounds.x + (((startX - drift.bounds.x + travelX) % drift.bounds.w) + drift.bounds.w) % drift.bounds.w;
    const y = drift.bounds.y + (((startY - drift.bounds.y + travelY) % drift.bounds.h) + drift.bounds.h) % drift.bounds.h
      + wave(tMs, 2600, jitter(drift.id, i + 31)) * waver;
    const r = drift.size[0] + jitter(drift.id, i + 41) * (drift.size[1] - drift.size[0]);
    g.circle(x, y, r).fill({ color: drift.color, alpha: drift.alpha ?? 0.4 });
  }
}

// ---------------------------------------------------------------------------
// Sway
// ---------------------------------------------------------------------------

/**
 * How far an overhead mass leans this frame.
 *
 * Applied as a container offset rather than a redraw, so a hundred trees cost a hundred
 * position writes and no geometry at all. Each mass gets its own phase from its own id,
 * which is the whole trick: a canopy where every crown leans together is not wind, it is
 * the camera moving.
 */
export function swayOffset(id: string, tMs: number, amount = 4.5): Vec2 {
  const periodMs = 3600 + jitter(id, 3) * 2600;
  return {
    x: wave(tMs, periodMs, jitter(id, 1)) * amount,
    y: wave(tMs, periodMs * 1.37, jitter(id, 2)) * amount * 0.45,
  };
}

/** A turning wheel: a windmill, a waterwheel, a mine hoist. */
export function spinAngle(tMs: number, periodMs: number, gust = 0): number {
  const base = phase(tMs, periodMs) * Math.PI * 2;
  return base + (gust > 0 ? wave(tMs, 5200) * gust : 0);
}

// ---------------------------------------------------------------------------
// Ridden motion, sketched
// ---------------------------------------------------------------------------

/**
 * Where a vehicle is on its run, and which way it is pointing.
 *
 * Drawn from the client clock HERE because this is a mock, and that is exactly the part
 * that would not survive contact with production: a vehicle a bot rides has to be at
 * the same place on the server's tick and on the client's predicted tick, so its
 * position must come from the simulation's tick count and nothing else. Keeping this
 * function tiny is deliberate — it is the seam where a cosmetic mock and a real moving
 * platform diverge, and it should be obvious which side of it any given line is on.
 */
export function ridePosition(path: Vec2[], periodMs: number, tMs: number): { at: Vec2; dir: Vec2 } {
  // Out and back, so a shuttle never teleports home.
  const p = phase(tMs, periodMs);
  const t = p < 0.5 ? p * 2 : (1 - p) * 2;
  const { at, dir } = alongSpine(path, t);
  return { at, dir: p < 0.5 ? dir : { x: -dir.x, y: -dir.y } };
}
