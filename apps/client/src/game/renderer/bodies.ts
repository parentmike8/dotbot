import type { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import { INK, WEIGHT } from "./style";
import { CORE_REACH, PLATE_REACH, contactReach, shieldArcSpan } from "@dotbot/game/shields";
import { brokenRingArcs, carryTickAngles, waterlineArc, waterlineSurface } from "./bodyMarks";
import { drawCatchLight, silhouetteCells, traceSilhouette, unspin, type SilhouetteBody } from "./grounding";

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

/** The core with nothing in it: see-through, not merely dim. */
const EMPTY_ALPHA = 0.2;
/**
 * The glass wall.
 *
 * This was a two-unit stroke in full ink, which made it the heaviest mark on the
 * core — and at a quarter full the liquid is a thin lens pressed against it, so
 * the pair read as one border thickening its way round to a closed circle. That
 * is a radial dial, the opposite of what the gauge means. A hairline at roughly
 * the empty fill's weight is a vessel; anything heavier is a track.
 */
const RIM_ALPHA = 0.32;

/**
 * The core as a charge gauge: a dash empties it, and it fills back from the bottom
 * like a glass under a tap.
 *
 * This is the one mark every bot already has, so putting the dash on it costs no
 * new vocabulary and — because it is drawn on rivals too — turns "can that thing
 * still dash at me" into something you read off the world instead of guess.
 *
 * The liquid reading is doing real work, not decoration. A level in a vessel is
 * absolute and reads at a glance from any angle; a ring that closes is a
 * proportion, and a proportion has to be measured. The surface waves for the same
 * reason: a straight line across a disc is a fill bar, and a fill bar is UI.
 */
export function drawChargedCore(
  g: Graphics,
  at: Vec2,
  radius: number,
  level: number,
  color: number,
  /** How much the caller's container will rotate this drawing. See `unspin`. */
  spin = 0,
): void {
  const charge = Math.min(1, Math.max(0, level));

  // The empty glass. Faint enough that the floor reads through it, so a spent dash
  // is see-through rather than a second, darker shade of ink.
  g.circle(at.x, at.y, radius).fill({ color, alpha: EMPTY_ALPHA });

  const surface = waterlineSurface(charge, charge * Math.PI * 2);
  const rim = waterlineArc(charge);
  if (charge >= 1) {
    g.circle(at.x, at.y, radius).fill({ color, alpha: 1 });
  } else if (surface && rim) {
    /**
     * Liquid finds its own level, so the gauge is drawn against the WORLD's down,
     * not the body's.
     *
     * The body is drawn once at facing 0 and its container spun, so without the
     * counter-rotation the waterline rides around with the bot: walk north and the
     * glass fills sideways, walk south and it fills from the top down. Play called
     * it exactly right — "sometimes the gauge is filling up upside down and it looks
     * odd." A gauge that means "how much dash is left" cannot also encode heading.
     *
     * The surface, then the rim back around the bottom. Their ends coincide, so the
     * implicit line into the arc is zero-length and the liquid has one edge.
     */
    const level = surface.map((point) => unspin(point, spin));
    g.moveTo(at.x + level[0].x * radius, at.y + level[0].y * radius);
    for (const point of level.slice(1)) {
      g.lineTo(at.x + point.x * radius, at.y + point.y * radius);
    }
    g.arc(at.x, at.y, radius, rim[0] - spin, rim[1] - spin);
    g.closePath();
    g.fill({ color, alpha: 1 });
  }

  // Pulled in by half its own width, like every other edge on a bot: on a bare arc
  // the core *is* the body's surface, so a hairline straddling it would be the only
  // ink outside the collider left on the whole drawing.
  g.circle(at.x, at.y, radius - 0.5).stroke({ color, width: 1, alpha: RIM_ALPHA });

  /**
   * The highlight that makes the core a sphere rather than a disc.
   *
   * It used to be all-or-nothing, drawn by the caller only at a full charge, which
   * meant a bot on cooldown stopped reading as a sphere at all — the same mistake
   * the downed body had. Dimming it with the charge keeps the sphere and still
   * reads as a light going out. Full charge lands on the primitive's own default,
   * so a ready bot looks exactly as it did.
   */
  drawCatchLight(g, at, radius, 0.1 + charge * 0.24, spin);
}

/** What the outline needs to know. A `DotBotEntity` satisfies it. */
export type OutlinedBody = SilhouetteBody & { position: Vec2 };

/**
 * Every silhouette stroke joins round.
 *
 * A body's outline turns a hard corner where a plate is missing, and a mitred
 * corner spikes outward by half the stroke width times root two — which on the
 * dash ring is two units of ink past the contact surface, at exactly the one
 * place the drawing is being made honest. A round join puts the corner's ink
 * inside the circle of the corner point, so an inset of half the width holds
 * everywhere.
 */
const SILHOUETTE_JOIN = "round" as const;

/** Stroke the body's own shape, pulled in by half the stroke's width. */
function strokeSilhouette(
  g: Graphics,
  bot: OutlinedBody,
  style: { color: number; width: number; alpha: number },
  inset = style.width / 2,
): void {
  traceSilhouette(g, bot.position, silhouetteCells(bot, (reach) => Math.max(0.5, reach - inset)));
  g.stroke({ ...style, join: SILHOUETTE_JOIN });
}

/**
 * The bot's own edge, following its plates — because its body does.
 *
 * One hairline circle at the full radius is wrong in a way that is hard to name
 * and easy to feel: bodies separate at the plate where a plate is up and at the
 * core where one is gone, so a stripped bot drawn as a full circle has thirty-odd
 * units of nothing between the line you can see and the thing you are trying to
 * reach. It reads as an invisible barrier around the core, which is exactly what
 * it is.
 *
 * Sampled from `contactReach`, the same function separation and the attack test
 * call, arc by arc across each plate's *Voronoi* span — wider than the span the
 * plate glyph draws, because the collider hands a seam to its nearer plate. A gap
 * in the outline there would advertise a way in that does not exist.
 */
export function drawBodyOutline(g: Graphics, bot: OutlinedBody): void {
  /**
   * One closed path, so the radial jamb between two cells at different reaches
   * comes from the trace itself. Drawing the arcs separately and adding the jambs
   * by hand was the same shape and four more lines of arithmetic to get wrong.
   * Without the jamb a bot with one plate gone is two arcs floating at different
   * radii rather than one body with a bite out of it — and the bite is the whole
   * point, because it is where another bot can get to your core.
   */
  strokeSilhouette(g, bot, { color: INK.structure, width: 1, alpha: 0.22 }, 0.5);
}

/** The plate ring's stroke weight. Its outer edge is the contact surface. */
const PLATE_WIDTH = 5;

/**
 * The second rule inside an enemy plate.
 *
 * It used to be a parallel arc three units *outside* the plate, whose own outer
 * edge landed at 25.5 against a collider at 24 — so two fully plated rivals,
 * perfectly separated, still showed three units of ring driven through each
 * other. Nothing about "this one is not on your side" needs to be said outside
 * the body, and the inside of the shell is empty.
 */
const SERRATION_INSET = 4;

/**
 * Shield plates anchored to the bot's facing, plate 0 dead ahead.
 *
 * Intact plates draw solid, cracked plates split at the middle, and a broken
 * plate draws no ring at all — because there is no ring there. It used to leave a
 * faint ghost stroked at the full plate radius, 22.5 units of visible edge in an
 * arc where the body reaches 9.6, which is the single biggest lie the bot layer
 * told: two stripped bots resting correctly at 19.20 drew ghosts through each
 * other 25.8 units deep, each ring enclosing the other bot's centre. Play reads
 * the drawing, so play saw bots welded together and the solver got the blame.
 *
 * What replaces it is the cut itself: the two radial edges where the shell steps
 * back to the core, in the bot's own colour, over the hairline the outline draws
 * in the same place. Nothing is invented and nothing is outside the body — the
 * gap between two live plates is fourteen degrees and the gap where one is gone
 * is a hundred and thirty-three, so which side is open was never in doubt. What
 * the cut edges add is *how far* it is open, which is the part that decides
 * whether something can reach your core.
 */
export function drawPlates(
  g: Graphics,
  bot: OutlinedBody,
  color: number,
  serrated: boolean,
  fade = 1,
): void {
  const plates = bot.shieldSegments.length;
  if (plates <= 0) return;

  const at = bot.position;
  const span = shieldArcSpan(plates);
  const step = (Math.PI * 2) / plates;
  const coreReach = bot.radius * CORE_REACH;
  /**
   * The plate's *outer edge* lands on the contact radius, so the stroke is
   * pulled in by half its own width.
   *
   * The arcs used to be stroked at 0.78 of the radius, inset behind a hairline
   * hull drawn at the true one — which made the outermost thing on a bot a line
   * that was not any part of it. That was survivable while contact was a plain
   * circle and became a lie the moment contact started following the plates:
   * you could touch a bot a full fifth of its radius before reaching anything
   * drawn. What the shell is, is the surface.
   */
  const shieldRadius = bot.radius * PLATE_REACH - PLATE_WIDTH / 2;

  for (let index = 0; index < plates; index += 1) {
    const state = bot.shieldSegments[index] ?? 0;
    const center = bot.facing + index * step;
    const start = center - span / 2;

    // A plate is there or it is not: `state` is 1 or 0, so this is the whole live case.
    if (state > 0) {
      strokeArc(g, at, shieldRadius, start, start + span, { color, width: PLATE_WIDTH, alpha: fade });
      if (serrated) {
        strokeArc(g, at, shieldRadius - SERRATION_INSET, start, start + span, {
          color,
          width: 2,
          alpha: fade,
        });
      }
      continue;
    }

    /**
     * Broken: the two cut edges, and only where there is a step to cut. Adjacent
     * broken plates share a boundary the body does not step across, so a bot with
     * nothing left draws no edges at all — it is a core and a hull, which is
     * exactly what it is.
     *
     * The edges sit on the plate's *Voronoi* boundary rather than the glyph's,
     * because that is where `contactReach` actually steps; drawn at the glyph's
     * ends they would stand thirteen units proud of the body on both sides.
     */
    for (const side of [-1, 1] as const) {
      const edge = center + (side * step) / 2;
      const outer = contactReach(bot.radius, bot.facing, bot.shieldSegments, center + side * step);
      if (outer <= coreReach) continue;
      g.moveTo(at.x + Math.cos(edge) * (outer - 0.5), at.y + Math.sin(edge) * (outer - 0.5))
        .lineTo(at.x + Math.cos(edge) * (coreReach - 0.5), at.y + Math.sin(edge) * (coreReach - 0.5))
        .stroke({ color, width: 2, alpha: 0.55 * fade });
    }
  }
}

/** The coloured rim on a bare arc. Its outer edge is the core's own surface. */
const BARE_EDGE_WIDTH = 2;

/**
 * What a bare arc looks like: the core's edge, in the bot's own colour.
 *
 * Drawn after the core, because it lives *on* the core's rim — which is the whole
 * point, and why it cannot be part of the plate pass. Two things were missing
 * without it. A bot with nothing left had no colour anywhere on it: no plates, and
 * the hull is structural ink, so a stripped rival and a stripped squadmate were
 * the same dark dot. And a bite had edges but no floor, so how deep it went was
 * something you inferred from two ticks rather than saw.
 *
 * It is the shortest possible statement of the mechanic: the colour has receded to
 * the core, exactly as far as the body has.
 */
export function drawBareEdges(g: Graphics, bot: OutlinedBody, color: number, fade = 1): void {
  const plates = bot.shieldSegments.length;
  if (plates <= 0) return;

  const step = (Math.PI * 2) / plates;
  const radius = bot.radius * CORE_REACH - BARE_EDGE_WIDTH / 2;

  for (let index = 0; index < plates; index += 1) {
    if ((bot.shieldSegments[index] ?? 0) > 0) continue;
    const center = bot.facing + index * step;
    strokeArc(g, bot.position, radius, center - step / 2, center + step / 2, {
      color,
      width: BARE_EDGE_WIDTH,
      alpha: 0.85 * fade,
    });
  }
}

/**
 * Dash and invulnerability, as rings that follow the body.
 *
 * Both were full circles at the plain radius — a hard closed edge thirteen units
 * past the contact surface on any bare arc, which is the "invisible barrier
 * around the core" the outline was rebuilt to get rid of, drawn back on top of it
 * in three-unit ink. A ring around a star has to be the star.
 */
export function drawDashRing(g: Graphics, bot: OutlinedBody): void {
  strokeSilhouette(g, bot, { color: INK.structure, width: 3, alpha: 0.45 });
}

/**
 * A flat three-unit inset is a different thing on a plate than on a core. On a
 * 24-unit plate it is a rim just inside the edge; on a 9.6-unit core it is 31% of
 * the way to the centre, which put the ring's outer edge at 7.6 — INSIDE the
 * core's own rim hairline at 9.1, so a stripped bot spawning in showed a second,
 * smaller circle floating in its middle instead of a rim on its surface.
 *
 * Proportional instead, so the rim sits the same fraction inside whatever surface
 * it is tracing.
 */
const INVULNERABLE_INSET = 3 / 24;

export function drawInvulnerabilityRing(g: Graphics, bot: OutlinedBody): void {
  const style = { color: 0x111111, width: 2, alpha: 0.18 };
  traceSilhouette(
    g,
    bot.position,
    silhouetteCells(bot, (reach) => Math.max(0.5, reach * (1 - INVULNERABLE_INSET) - style.width / 2)),
  );
  g.stroke({ ...style, join: SILHOUETTE_JOIN });
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
  /**
   * How much the caller's container will rotate this drawing.
   *
   * A body has no facing left, but the view it is drawn into keeps the one its
   * bot had, so its lit marks need the same counter-spin a standing bot's do.
   */
  spin?: number;
};

/** A body keeps the hull an alive bot has; only what is inside it changes. */
const CORE_SCALE = 0.4;
const CRACK_ANGLE = Math.PI * 0.36;
/** Wide enough to be a break the floor shows through, at phone scale. */
const CRACK_GAP = 1.8;

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

  /**
   * Solid while the body still holds what it holds; hollow once somebody has
   * searched it. The crack is the same crack either way — it says the core is
   * broken, which is why the bot is down, and has nothing to do with looting.
   */
  const coreInk = { color: INK.structure, alpha: body.searched ? 0.62 : 0.78 };
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
      crackPiece(g, at, coreRadius, CRACK_ANGLE, line, side, CRACK_GAP);
      paint();
    }
  }

  /**
   * The core keeps its highlight, dimmer than a standing bot's.
   *
   * Dropping it entirely was over-reading the rule: the core is not *lit* — no
   * light source has gone anywhere — it is just no longer standing up. Without a
   * specular it stopped reading as a sphere at all, which is the one thing the
   * mark is for.
   *
   * A searched core is an outline with floor showing through, so there is no
   * surface for a specular to sit on. It catches the light on its rim instead,
   * which is what a broken shell actually does.
   */
  const spin = body.spin ?? 0;
  if (body.searched) {
    strokeArc(g, at, coreRadius, Math.PI * 1.05 - spin, Math.PI * 1.45 - spin, {
      color: 0xffffff, width: WEIGHT.anchor, alpha: 0.5,
    });
  } else {
    drawCatchLight(g, at, coreRadius, 0.2, spin);
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
