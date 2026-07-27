import type { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import { INK, WEIGHT } from "./style";
import { brokenRingArcs, carryTickAngles } from "./bodyMarks";

/**
 * The one arc primitive. Pixi's `arc` continues the current path, so an arc drawn
 * without moving to its own start joins the previous stroke with a chord.
 */
export function strokeArc(
  g: Graphics,
  at: Vec2,
  radius: number,
  from: number,
  to: number,
  style: { color: number; width: number; alpha?: number },
): void {
  g.moveTo(at.x + Math.cos(from) * radius, at.y + Math.sin(from) * radius);
  g.arc(at.x, at.y, radius, from, to).stroke(style);
}

/** How the core is broken open. Under review — see `?lab&view=bodies`. */
export type CrackKind = "straight" | "zigzag" | "shatter" | "none";
/** Whether the hull is a whole circle or open where you would step over it. */
export type HullKind = "whole" | "broken";

export type BodyStyle = { crack: CrackKind; hull: HullKind };

/**
 * Chosen off the sheet at `?lab&view=bodies`.
 *
 * A whole hull, because it is the same circle an alive bot has and the plates are
 * what went missing, not the shell — an open ring reads as a shield the body
 * somehow got back. A zigzag crack, because a straight one is a slot and a slot is
 * a fitting; a fracture has to wander to read as damage.
 */
export const BODY_STYLE: BodyStyle = { crack: "zigzag", hull: "whole" };

/**
 * Where the core is broken, as a line crossing it from rim to rim.
 *
 * Off-centre on purpose: a split through the middle gives two equal halves, and
 * two equal halves with a slot between them is a flathead screw — a manufactured
 * joint rather than damage. Unequal pieces read as broken.
 *
 * Returned in a unit disc, y running from the split's offset. The caller scales
 * and rotates.
 */
const SPLIT_OFFSET = -0.2;

function splitLine(kind: CrackKind): Vec2[] {
  const y = SPLIT_OFFSET;
  const halfChord = Math.sqrt(1 - y * y);
  if (kind === "zigzag") {
    return [
      { x: -halfChord, y },
      { x: -0.3, y: y + 0.16 },
      { x: 0.22, y: y - 0.15 },
      { x: halfChord, y },
    ];
  }
  if (kind === "shatter") {
    return [
      { x: -halfChord, y },
      { x: -0.46, y: y + 0.1 },
      { x: -0.1, y: y - 0.12 },
      { x: 0.26, y: y + 0.13 },
      { x: halfChord, y },
    ];
  }
  return [{ x: -halfChord, y }, { x: halfChord, y }];
}

/**
 * One side of a cracked core: the split line, then the rim arc back to where it
 * started.
 *
 * Two closed pieces rather than one disc with a slot subtracted. A first attempt
 * cut the slot out with `cut()` and a second wound a single path around the rim
 * and back in along the crack — both self-intersected at the crack's corners and
 * ate most of the core, leaving a squiggle floating on the floor with no bot
 * around it. Two simple paths cannot do that.
 */
function crackPiece(
  g: Graphics,
  at: Vec2,
  radius: number,
  angle: number,
  line: Vec2[],
  side: 1 | -1,
  gap: number,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const place = (p: Vec2): Vec2 => ({
    x: at.x + (p.x * cos - p.y * sin) * radius,
    y: at.y + (p.x * sin + p.y * cos) * radius,
  });
  // Each piece pulls back from the split by half the gap, so the crack is floor
  // showing through rather than a drawn line.
  const inset = (gap / 2) / radius;
  const walk = side > 0 ? line : [...line].reverse();
  const shifted = walk.map((point) => ({ x: point.x, y: point.y + inset * side }));

  const first = place(shifted[0]);
  g.moveTo(first.x, first.y);
  for (const point of shifted.slice(1)) {
    const placed = place(point);
    g.lineTo(placed.x, placed.y);
  }
  const end = walk[walk.length - 1];
  const start = walk[0];
  /**
   * Back around the rim, always counterclockwise.
   *
   * Each piece walks the split in the opposite direction to the other, so the same
   * sweep direction returns along opposite halves of the rim. Choosing the sweep
   * per side instead sent both pieces around the top: one rendered, the other was
   * the same crescent drawn twice, and the core came out as a comma.
   */
  g.arc(
    at.x,
    at.y,
    radius,
    angle + Math.atan2(end.y, end.x),
    angle + Math.atan2(start.y, start.x),
    true,
  );
  g.closePath();
}

export type DownedBody = {
  at: Vec2;
  radius: number;
  /** Squad relationship colour — whose body this is, at the same glance as everything else. */
  color: number;
  /** Public even for rivals: how much is still on it. Composition is not. */
  carriedCount: number;
  /** A loot channel has finished here, so the contents are known and takeable. */
  searched: boolean;
  style?: BodyStyle;
};

/** A body keeps the hull an alive bot has; only what is inside it changes. */
const CORE_SCALE = 0.4;
const CRACK_ANGLE = Math.PI * 0.36;

/**
 * A body lying on the floor.
 *
 * It used to be drawn as a standing bot turned down: a cast shadow, thin plate
 * arcs still anchored to a facing it no longer had, and an engraved interaction
 * dot at its centre — which read as a floor drain in the middle of the room.
 *
 * What is left is a bot with its plates gone and its core broken open.
 *
 *   - No plate ring. The carrier failed; that is what being down *is*, and drawing
 *     a ring in the plate's own place reads as a shield the body has somehow got
 *     back. Only the hull stays, at the same true footprint an alive bot has, and
 *     in the same relationship colour — so a body is never smaller than the bot it
 *     came from, and you can still tell whose it is at a glance.
 *   - The core is cracked open, off-centre.
 *   - No cast shadow and no catch light. Nothing is lifted and nothing is lit, so
 *     the whole thing sits back into the floor instead of standing off it.
 *   - Filled core means unsearched, hollow means searched, and one notch per
 *     carried item — the only question worth asking from across a room is whether
 *     there is still a channel to run here.
 */
export function drawDownedBody(g: Graphics, body: DownedBody): void {
  const { at, radius, color } = body;
  const style = body.style ?? BODY_STYLE;
  const coreRadius = radius * CORE_SCALE;

  // Contact pool: no offset and no stack, because a body touching the floor
  // everywhere has no gap for light to get under.
  g.circle(at.x, at.y, radius * 0.64).fill({ color: 0x000000, alpha: 0.055 });

  const hull = { color, width: WEIGHT.fixture, alpha: 0.55 };
  if (style.hull === "whole") {
    g.circle(at.x, at.y, radius - 0.5).stroke(hull);
  } else {
    for (const [from, to] of brokenRingArcs()) strokeArc(g, at, radius - 0.5, from, to, hull);
  }

  // Filled while nobody has been through it; an outline once it has been searched,
  // so the floor shows through what is left.
  const coreInk = { color: INK.structure, alpha: body.searched ? 0.62 : 0.74 };
  const paint = () => {
    if (body.searched) g.stroke({ ...coreInk, width: WEIGHT.anchor });
    else g.fill(coreInk);
  };
  if (style.crack === "none") {
    g.circle(at.x, at.y, coreRadius);
    paint();
  } else {
    const line = splitLine(style.crack);
    for (const side of [1, -1] as const) {
      crackPiece(g, at, coreRadius, CRACK_ANGLE, line, side, 1.6);
      paint();
    }
  }

  // What is left on it, between the core and the hull: one notch per item.
  for (const angle of carryTickAngles(body.carriedCount)) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    g.moveTo(at.x + cos * (coreRadius + 3), at.y + sin * (coreRadius + 3))
      .lineTo(at.x + cos * (radius - 4), at.y + sin * (radius - 4))
      .stroke({ color: INK.structure, width: WEIGHT.anchor, alpha: 0.62 });
  }
}
