import { Container, Graphics } from "pixi.js";
import type { MapObject, Vec2 } from "@dotbot/game/types";
import { jitter, MAT, shade } from "./tone";

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
 * Creation order is the draw order and it matters: a tree makes its canopy first and its trunk
 * second, so the trunk still lands on top of the leaves.
 */
export function liftParts(g: Graphics): Graphics[] {
  return [...(parts.get(g)?.values() ?? [])];
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

/**
 * A child that draws OVER a moving part and does not move with it.
 *
 * The one case is a tree's trunk. Children draw in order, so a still child added after the
 * canopy lands on top of it while keeping its own transform at rest — which is the only way
 * to draw the collider over the scenery without the scenery dragging it around.
 *
 * Idempotent for the same reason `movingPart` is, and it is worth saying that this was
 * learned the hard way twice in one session: the first version of the trunk child was
 * unconditional, and the redraw test that had just been written for `movingPart` caught it
 * growing a trunk per camera step.
 */
export function stillPart(g: Graphics, name: string): Graphics {
  // A drawing sink that is not a display list gets the marks directly, exactly as in
  // `movingPart` — and here the fallback is not even a compromise: with no moving sibling to
  // draw over, "on top" is just "last", which is where it already is.
  if (typeof (g as { addChild?: unknown }).addChild !== "function") return g;
  return partOf(g, `still:${name}`);
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
  /** Which tree each leaf last came off, and the generation that chose it. */
  from: number[];
  born: number[];
  generation: number[];
};

/** Pool size. Enough for a stand of trees to be shedding, few enough to be free. */
const LEAF_COUNT = 48;
/** How long one leaf's fall lasts, and the stagger between them. */
const LEAF_LIFE_MS = 5_200;
/** How far the wind carries a leaf over its life, as a share of its tree's radius. */
const LEAF_CARRY = 1.5;

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
    from: new Array(LEAF_COUNT).fill(0),
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
      // Pick a tree from the visible ones. Deterministic per leaf per generation.
      const pick = jitter(`leaf-${i}`, generation & 0xffff);
      fall.from[i] = Math.min(onScreen.length - 1, Math.floor(pick * onScreen.length));
      fall.born[i] = nowMs;
    }

    const tree = onScreen[Math.min(fall.from[i], onScreen.length - 1)];
    if (!tree) continue;

    // Where on the canopy it came off, held for the whole fall.
    const seed = `leaf-${i}-${fall.generation[i]}`;
    const angle = jitter(seed, 1) * Math.PI * 2;
    // Off the RIM, not out of the middle: a leaf that appears at a canopy's centre and
    // travels outward reads as being emitted by the tree rather than falling off it.
    const out = tree.reach * (0.62 + jitter(seed, 2) * 0.4);
    const gust = wind(nowMs - (tree.about.x * front.x + tree.about.y * front.y) / GUST_SPEED);

    /**
     * Carried downwind and fluttering across it.
     *
     * The flutter is perpendicular to the wind, not along it, because a leaf that only
     * accelerates downwind reads as a thrown object. Crossing its own path is what says
     * "this thing has no weight".
     */
    const carried = tree.reach * LEAF_CARRY * age * gust.strength;
    const flutter = Math.sin(age * 11 + jitter(seed, 3) * 6.3) * tree.reach * 0.1;
    leaf.position.set(
      tree.about.x + Math.cos(angle) * out + gust.x * carried - gust.y * flutter,
      tree.about.y + Math.sin(angle) * out + gust.y * carried + gust.x * flutter,
    );
    leaf.rotation = angle + age * 9 * (jitter(seed, 4) > 0.5 ? 1 : -1);
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
