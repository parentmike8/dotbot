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
  /**
   * A DRAWING SINK THAT IS NOT A DISPLAY LIST GETS THE MARKS DIRECTLY.
   *
   * Several tests — `passable.test.ts`, `modelStairs.test.ts` — hand the glyphs a recorder
   * that implements the drawing calls and nothing else, which is a good property worth
   * keeping: it is how a glyph's marks get measured without a GPU. Such a sink has no
   * `addChild` and no frames, so there is nothing to animate and nothing to parent to, and
   * the right answer is to draw the part where it belongs and hand the sink back. The marks
   * are in world coordinates either way, so the recorder sees exactly what the screen would.
   *
   * This is a widened contract, not a silent fallback: `collectMovers` finds no tagged child
   * and reports no mover, which is the truthful answer for a sink that cannot move.
   */
  if (typeof (g as { addChild?: unknown }).addChild !== "function") return g;

  /**
   * IDEMPOTENT, and that is not tidiness — it is the difference between working and
   * leaking.
   *
   * `redrawFloorObjects` re-runs the glyph on the SAME `Graphics` every time object
   * parallax steps, and `Graphics.clear()` empties the geometry while leaving the children
   * in place. A fresh child per call would therefore add one canopy per camera step,
   * unbounded, with every mover but the first pointing at a view nobody animates. The
   * Studio's fabrication hook redraws the same way.
   *
   * So an existing part is reused and only its geometry cleared. Its transform survives on
   * purpose: a canopy mid-lean must not snap back to centre because the camera moved.
   */
  const existing = g.children.find((child) => child.label === LABEL[kind]);
  if (existing instanceof Graphics) {
    existing.clear();
    existing.pivot.set(about.x, about.y);
    return existing;
  }

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
  /**
   * Two beats against each other, held in 0.10..1.00 — never zero and never negative.
   *
   * The first version centred on 0.45 with amplitudes summing to 0.55, so it crossed zero
   * and spent most of its time near it. Measured on a real tree, that put the temple's
   * 104-unit canopies about ONE world unit off centre most of the time, which is nothing at
   * play zoom: the ceiling was fine and the average was the problem. A lull should be quiet,
   * not a freeze — vegetation at a dead stop next to a turning ride reads as a bug.
   */
  const strength = 0.55 + Math.sin(atMs / 5_900) * 0.30 + Math.sin(atMs / 2_450) * 0.15;
  return { x: Math.cos(heading), y: Math.sin(heading), strength };
}

/**
 * How fast a gust front crosses the world, in world units per millisecond.
 *
 * THE LAG IS POSITIONAL, and getting there was the second thing a failing test found. It
 * was a per-tree hash — `jitter(id, 3)` — which gave eight distinct canopy positions across
 * twenty-five trees, because downtown's object ids are `o0`, `o1`, `o11` and a hash of a
 * two-character string does not spread. The fix could have been a better hash. It is instead
 * the thing that was actually wanted: a tree feels a gust late in proportion to HOW FAR
 * ALONG THE WIND IT STANDS, so a gust is a wave crossing the map rather than a hundred
 * canopies agreeing to move at slightly different times.
 *
 * 0.35 units/ms crosses the 4,200-unit world in about twelve seconds, which at the wind's
 * own 5.9 s and 2.45 s beats puts two or three fronts on the sheet at once. Cheap: the
 * heading is computed once per frame and each mover costs one dot product.
 */
const GUST_SPEED = 0.35;
/** A small per-piece desync on top of the front, so neighbours are never exactly together. */
const GUST_JITTER_MS = 700;

/**
 * How far a canopy leans: a fixed base plus a fraction of its own radius.
 *
 * THE BASE IS NOT A FUDGE, and it was put there by a failing test. A pure fraction of the
 * radius made the world's small trees effectively static: downtown's street trees are 44
 * units across, so at 0.07 of a 22-unit radius their crowns moved 1.5 world units — about a
 * pixel and a half at play zoom, which is nothing. The test that caught it was looking for
 * variety between neighbours and found six distinct positions among twenty-five trees,
 * because the whole range had collapsed into the rounding.
 *
 * It is also the more truthful of the two. Displacement does not scale with crown size: a
 * sapling's thin branches whip in a breeze that a mature canopy barely registers, so a floor
 * belongs there and the radius term is the smaller half.
 *
 * Both numbers are set at play zoom against the wind's own average rather than its peak,
 * which is the mistake worth not repeating: a 44-unit street tree now sits about 2.0 units
 * off centre typically and 3.6 at the peak, and a 112-unit jungle tree 3.0 and 5.5. Larger
 * and the small ones look blown over. Real crown displacement is a few percent of canopy
 * width, so this is subtle BY NATURE — what makes it read is a hundred trees moving as one
 * wave, and a canopy with a broken enough silhouette to show the change.
 */
const BASE_LEAN = 2.4;
const LEAN = 0.055;
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
  // The direction the gust front is travelling, this frame, for every mover. One
  // trig pair for the whole world rather than one per tree.
  const front = wind(nowMs);

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

    /**
     * Sway. One wind, sampled late in proportion to how far along it this tree stands, so a
     * gust is visibly a wave crossing the stand rather than every canopy twitching at once.
     *
     * The dot product can be negative — a tree upwind of the origin feels the front EARLY —
     * so the sampled time runs both sides of now. That is correct and needs no clamping:
     * `wind` is a pure function of its argument and perfectly happy in the past or future.
     */
    const along = mover.about.x * front.x + mover.about.y * front.y;
    const gust = wind(nowMs - along / GUST_SPEED - mover.phase * GUST_JITTER_MS);
    const lean = (BASE_LEAN + mover.reach * LEAN) * gust.strength;
    view.position.set(about.x + gust.x * lean, about.y + gust.y * lean * 0.6);
    view.rotation = gust.strength * TWIST * gust.x;
    view.scale.set(1 + gust.strength * BREATHE * gust.y);
  }
}
