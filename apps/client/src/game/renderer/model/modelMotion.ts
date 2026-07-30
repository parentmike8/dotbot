import { Container, Graphics } from "pixi.js";
import type { MapObject, Vec2 } from "@dotbot/game/types";
import { jitter, MAT, shade, SUN } from "./tone";

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
 * The world's heaviest map has three rides and ~106 pieces of vegetation, so a full frame of
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
/**
 * Parts belonging to a glyph, in the order they were created.
 *
 * A WeakMap rather than a scan of `g.children`, and the reason is `liftParts`: an outdoor
 * canopy is RE-PARENTED onto the foreground layer so a bot can walk under it, at which point
 * it is no longer among the glyph's children and a children-scan would happily build a second
 * one on the next redraw. The registry follows the part wherever it ends up.
 */
const parts = new WeakMap<Graphics, Map<string, Graphics>>();

function partOf(g: Graphics, label: string): Graphics {
  let owned = parts.get(g);
  if (!owned) {
    owned = new Map();
    parts.set(g, owned);
  }
  const existing = owned.get(label);
  if (existing) {
    existing.clear();
    return existing;
  }
  const part = new Graphics();
  part.label = label;
  owned.set(label, part);
  g.addChild(part);
  return part;
}

/**
 * Every part a glyph created, in creation order, ready to be re-parented.
 *
 * The caller adds them to whatever layer they belong on. For a tree that is the outdoor
 * FOREGROUND — the layer that draws above bots — because reported from play: "the player
 * doesn't go under the tree canopy but they should". A canopy is passable, so a bot walking
 * beneath it must be covered by it, and the only layer that can do that is the one built for
 * exactly this ("marks that must cover a bot passing behind them").
 *
 * Creation order is preserved inside the lifted group. The outdoor builder reparents that
 * group to the overhead layer as one authored unit, while the trunk remains in the planted
 * object view.
 */
export function liftParts(g: Graphics): Graphics[] {
  return [...(parts.get(g)?.values() ?? [])];
}

/**
 * A static piece that is physically above a bot and may lean with object parallax.
 *
 * It shares the same ownership registry as ambient parts so a redraw clears and reuses
 * the existing Graphics even after the outdoor builder has reparented it. Unlike a
 * `movingPart`, it is absent from `collectMovers`; camera parallax moves the authored
 * elevated group, not this part's own transform.
 */
export function elevatedPart(g: Graphics, name: string): Graphics {
  if (typeof (g as { addChild?: unknown }).addChild !== "function") return g;
  return partOf(g, `elevated:${name}`);
}

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
   * This is a widened contract, not a silent fallback: `collectMovers` finds no tagged part
   * and reports no mover, which is the truthful answer for a sink that cannot move.
   */
  if (typeof (g as { addChild?: unknown }).addChild !== "function") return g;
  const part = partOf(g, LABEL[kind]);
  part.pivot.set(about.x, about.y);
  if (part.position.x === 0 && part.position.y === 0) part.position.set(about.x, about.y);
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
  // The registry rather than `view.children`, for the same reason `partOf` uses it: by the
  // time a second builder asks, an outdoor canopy has been lifted onto the foreground layer.
  for (const child of parts.get(view as Graphics)?.values() ?? []) {
    const kind = (Object.keys(LABEL) as AmbientKind[]).find((key) => LABEL[key] === child.label);
    if (!kind) continue;
    movers.push({
      kind,
      view: child,
      about: { x: child.pivot.x, y: child.pivot.y },
      phase: jitter(o.id, 3),
      reach: Math.min(o.w, o.h) / 2,
      // Three rides in one region turning at the same pace read as one object repeated.
      // The waltzer is the heavy reverse; the open chair ring is the most wind-responsive.
      drift: kind === "spin"
        ? o.kind === "waltzer"
          ? -SPIN.slow
          : o.kind === "swingRide"
            ? SPIN.chair
            : SPIN.creep
        : 0,
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
  chair: (Math.PI * 2) / 118_000,
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

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/**
 * LEAVES COMING OFF THE TREES — a fixed pool, recycled, never allocated per frame.
 *
 * `docs/world-motion.md` sets the mechanism out: "a fixed pool of sprites recycled
 * oldest-first, age → alpha", and "spawn only what is on screen". Both matter for the same
 * reason the rest of this module builds geometry once — a particle system that allocates is
 * the one shape of ambient motion that would actually cost something.
 *
 * TWO THINGS IT DELIBERATELY IS NOT.
 *
 * It is not random. `Math.random()` would be fine here — nothing about a leaf is replicated —
 * but the lab renders one deterministic frame at a given clock, and a pool that reshuffles on
 * every call makes two shots of the same crop incomparable, which is the whole job of that
 * surface. Every leaf's spawn comes out of `jitter` on its own index and generation, so
 * `?t=6000` is the same frame twice.
 *
 * And it is not a physics simulation. A leaf's whole life is a function of its age: it comes
 * off a canopy, is carried by the same wind the canopy is leaning in, flutters on its own
 * beat, and fades. No integration, no state to keep in step, nothing to go wrong when the
 * clock jumps because the tab was in the background.
 */
export type LeafFall = {
  /** The pool's own container; parented once, into the outdoor detail layer. */
  view: Container;
  leaves: Graphics[];
  /**
   * The tree each leaf came off, BY IDENTITY.
   *
   * Not an index. It was an index into the filtered on-screen list, and that made the pool
   * depend on the camera: reported from play, "as my player moves around, the leaves
   * reconfigure and jump around on the screen." Walking made trees enter and leave the
   * filtered array, every index shifted under the leaves holding it, and each one silently
   * re-bound to a different tree mid-fall — a whole screen of leaves teleporting because the
   * player took a step. Holding the mover itself makes a leaf's life independent of where the
   * camera is, which is what ambient means.
   */
  from: (AmbientMover | null)[];
  born: number[];
  generation: number[];
};

/** Pool size. Enough for a stand of trees to be shedding, few enough to be free. */
const LEAF_COUNT = 48;
/** How long one leaf's fall lasts, and the stagger between them. */
const LEAF_LIFE_MS = 5_200;
/**
 * How far a leaf drifts over its life, as a share of its own tree's radius.
 *
 * A THIRD, where it used to be 2.1 — reported as "they shouldn't move too horizontally far
 * from the tree itself", and right: at 2.1 radii a leaf crossed the next tree along, which
 * reads as debris blowing through rather than as a tree shedding.
 */
const LEAF_CARRY = 0.34;
/** The wind's remaining say, on top of the radial drift. Small: a bias, not the motion. */
const LEAF_WIND = 0.16;

export function buildLeafFall(): LeafFall {
  const view = new Container();
  const leaves: Graphics[] = [];
  for (let i = 0; i < LEAF_COUNT; i += 1) {
    const leaf = new Graphics();
    /**
     * ONE leaf, drawn once, in LOCAL coordinates — the only thing in this module that is.
     *
     * Everything else here moves geometry that was laid out in world space, because a glyph
     * draws where the object is. A leaf has no authored position at all, so it is drawn at
     * the origin and positioned per frame, which is what lets one shape serve forty-eight
     * leaves without a redraw.
     *
     * A blade rather than a disc: a round speck at this scale is a dust mote, and dust is a
     * different claim about the weather.
     */
    /**
     * FIVE UNITS, and the first pass at 3.4 was too small to read.
     *
     * At play zoom a world unit is roughly a pixel, so a 3.4-unit blade is a seven-pixel
     * fleck and the pool looked like dust on the lens. Five with a lighter core gives it an
     * inside and an outside, which is what stops a small mark reading as a speck.
     *
     * It stays MID-DARK rather than being made legible on every ground it can land on, and
     * that is a decision: #53 solved exactly that problem for world TEXT, where the cost of
     * being unreadable is a player missing information. A leaf carries none. One that is hard
     * to pick out over dark scrub is a leaf over dark scrub.
     */
    const long = 5;
    leaf.poly([-long, 0, 0, -long * 0.42, long, 0, 0, long * 0.42])
      .fill({ color: shade(MAT.foliage.top, 0.66) });
    leaf.poly([-long * 0.5, 0, 0, -long * 0.24, long * 0.5, 0, 0, long * 0.24])
      .fill({ color: shade(MAT.foliage.top, 0.92) });
    view.addChild(leaf);
    leaves.push(leaf);
  }
  return {
    view,
    leaves,
    from: new Array<AmbientMover | null>(LEAF_COUNT).fill(null),
    born: new Array(LEAF_COUNT).fill(0),
    generation: new Array(LEAF_COUNT).fill(-1),
  };
}

/**
 * Move every leaf for this frame, respawning the ones whose fall is over.
 *
 * `bounds` is the world rectangle on screen — `GameRenderer.visibleWorldBounds()`, the same
 * answer audio earshot uses. A leaf only ever spawns off a tree inside it, which is the
 * difference between forty-eight leaves where the player is looking and forty-eight leaves
 * spread over a 4,200-unit sheet where none of them is visible.
 */
export function driftLeaves(
  fall: LeafFall,
  movers: readonly AmbientMover[],
  nowMs: number,
  bounds: { x: number; y: number; w: number; h: number } | null,
  reducedMotion: boolean,
): void {
  const trees = movers.filter((mover) => mover.kind === "sway");
  const onScreen = bounds
    ? trees.filter((tree) => tree.about.x >= bounds.x && tree.about.x <= bounds.x + bounds.w
      && tree.about.y >= bounds.y && tree.about.y <= bounds.y + bounds.h)
    : trees;

  // Nothing to fall from, or nobody wants motion. Hidden rather than parked off-screen: an
  // invisible container costs nothing to skip and a parked sprite still gets a transform.
  fall.view.visible = !reducedMotion && onScreen.length > 0;
  if (!fall.view.visible) return;

  const front = wind(nowMs);

  for (let i = 0; i < fall.leaves.length; i += 1) {
    const leaf = fall.leaves[i];
    /**
     * The generation, which is what makes this deterministic AND self-starting.
     *
     * A leaf's life is `LEAF_LIFE_MS` long and they are staggered a fraction of that apart,
     * so which generation a leaf is in is a pure function of the clock. No spawn bookkeeping,
     * no first-frame special case, and the same clock always gives the same frame.
     */
    const stagger = (i / fall.leaves.length) * LEAF_LIFE_MS;
    const generation = Math.floor((nowMs + stagger) / LEAF_LIFE_MS);
    const age = ((nowMs + stagger) % LEAF_LIFE_MS) / LEAF_LIFE_MS;

    if (generation !== fall.generation[i]) {
      fall.generation[i] = generation;
      /**
       * Pick a tree from the visible ones, ONCE, at the start of this leaf's life.
       *
       * The visible set is the right thing to choose from — forty-eight leaves spread over a
       * 4,200-unit sheet is none of them on screen — but it is the wrong thing to keep looking
       * up. Chosen here and held for the whole fall, so a leaf that started on a tree you have
       * since walked past finishes its fall on that tree rather than jumping to another.
       */
      const pick = jitter(`leaf-${i}`, generation & 0xffff);
      fall.from[i] = onScreen[Math.min(onScreen.length - 1, Math.floor(pick * onScreen.length))];
      fall.born[i] = nowMs;
    }

    const tree = fall.from[i];
    if (!tree) continue;

    // Where on the canopy it came off, held for the whole fall.
    const seed = `leaf-${i}-${fall.generation[i]}`;
    const angle = jitter(seed, 1) * Math.PI * 2;
    /**
     * OUTSIDE the canopy from the start, and this is the third placement.
     *
     * Reported on sight: leaves inside the crown read as marks ON the tree rather than as
     * leaves — in a still frame they are little diamonds lying on the leaves, which is the
     * frozen-artefact problem rule 4 exists for, arrived at in a new place. At 0.62..1.0 of the
     * reach most of the pool was over its own canopy at any instant.
     *
     * Starting past the rim means every leaf you can see is one that has already left.
     */
    const out = tree.reach * (1.02 + jitter(seed, 2) * 0.3);
    const gust = wind(nowMs - (tree.about.x * front.x + tree.about.y * front.y) / GUST_SPEED);

    /**
     * IT DROPS. It does not get blown across the screen.
     *
     * Reported: "the leaves look like they're moving sideways instead of down ... away from the
     * tree, though that probably varies by tree ... they should get smaller as they move down
     * and they shouldn't move too horizontally far from the tree itself."
     *
     * Three corrections, and the first is the one that was actually wrong. Travel was along the
     * GLOBAL wind vector, so every leaf on screen slid the same way at once — which is what a
     * gust does to litter and not what a tree does to its own leaves. It is now RADIAL, outward
     * from the canopy the leaf came off, so each tree sheds in its own directions and the whole
     * screen stops moving as one.
     *
     * Second, the distance. `LEAF_CARRY` was 2.1 canopy radii, which took a leaf clear across
     * the next tree. A leaf falls close to the thing it fell off.
     *
     * Third, and it is the cue that makes the whole thing read: IT SHRINKS. From directly
     * above, a leaf leaving the canopy and reaching the ground is moving AWAY from the camera,
     * so the honest depth cue is scale. That is what says "down" in a projection with no down —
     * the same reason height is drawn as a shadow length here rather than as a vertical offset.
     *
     * The wind keeps a small say — a slight bias on top of the radial drift, so a stand of
     * trees still sheds a little downwind — but it no longer owns the motion.
     */
    const drift = tree.reach * LEAF_CARRY * age;
    const bias = tree.reach * LEAF_WIND * age * gust.strength;
    // The flutter crosses the leaf's own path rather than following it: a mark that only
    // accelerates in one direction reads as a thrown object, not as something weightless.
    const flutter = Math.sin(age * 11 + jitter(seed, 3) * 6.3) * tree.reach * 0.07;
    leaf.position.set(
      tree.about.x + Math.cos(angle) * (out + drift) - Math.sin(angle) * flutter + gust.x * bias,
      tree.about.y + Math.sin(angle) * (out + drift) + Math.cos(angle) * flutter + gust.y * bias,
    );
    leaf.rotation = angle + age * 9 * (jitter(seed, 4) > 0.5 ? 1 : -1);
    // Falling away from the camera. Never to nothing: a leaf that shrinks to a point vanishes
    // by scale and by alpha at once, which reads as a glitch rather than as a landing.
    leaf.scale.set(1 - age * 0.55);
    /**
     * In and out, never popping.
     *
     * Held at zero for the first and last tenth of the life so a leaf appears and settles
     * rather than blinking into existence at full strength — which on a fixed pool is the
     * artefact you notice, because it happens forty-eight times a cycle in the same rhythm.
     */
    leaf.alpha = Math.min(1, Math.min(age, 1 - age) * 10) * 0.85;
  }
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

/**
 * THE MARK A DOTBOT LEAVES ON GROUND SOFT ENOUGH TO TAKE ONE.
 *
 * The third and last of the ambient set, and the only one that is NOT a pure function of the
 * clock: a leaf's whole life is `age`, but a trail is where somebody went, so it has history.
 * That is a real difference from the rest of this module and worth naming — it is still
 * cosmetic and still never replicated, but the pool holds state, and the state is stamps.
 *
 * WHICH GROUND, and it is not a renderer opinion. `@dotbot/game/ground` names every piece of
 * ground by its use and answers whether that use keeps an impression; the caller asks. Growth
 * to flatten, earth to scuff, ballast to turn over — a footway keeps nothing, so nothing is
 * drawn on one.
 *
 * IT IS A DIVOT, AND A DIVOT IS THE INVERSE OF A LUMP. Reported on sight of the first version:
 * "I don't like how it's just circles, should instead be sort of a divot in the ground." The
 * first pass was a flat dark ellipse with a darker core, which is a STAIN — paint on the
 * ground rather than ground that has been pressed — and a row of them beaded into a string of
 * circles because each one had its own visible outline.
 *
 * There is one light, from the north-west. Everything raised in this world is lit on its
 * north-west face, shaded on its south-east face, and throws a shadow south-east. A HOLLOW
 * READS BY DOING EXACTLY THE OPPOSITE: its inner wall on the south-east side turns back into
 * the light and is LIT, its north-west lip faces away and is SHADED, and it casts nothing at
 * all. That inversion is the entire cue — get it backwards and the trail reads as a row of
 * pebbles laid on the grass.
 *
 * AND IT IS WHAT KILLS THE BEADING. The lips run ALONG the channel, so consecutive marks merge
 * into two continuous lines — a shaded edge and a lit edge with disturbed ground between them,
 * which is what a rut looks like from above. One mark on its own is a divot; twenty in a row
 * are a track. Both readings come out of the same geometry.
 *
 * SO A MARK IS DRAWN AT STAMP TIME, in world coordinates, which is the one place this module
 * breaks its own build-once rule — and deliberately. The shading is fixed to the world's light
 * while the shape turns with travel, so the two cannot both live in one pre-built local
 * drawing: rotating the shape would rotate the sun with it. A stamp is an EVENT, not a frame —
 * about twelve a second per bot against 108 movers transformed sixty times a second — so
 * rebuilding one small ellipse there is nothing, and it is the only way the light stays put.
 *
 * A DUST PUFF IS A DIFFERENT FEATURE. Something airborne kicked up off dry ground is not a
 * ground mark, it is a particle, and it would want the leaf pool's machinery rather than this.
 */
export type TrailMarks = {
  /** The pool's own container; parented once, into the outdoor detail layer. */
  view: Container;
  marks: Graphics[];
  born: number[];
  /** Geometry and links for the segment currently occupying each pooled mark. */
  segments: Array<TrailSegment | null>;
  /** Most recent segment in each independently moving bot's trail. */
  tails: Map<string, number>;
  /** Ring cursor. The pool recycles oldest-first because the oldest is the faintest. */
  next: number;
};

type TrailSegment = {
  from: Vec2;
  to: Vec2;
  heading: number;
  startAcross: Vec2;
  endAcross: Vec2;
  startCap: boolean;
  endCap: boolean;
  chainId: string;
  prev: number | null;
  next: number | null;
};

/**
 * How far a DotBot travels between marks, in world units.
 *
 * Exported because the MARK IS SIZED AGAINST IT: at 44 units long and stamped every 24, each
 * mark overlaps its neighbour by nearly half, which is what turns a row of stamps into one
 * band with a soft edge instead of a dotted line. Change one and the other has to move.
 */
export const TRAIL_STRIDE = 24;
/**
 * Pool size, and it is a budget rather than a guess.
 *
 * A bot walks at 300 units/s (`MOVING_SPEED` 5 at 60 Hz), so it lays about 12 marks a second
 * and roughly 30 over one mark's life. 120 covers four bots crossing soft ground at once,
 * which is a squad; beyond that the oldest tail truncates, and the oldest tail is the part
 * already nearly transparent.
 */
const TRAIL_COUNT = 120;
/**
 * How long a mark lasts.
 *
 * SHORT ON PURPOSE, and this is a game-design line rather than an art one. At a couple of
 * seconds a trail says "the ground here has just been crossed", which is ambient. At ten it
 * becomes TRACKING — a way to follow a player who is long out of sight — and that is a
 * mechanic with balance consequences, not a piece of dressing. The machinery is the same
 * either way, so promoting it later is one constant; doing it silently inside a motion pass
 * would be shipping a feature nobody asked for.
 */
const TRAIL_LIFE_MS = 2_600;

/**
 * Half-width of the channel, across travel.
 *
 * 32 across against a 48-unit body: inside the silhouette, because the rim of a disc bears less
 * than its middle and a channel the full width of the bot reads as a painted stripe rather than
 * as ground giving way under it.
 *
 * THERE IS NO HALF-LENGTH ANY MORE, and that was the actual bug behind three rounds of
 * "straight lines jut out on turns". A mark used to be a fixed 48-unit shape centred on its
 * stamp point while the stride was 24 — so every mark overhung the midpoint between stamps by
 * 12 units at BOTH ends. On a gentle curve that is invisible. On a hairpin the overhang of the
 * mark before the corner still points the old way while the mark after it points the new way,
 * and the two run straight through each other: a starburst of slivers at every sharp turn.
 *
 * A mark is now the SEGMENT BETWEEN TWO CONSECUTIVE STAMP POINTS. It cannot overhang, because it
 * has no length of its own — it is exactly as long as the ground the bot covered.
 */
const TRAIL_HALF_WIDE = 16;
/**
 * How far the channel is pushed apart along the light, in world units.
 *
 * THE LIPS ARE ON THE SUN'S AXIS, NOT ON TRAVEL'S, and getting that wrong is what took three
 * rounds. They were two narrow bands down the LEFT and RIGHT sides of the channel — and left and
 * right swap when a bot turns through more than a right angle, so at every sharp corner the two
 * lips ran straight through each other. Magnified, a hairpin came out as an X of crossed lines.
 *
 * A hollow does not have a left lip and a right lip. It has an UP-LIGHT lip, which faces away
 * from the sun and is shaded, and a DOWN-LIGHT lip, whose inner wall turns back into the sun and
 * is lit. That axis is fixed to the world, so consecutive marks always offset the same way, and a
 * reversal has nothing to cross.
 *
 * Drawn as two whole copies of the channel offset along that axis — the same trick `volumeShape`
 * uses for height, run the other way. Where they overlap they very nearly cancel and the ground
 * shows through; what is left is a shaded crescent on one rim and a lit one on the other.
 */
const LIP_OFFSET = 5;
/**
 * The two tones. Alphas of the same order as `SHADOW_ALPHA`'s first steps, because a lip is the
 * same phenomenon: a surface turned away from the one light.
 *
 * They are also chosen to CANCEL over the overlap. Black at 0.055 then white at 0.075 leaves
 * mid-grey ground within a level of where it started, so the middle of the channel is untouched
 * and only the two rims carry the mark — which is what keeps it subtle: "it should be subtle,
 * not a complete distortion of the path that's been navigated."
 */
const LIP_SHADE = 0.055;
const LIP_LIT = 0.075;
/**
 * THERE IS NO FLOOR FILL, and that is the second thing removed rather than tuned.
 *
 * Reported: "in the path I'm seeing little circles, which I shouldn't see." A faint ellipse
 * filling the hollow is the ORIGINAL bead-chain defect at a lower alpha — consecutive marks
 * overlap by half, so the fills stack into a scalloped row of rounder, darker blobs and the eye
 * finds the circles immediately however faint each one is.
 *
 * A shallow dent barely darkens its own floor anyway. What you actually see of one is the rim
 * lighting, so the two lips are the whole mark and the ground between them is left alone. Fewer
 * marks, subtler, and nothing that can bead.
 */
/**
 * The strongest ink any one mark lays down.
 *
 * Exported so SUBTLE can be asserted rather than asserted about. Reported alongside the divot
 * note: "it should be subtle, not a complete distortion of the path that's been navigated" —
 * and 59% of the world is soft ground, so this is on screen almost the whole time. A scuff may
 * never be heavier than the shadow a solid object casts.
 */
export const TRAIL_MARK_MAX_ALPHA = Math.max(LIP_LIT, LIP_SHADE);

/** A DotBot's body is 48 across; the channel it presses is narrower than that. */
export const TRAIL_CHANNEL_WIDTH = TRAIL_HALF_WIDE * 2;

export function buildTrailMarks(): TrailMarks {
  const view = new Container();
  const marks: Graphics[] = [];
  for (let i = 0; i < TRAIL_COUNT; i += 1) {
    // Geometry arrives at stamp time — see the note on this section. Empty and hidden until
    // something walks over the ground this mark will land on.
    const mark = new Graphics();
    mark.visible = false;
    view.addChild(mark);
    marks.push(mark);
  }
  return {
    view,
    marks,
    born: new Array(TRAIL_COUNT).fill(-Infinity),
    segments: new Array<TrailSegment | null>(TRAIL_COUNT).fill(null),
    tails: new Map(),
    next: 0,
  };
}

/**
 * One length of hollow, in world coordinates, running from `from` to `to`.
 *
 * TWO LIPS AND NOTHING ELSE, each a plain quad down one side of the channel. Which one is lit is
 * decided by the SUN alone, so a bot walking north and a bot walking south leave marks shaded on
 * the same side of the world — the property a pre-rotated sprite cannot have, and the reason
 * this is drawn per stamp rather than built once.
 *
 * Quads rather than the tapered eight-point bands they replaced. The taper existed to blend
 * marks that overlapped by half, and segments do not overlap: each one starts where the last
 * ended, so consecutive lips are collinear along a straight run and meet at a shallow mitre on a
 * bend. Nothing to blend, and nothing to stick out.
 */
/**
 * The two quads a divot is made of, as geometry, with no drawing.
 *
 * Split out from `divot` so the lighting rule can be MEASURED rather than looked at. The bug it
 * exists to prevent cost three rounds of review: lips offset across travel instead of along the
 * light, which swap sides whenever a bot turns past a right angle and cross each other at a
 * hairpin. A test can now assert that the lit quad sits down-light of the shaded one for every
 * heading on the compass, which is the whole rule in one line.
 */
export function divotQuads(
  from: Vec2,
  to: Vec2,
  heading: number,
  ends?: { startAcross?: Vec2; endAcross?: Vec2 },
): { shade: Vec2[]; lit: Vec2[] } {
  const along = { x: Math.cos(heading), y: Math.sin(heading) };
  const across = { x: -along.y, y: along.x };
  const startAcross = ends?.startAcross ?? {
    x: across.x * TRAIL_HALF_WIDE,
    y: across.y * TRAIL_HALF_WIDE,
  };
  const endAcross = ends?.endAcross ?? {
    x: across.x * TRAIL_HALF_WIDE,
    y: across.y * TRAIL_HALF_WIDE,
  };
  const lit = litSide();

  const channel = (shift: number): Vec2[] => {
    const sx = lit.x * shift;
    const sy = lit.y * shift;
    return [
      { x: from.x + sx - startAcross.x, y: from.y + sy - startAcross.y },
      { x: to.x + sx - endAcross.x, y: to.y + sy - endAcross.y },
      { x: to.x + sx + endAcross.x, y: to.y + sy + endAcross.y },
      { x: from.x + sx + startAcross.x, y: from.y + sy + startAcross.y },
    ];
  };

  return { shade: channel(-LIP_OFFSET), lit: channel(LIP_OFFSET) };
}

/**
 * One cross-section shared by the two segments meeting at a turn.
 *
 * The old implementation ended every stamp with its own perpendicular edge. On a turn those
 * two edges rotate apart, exposing the square end of each stamp. A miter is one edge used by
 * both segments, so there is no cap, gap, or double-covered rung at the join. Very sharp turns
 * are clamped before the miter can grow into a spike; both neighbours still receive the same
 * clamped edge and therefore remain continuous.
 */
export function trailJoin(incomingHeading: number, outgoingHeading: number): Vec2 {
  const inNormal = { x: -Math.sin(incomingHeading), y: Math.cos(incomingHeading) };
  const outNormal = { x: -Math.sin(outgoingHeading), y: Math.cos(outgoingHeading) };
  const mx = inNormal.x + outNormal.x;
  const my = inNormal.y + outNormal.y;
  const magnitude = Math.hypot(mx, my);
  if (magnitude < 1e-5) {
    return {
      x: outNormal.x * TRAIL_HALF_WIDE,
      y: outNormal.y * TRAIL_HALF_WIDE,
    };
  }
  const unit = { x: mx / magnitude, y: my / magnitude };
  const projection = Math.max(0.25, unit.x * outNormal.x + unit.y * outNormal.y);
  const length = Math.min(TRAIL_HALF_WIDE * 1.6, TRAIL_HALF_WIDE / projection);
  return { x: unit.x * length, y: unit.y * length };
}

const CAP_STEPS = 6;

function channelPolygon(segment: TrailSegment, shift: number): Vec2[] {
  const lit = litSide();
  const sx = lit.x * shift;
  const sy = lit.y * shift;
  const shifted = (point: Vec2): Vec2 => ({ x: point.x + sx, y: point.y + sy });
  const points: Vec2[] = [
    shifted({
      x: segment.from.x - segment.startAcross.x,
      y: segment.from.y - segment.startAcross.y,
    }),
    shifted({
      x: segment.to.x - segment.endAcross.x,
      y: segment.to.y - segment.endAcross.y,
    }),
  ];

  if (segment.endCap) {
    for (let i = 1; i < CAP_STEPS; i += 1) {
      const angle = segment.heading - Math.PI / 2 + (Math.PI * i) / CAP_STEPS;
      points.push(shifted({
        x: segment.to.x + Math.cos(angle) * TRAIL_HALF_WIDE,
        y: segment.to.y + Math.sin(angle) * TRAIL_HALF_WIDE,
      }));
    }
  }
  points.push(shifted({
    x: segment.to.x + segment.endAcross.x,
    y: segment.to.y + segment.endAcross.y,
  }));
  points.push(shifted({
    x: segment.from.x + segment.startAcross.x,
    y: segment.from.y + segment.startAcross.y,
  }));
  if (segment.startCap) {
    for (let i = 1; i < CAP_STEPS; i += 1) {
      const angle = segment.heading + Math.PI / 2 + (Math.PI * i) / CAP_STEPS;
      points.push(shifted({
        x: segment.from.x + Math.cos(angle) * TRAIL_HALF_WIDE,
        y: segment.from.y + Math.sin(angle) * TRAIL_HALF_WIDE,
      }));
    }
  }
  return points;
}

function divot(g: Graphics, segment: TrailSegment): void {
  // Up-light first: the rim that faces away from the sun. Then down-light, whose inner wall
  // turns back into it. Their overlap is the channel's floor and comes out very near untouched.
  g.poly(channelPolygon(segment, -LIP_OFFSET))
    .fill({ color: 0x000000, alpha: LIP_SHADE });
  g.poly(channelPolygon(segment, LIP_OFFSET))
    .fill({ color: 0xffffff, alpha: LIP_LIT });
}

/**
 * Which side of a mark the light reaches, as a world vector.
 *
 * THE INVERSION LIVES HERE, on its own, because it is the one thing about a trail that is a
 * rule rather than a taste. A hollow's down-light inner wall turns back into the sun and is
 * LIT; its up-light lip faces away and is shaded — the exact opposite of every raised thing in
 * the world, all of which are lit on the north-west and shaded on the south-east.
 *
 * Get the sign backwards and the whole trail reads as a row of pebbles laid on the grass: a
 * picture that looks fine until you notice it is lit inside out. Exported so it can be checked
 * against `SUN` directly instead of eyeballed at one heading.
 */
export function litSide(): Vec2 {
  const sun = Math.hypot(SUN.x, SUN.y);
  return { x: SUN.x / sun, y: SUN.y / sun };
}

/**
 * Scuff the ground between two consecutive stamp points.
 *
 * Both ends, not a centre and a direction: a segment cannot overhang the path it was walked on,
 * which is what three rounds of "straight lines jut out on turns" turned out to be about.
 */
export function stampTrail(
  trail: TrailMarks,
  from: Vec2,
  to: Vec2,
  heading: number,
  nowMs: number,
  chainId = "default",
): void {
  const i = trail.next;
  trail.next = (i + 1) % trail.marks.length;
  removeTrailSegment(trail, i);

  const normal = {
    x: -Math.sin(heading) * TRAIL_HALF_WIDE,
    y: Math.cos(heading) * TRAIL_HALF_WIDE,
  };
  const previousIndex = trail.tails.get(chainId);
  const previous = previousIndex === undefined ? null : trail.segments[previousIndex];
  const connects = previous !== null && previousIndex !== undefined
    && nowMs - trail.born[previousIndex] < TRAIL_LIFE_MS
    && Math.hypot(previous.to.x - from.x, previous.to.y - from.y) < 0.01;
  const joinedAcross = connects && previous
    ? trailJoin(previous.heading, heading)
    : normal;

  const segment: TrailSegment = {
    from: { ...from },
    to: { ...to },
    heading,
    startAcross: { ...joinedAcross },
    endAcross: { ...normal },
    startCap: !connects,
    endCap: true,
    chainId,
    prev: connects ? previousIndex! : null,
    next: null,
  };
  trail.segments[i] = segment;

  if (connects && previous && previousIndex !== undefined) {
    previous.endAcross = { ...joinedAcross };
    previous.endCap = false;
    previous.next = i;
    redrawTrailSegment(trail, previousIndex);
  }

  redrawTrailSegment(trail, i);
  trail.tails.set(chainId, i);
  trail.born[i] = nowMs;
}

function redrawTrailSegment(trail: TrailMarks, index: number): void {
  const mark = trail.marks[index];
  const segment = trail.segments[index];
  mark.clear();
  if (segment) divot(mark, segment);
}

function removeTrailSegment(trail: TrailMarks, index: number): void {
  const segment = trail.segments[index];
  if (!segment) return;

  const previous = segment.prev === null ? null : trail.segments[segment.prev];
  const next = segment.next === null ? null : trail.segments[segment.next];
  if (previous && previous.next === index) {
    previous.next = null;
    previous.endCap = true;
    redrawTrailSegment(trail, segment.prev!);
  }
  if (next && next.prev === index) {
    next.prev = null;
    next.startCap = true;
    redrawTrailSegment(trail, segment.next!);
  }
  if (trail.tails.get(segment.chainId) === index) {
    trail.tails.delete(segment.chainId);
  }
  trail.segments[index] = null;
  trail.marks[index].clear();
}

/**
 * Age every mark down for this frame.
 *
 * `reducedMotion` is NOT honoured here, for the reason `updateWading` gives: nothing in this
 * pool moves. A mark is stamped where a body already visibly is and then sits still while its
 * alpha falls. Parking it would mean either freezing marks on the ground forever or drawing
 * none at all, and neither is what that setting asks for.
 */
export function fadeTrail(trail: TrailMarks, nowMs: number): void {
  for (let i = 0; i < trail.marks.length; i += 1) {
    const age = (nowMs - trail.born[i]) / TRAIL_LIFE_MS;
    const mark = trail.marks[i];
    if (age >= 1 || age < 0) {
      mark.visible = false;
      if (age >= 1) removeTrailSegment(trail, i);
      continue;
    }
    mark.visible = true;
    /**
     * Full for the first third, then out.
     *
     * A mark does not fade IN: the ground is disturbed the instant the body crosses it, and a
     * ramp up would put the strongest part of the trail behind where the bot actually is.
     */
    mark.alpha = Math.min(1, (1 - age) * 1.5);
  }
}

/**
 * Longer than any single frame of walking, shorter than any teleport.
 *
 * A bot covers 5 units per tick, so even a badly stalled frame is tens of units, not hundreds.
 */
const TRAIL_TELEPORT = 200;

/**
 * Whether this frame's position crosses the stride, where the anchor goes next, and the
 * heading a mark would lie along.
 *
 * PACING ONLY. Whether the ground takes a mark, and whether the player is allowed to see one,
 * is `GameRenderer`'s half — and the split is not only tidiness. Those are the expensive tests
 * (a walk of every road, region and surface; a line-of-sight trace), and gating them behind
 * this one means they run about twelve times a second per bot instead of sixty.
 *
 * THE ANCHOR ADVANCES ON EVERY CROSSING, whatever the caller then decides, which is the part
 * worth pinning. A bot that was ineligible for a while — indoors, out of sight, on paving — has
 * travelled a long way from its anchor, and an anchor that only moved on a successful stamp
 * would hand back one enormous step the moment it became eligible again. Advancing always means
 * the trail simply resumes from where the bot is.
 */
export function trailStep(
  anchor: Vec2 | undefined,
  at: Vec2,
): { crossed: boolean; from: Vec2; anchor: Vec2; heading: number } {
  const here = { x: at.x, y: at.y };
  if (!anchor) return { crossed: false, from: here, anchor: here, heading: 0 };
  const dx = at.x - anchor.x;
  const dy = at.y - anchor.y;
  const step = Math.hypot(dx, dy);
  if (step < TRAIL_STRIDE) return { crossed: false, from: anchor, anchor, heading: 0 };
  return {
    // A respawn or a floor change is not a walk. Nothing covers that much ground in one
    // frame, so a step this long is a jump and the only right answer is to leave no mark.
    crossed: step <= TRAIL_TELEPORT,
    // The segment this step closed. The caller is about to lose the old anchor, and a mark is
    // the ground BETWEEN two stamp points rather than a shape centred on one.
    from: anchor,
    anchor: here,
    heading: Math.atan2(dy, dx),
  };
}
