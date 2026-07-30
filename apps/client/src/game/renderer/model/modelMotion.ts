import { Container, Graphics } from "pixi.js";
import type { MapObject, Vec2 } from "@dotbot/game/types";
import { jitter } from "./tone";

/**
 * AMBIENT MOTION — the world's cosmetic movement, and who is allowed to own it.
 *
 * `docs/world-motion.md` draws the line this module lives on. Ambient motion is a pure
 * function of the CLIENT CLOCK: it touches no simulation state, is never replicated, and if
 * two players see slightly different frames of it nothing is wrong. `modelWater` was the
 * first use; this is the general one.
 *
 * IT IS NOT RULE 4. `tone.ts` rule 4 says a moving thing is either animated or not drawn,
 * and it exists because smoke was once drawn as a puff of frozen circles. It has been
 * misread as a ban on motion often enough that a chairoplane was deleted rather than
 * animated. Motion is wanted. See the memory `motion-is-wanted`.
 *
 * ## The mechanism, and why it is a CHILD of the glyph
 *
 * A moving part is a `Graphics` added as a child of the object's own view. In Pixi 8 a
 * `Graphics` IS a `Container`, so this costs nothing and buys three things at once:
 *
 *  - draw order is guaranteed — a child draws over its parent's own geometry, so the
 *    turning canopy lands on the deck it stands on without any display-list bookkeeping;
 *  - the object's view stays ONE `Graphics`, which parallax (`redrawFloorObjects`), Studio
 *    fabrication and `objectViews` all depend on;
 *  - the part gets its own transform, which is the entire point.
 *
 * The alternative — a sibling Graphics pushed into the builder's array next to the base —
 * works only in the one builder that remembers to do it, and there are three of them
 * (outdoor, floor, Studio). A child works everywhere `drawModelObject` is called, which is
 * why the glyphs tag their own moving parts and the builders merely `collectMovers`.
 *
 * ## What it costs
 *
 * One transform per part per frame, and NOTHING is redrawn. No `g.clear()`, because that
 * re-tessellates the geometry — the one thing on this subject that would genuinely cost.
 * The world's heaviest map has two rides and ~106 pieces of vegetation, so a full frame of
 * ambient motion is ~108 transforms and about as many `Math.sin` calls.
 */

/** What a moving part does. Each is a different transform, not a different speed. */
export type AmbientKind = "spin" | "sway";

/**
 * The tag a glyph puts on its own moving part.
 *
 * Discovery by label rather than by kind on purpose: a builder should not have to know
 * that a carousel turns and a bench does not. It draws the object, asks what moved, and
 * gets the answer from the glyph that knows.
 */
const LABEL: Record<AmbientKind, string> = {
  spin: "ambient:spin",
  sway: "ambient:sway",
};

/**
 * Start a moving part inside a glyph, and return the `Graphics` to draw it into.
 *
 * `about` is the world point the part turns or leans around — a ride's centre, a tree's
 * trunk. Pivot and position are both set to it, which leaves the geometry in the world
 * coordinates every glyph already draws in while making the transform act about that
 * point. Anything drawn into the returned Graphics must use world coordinates like its
 * parent; there is no local space to think about.
 */
export function movingPart(g: Graphics, kind: AmbientKind, about: Vec2): Graphics {
  const part = new Graphics();
  part.label = LABEL[kind];
  part.pivot.set(about.x, about.y);
  part.position.set(about.x, about.y);
  g.addChild(part);
  return part;
}

/** A moving part, bound to the clock. Built once; only its transform changes. */
export type AmbientMover = {
  kind: AmbientKind;
  view: Container;
  /** The world point it moves about. Restored exactly when motion is off. */
  about: Vec2;
  /**
   * Where this part is in the world's rhythm, 0..1.
   *
   * Derived from the object id, so it is stable across a reload and two trees in a row
   * are never in lockstep — the single thing that makes a row of street trees read as
   * vegetation rather than as one animation played on eight copies.
   */
  phase: number;
  /** Canopy radius in world units, or a ride's radius. Sets how far it moves. */
  reach: number;
  /** Radians per ms of steady turn, signed. Zero for a swayer. */
  drift: number;
};

/**
 * Find the moving parts a glyph tagged, and bind them to the clock.
 *
 * Called by whichever builder drew the object. Cheap enough to call for every object —
 * it is a scan of one view's direct children, and almost every object has none.
 */
export function collectMovers(view: Container, o: MapObject): AmbientMover[] {
  const movers: AmbientMover[] = [];
  for (const child of view.children) {
    const kind = (Object.keys(LABEL) as AmbientKind[]).find((key) => LABEL[key] === child.label);
    if (!kind) continue;
    movers.push({
      kind,
      view: child,
      about: { x: child.pivot.x, y: child.pivot.y },
      phase: jitter(o.id, 3),
      reach: Math.min(o.w, o.h) / 2,
      // Two rides in one region turning the same way at the same speed read as one
      // object twice. The waltzer is the heavier of the two and it turns the other way.
      drift: kind === "spin" ? (o.kind === "waltzer" ? -SPIN.slow : SPIN.creep) : 0,
    });
  }
  return movers;
}

/**
 * Ride speeds, in radians per millisecond.
 *
 * SLOW ENOUGH TO BE WEATHER, which is the whole story of the fairground. Nothing here is
 * powered: the region is derelict and what moves these is wind. `creep` is one full turn
 * in about two and a half minutes — clearly turning when you watch it, never a ride giving
 * anybody a go.
 */
const SPIN = {
  creep: (Math.PI * 2) / 150_000,
  slow: (Math.PI * 2) / 205_000,
} as const;

/**
 * The unevenness on top of the drift.
 *
 * "Slowly and unevenly" is the brief, and uneven is the harder half: a constant rate reads
 * as a motor, which is exactly the thing this ride does not have. The amplitude is held
 * BELOW the point where the ride would rock backwards — at 0.13 rad over 7.3 s the
 * instantaneous rate varies by about ±40% and never changes sign. A ride creeping forward
 * in gusts is weather; a ride swinging back and forth is broken machinery, which is a
 * different (and unintended) claim.
 */
const SPIN_WAVER = { amount: 0.13, periodMs: 7_300 } as const;

/**
 * THE WORLD'S WIND, and the reason it is one function rather than per-tree noise.
 *
 * Every tree jittering on its own phase reads as static — a hundred independent wobbles
 * average out to a shimmer. A gust that CROSSES the trees reads as wind, because that is
 * what wind does: it arrives, it passes, and the far side of a stand of trees moves after
 * the near side. So there is one wind, and each tree samples it slightly late.
 *
 * Direction turns slowly (a shifting breeze, not a weather vane); strength is two beats
 * against each other, so there are lulls without ever coming fully to rest.
 */
function wind(atMs: number): { x: number; y: number; strength: number } {
  const heading = atMs / 41_000;
  // Never zero and never one: a lull is quiet, not a freeze, and vegetation at a dead
  // stop next to a turning ride is the one thing that would look like a bug.
  const strength = 0.45 + Math.sin(atMs / 5_900) * 0.33 + Math.sin(atMs / 2_450) * 0.22;
  return { x: Math.cos(heading), y: Math.sin(heading), strength };
}

/** How late the far side of a stand feels a gust. One tree-phase apart, in ms. */
const GUST_LAG_MS = 1_900;

/**
 * How far a canopy leans, as a fraction of its own radius.
 *
 * Set by eye against the game's own zoom rather than by physics: a 96-unit tree has a
 * 48-unit canopy, and 0.07 of that is about 3.4 world units of lean — a few pixels on
 * screen, which is what a tree in a breeze actually does. Larger and street trees look
 * like they are being blown over; smaller and nothing on screen appears to move.
 */
const LEAN = 0.07;
/** A twist on top of the lean, radians. The crown turns as well as shifts. */
const TWIST = 0.03;
/** The silhouette breathes: leaves moving change the outline, they do not only slide. */
const BREATHE = 0.018;

/**
 * Move every ambient part for this frame.
 *
 * `reducedMotion` parks everything at its resting pose rather than slowing it down. That
 * setting is somebody's access requirement, not a taste control, and a slow sway is still
 * a sway. Parking restores the transform exactly, so a reduced-motion frame is
 * pixel-identical to a frame built and never animated — which is also what makes the lab's
 * still shots trustworthy.
 */
export function animateAmbient(
  movers: readonly AmbientMover[],
  nowMs: number,
  reducedMotion: boolean,
): void {
  for (const mover of movers) {
    const { view, about } = mover;
    if (reducedMotion) {
      view.position.set(about.x, about.y);
      view.rotation = 0;
      view.scale.set(1);
      continue;
    }

    if (mover.kind === "spin") {
      view.rotation = mover.drift * nowMs
        + Math.sin(nowMs / SPIN_WAVER.periodMs + mover.phase * Math.PI * 2) * SPIN_WAVER.amount;
      continue;
    }

    // Sway. One wind, sampled late in proportion to this piece's phase, so a gust is
    // visibly a wave crossing the stand rather than every canopy twitching at once.
    const gust = wind(nowMs - mover.phase * GUST_LAG_MS);
    const lean = mover.reach * LEAN * gust.strength;
    view.position.set(about.x + gust.x * lean, about.y + gust.y * lean * 0.6);
    view.rotation = gust.strength * TWIST * gust.x;
    view.scale.set(1 + gust.strength * BREATHE * gust.y);
  }
}
