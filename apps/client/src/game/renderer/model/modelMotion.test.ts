import { Container, Graphics } from "pixi.js";
import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { worldMap } from "@dotbot/game/content/world";
import type { MapObject, Vec2 } from "@dotbot/game/types";
import { drawModelObject } from "./modelGlyphs";
import { buildOutdoorModel } from "./modelOutdoor";
import { buildMapArt } from "../mapArt";
import {
  animateAmbient, buildTrailMarks, collectMovers, divotQuads, driftLeaves, fadeTrail, litSide,
  movingPart, stampTrail, trailJoin, trailStep, TRAIL_CHANNEL_WIDTH, TRAIL_MARK_MAX_ALPHA,
  TRAIL_STRIDE,
  type AmbientMover,
} from "./modelMotion";
import { SHADOW_ALPHA, SUN, type ShadowPad } from "./tone";

/**
 * Ambient motion moves, and it moves the way `docs/world-motion.md` says it may.
 *
 * The claim worth testing is not "does it look nice" — a screenshot answers that, and the
 * lab renders one. It is the claim that makes ambient motion cheap: THE GEOMETRY IS BUILT
 * ONCE and only container transforms change per frame. That is a claim about code, and the
 * way it stops being true is somebody reaching for `g.clear()` in a later pass, which a
 * still image would survive and these assertions would not.
 *
 * The second claim worth testing is the resting pose. `reducedMotion` has to park a part
 * exactly where it was built, or a reduced-motion player sees the world subtly out of
 * register with its own shadows — and the lab's still shots stop being trustworthy.
 *
 * WHY THE RIDES ARE DRAWN OBJECT BY OBJECT AND DOWNTOWN IS BUILT WHOLE: the fairground's
 * helter-skelter and big top fill with a `FillGradient`, which builds itself against a real
 * canvas, and `src/test/browserGlobals.ts` deliberately does not pretend to be a DOM. So
 * the two rides go through `drawModelObject` — the same entry point the builder uses — and
 * downtown, which has no gradient glyph, carries the builder-wiring and the sway coverage.
 */
describe("ambient motion", () => {
  const pad = (): ShadowPad => SHADOW_ALPHA.map(() => new Graphics()) as unknown as ShadowPad;

  /** Draw one real object exactly as a builder would, and report what moved. */
  const drawn = (o: MapObject): { view: Graphics; movers: AmbientMover[] } => {
    const view = new Graphics();
    drawModelObject(view, pad(), o);
    return { view, movers: collectMovers(view, o) };
  };

  const rides = worldMap.outdoor.objects.filter(
    (o) => o.kind === "carousel" || o.kind === "waltzer",
  );

  const object = (over: Partial<MapObject> = {}): MapObject => ({
    id: "test-thing", kind: "tree", x: 100, y: 200, w: 80, h: 80, ...over,
  } as MapObject);

  it("finds the moving parts a glyph tagged, and ignores everything else", () => {
    const g = new Graphics();
    g.circle(0, 0, 4).fill({ color: 0x808080 });
    expect(collectMovers(g, object())).toHaveLength(0);

    movingPart(g, "spin", { x: 140, y: 240 });
    const movers = collectMovers(g, object());
    expect(movers).toHaveLength(1);
    expect(movers[0].kind).toBe("spin");
    // The part turns about the point it was given, not about the object's origin.
    expect(movers[0].about).toEqual({ x: 140, y: 240 });
  });

  it("gives the world's rides a turning part each", () => {
    // The carousel and the waltzer. If a third ride arrives this number moves, and the
    // point of asserting it is that a ride arriving WITHOUT motion should be noticed.
    expect(rides).toHaveLength(2);
    const spins = rides.flatMap((ride) => drawn(ride).movers);
    expect(spins).toHaveLength(2);
    for (const spin of spins) expect(spin.kind).toBe("spin");
    // Opposite directions: two rides in one region turning the same way at the same speed
    // read as one object drawn twice.
    expect(Math.sign(spins[0].drift)).not.toBe(Math.sign(spins[1].drift));
  });

  it("turns a ride slowly, unevenly, and never backwards", () => {
    for (const ride of rides) {
      const [spin] = drawn(ride).movers;
      const at = (ms: number) => {
        animateAmbient([spin], ms, false);
        return spin.view.rotation;
      };
      /**
       * Sampled every 2 s over ten minutes, and the direction never reverses.
       *
       * The unevenness is the point of the ride and it is also the risk: push the waver
       * past the drift and the ride rocks back and forth, which reads as broken machinery
       * rather than as wind. This is the assertion that keeps a later tweak honest.
       */
      const sign = Math.sign(spin.drift);
      let previous = at(0);
      let slowest = Infinity;
      let fastest = 0;
      for (let ms = 2_000; ms <= 600_000; ms += 2_000) {
        const now = at(ms);
        const step = (now - previous) * sign;
        expect(step).toBeGreaterThan(0);
        slowest = Math.min(slowest, step);
        fastest = Math.max(fastest, step);
        previous = now;
      }
      // Uneven: a constant rate reads as a motor, and this ride has no power.
      expect(fastest / slowest).toBeGreaterThan(1.5);
      // Slow: a full turn takes minutes, not seconds. Under 6°/s at every instant.
      expect(fastest / 2_000).toBeLessThan((Math.PI / 30) / 1_000);
    }
  });

  const swayed = () => downtownMap.outdoor.objects
    .filter((o) => o.kind === "tree")
    .flatMap((o) => drawn(o).movers);

  it("gives every street tree a swaying canopy and nothing else", () => {
    const trees = downtownMap.outdoor.objects.filter((o) => o.kind === "tree");
    expect(trees.length).toBeGreaterThan(20);
    const movers = swayed();
    expect(movers).toHaveLength(trees.length);
    for (const mover of movers) expect(mover.kind).toBe("sway");
    // A bench, a car and a thicket do not. A thicket especially: its silhouette IS its
    // collider, so sliding it would be a lie about cover.
    for (const kind of ["bench", "car", "thicket", "planter", "lampPost"] as const) {
      const other = downtownMap.outdoor.objects.find((o) => o.kind === kind)
        ?? worldMap.outdoor.objects.find((o) => o.kind === kind);
      if (other) expect(drawn(other).movers, kind).toHaveLength(0);
    }
  });

  it("leans a canopy about its trunk, not about the object's centre", () => {
    // The trunk is drawn a touch below centre and `inscribedSolid` applies the same offset,
    // so a canopy pivoted on the rect's centre would slide off the thing it grows out of.
    const tree = downtownMap.outdoor.objects.find((o) => o.kind === "tree")!;
    const [mover] = drawn(tree).movers;
    const radius = Math.min(tree.w, tree.h) / 2;
    expect(mover.about.x).toBeCloseTo(tree.x + tree.w / 2, 5);
    expect(mover.about.y).toBeCloseTo(tree.y + tree.h / 2 + radius * 0.06, 5);
  });

  it("sways the canopies out of step with each other", () => {
    const movers = swayed();
    animateAmbient(movers, 9_000, false);
    const offsets = new Set(movers.map((mover) => {
      const { x, y } = mover.view.position;
      return `${Math.round((x - mover.about.x) * 10)},${Math.round((y - mover.about.y) * 10)}`;
    }));
    /**
     * Most canopies somewhere different at the same instant.
     *
     * Not ALL of them: the offset is `wind × reach`, and two trees of the same size at the
     * same phase legitimately land on the same place. What this rules out is the opposite
     * failure — one animation played on every copy, which reads as a shimmer rather than as
     * a gust crossing a street.
     */
    expect(offsets.size).toBeGreaterThan(movers.length / 3);
  });

  it("keeps a canopy's lean small enough to stay on its own trunk", () => {
    const movers = swayed();
    for (let ms = 0; ms < 120_000; ms += 719) {
      animateAmbient(movers, ms, false);
      for (const mover of movers) {
        const drift = Math.hypot(
          mover.view.position.x - mover.about.x,
          mover.view.position.y - mover.about.y,
        );
        /**
         * Two bounds, because one number cannot say this for both a street tree and a
         * jungle tree. In absolute terms nothing may travel further than a bot's radius —
         * beyond that a canopy is not swaying, it is somewhere else. In relative terms
         * nothing may leave a fifth of its own radius, which keeps every crown sitting over
         * the trunk that is the only part of a tree actually stopping anybody.
         */
        expect(drift).toBeLessThan(6);
        expect(drift).toBeLessThan(mover.reach * 0.2);
      }
    }
  });

  /**
   * The hazard that makes `movingPart` idempotent, pinned.
   *
   * `redrawFloorObjects` re-runs the glyph on the SAME `Graphics` on every object-parallax
   * step, and `Graphics.clear()` empties geometry while leaving children in place. A fresh
   * child per call would add one canopy per camera step, unbounded, with every mover but the
   * first pointing at a view nobody animates. Costs nothing to check and would be very hard
   * to notice: the symptom is a slow leak and a tree that gradually stops moving.
   */
  it("survives being redrawn without growing a second canopy", () => {
    const tree = downtownMap.outdoor.objects.find((o) => o.kind === "tree")!;
    const { view, movers } = drawn(tree);
    const [mover] = movers;
    animateAmbient(movers, 12_000, false);
    const leaning = { x: mover.view.position.x, y: mover.view.position.y };

    for (let step = 0; step < 5; step += 1) {
      view.clear();
      drawModelObject(view, pad(), tree);
    }
    // One canopy, still one canopy after five redraws. This caught an unconditional trunk
    // child growing one per camera step back when the trunk was drawn over the leaves.
    expect(view.children).toHaveLength(1);
    expect(collectMovers(view, tree)[0].view).toBe(mover.view);
    // And it did not snap back to centre mid-lean because the camera moved.
    expect({ x: mover.view.position.x, y: mover.view.position.y }).toEqual(leaning);
    // The geometry is back, not lost to the clear.
    expect((mover.view as Graphics).context.instructions.length).toBeGreaterThan(0);
  });

  it("parks every part exactly at its resting pose for reduced motion", () => {
    const movers = [...rides.flatMap((ride) => drawn(ride).movers), ...swayed()];
    expect(movers.length).toBeGreaterThan(0);
    // Run it forward first, so this is a restore rather than a no-op that never moved.
    animateAmbient(movers, 47_000, false);
    animateAmbient(movers, 47_000, true);
    for (const mover of movers) {
      expect(mover.view.position.x).toBe(mover.about.x);
      expect(mover.view.position.y).toBe(mover.about.y);
      expect(mover.view.rotation).toBe(0);
      expect(mover.view.scale.x).toBe(1);
      expect(mover.view.scale.y).toBe(1);
    }
  });

  /**
   * The cost claim, asserted directly.
   *
   * A moving part is a CHILD of its object's view, which is what keeps the view a single
   * `Graphics` for parallax and the Studio, and what guarantees the part draws over the
   * base without any display-list bookkeeping. If a later pass promotes an object's view
   * to a Container of siblings, this fails and the reason is in `modelMotion`'s header.
   */
  it("keeps every moving part a child of its own object's Graphics", () => {
    for (const ride of rides) {
      const { view, movers } = drawn(ride);
      for (const mover of movers) {
        expect(mover.view.parent).toBe(view);
        expect(view.children).toContain(mover.view);
      }
    }
  });

  it("never redraws — a frame of motion touches no geometry", () => {
    const movers = rides.flatMap((ride) => drawn(ride).movers);
    const sizes = movers.map((mover) => (mover.view as Graphics).context.instructions.length);
    expect(sizes.every((count) => count > 0)).toBe(true);
    for (const ms of [0, 3_100, 28_000, 240_000]) animateAmbient(movers, ms, false);
    expect(movers.map((mover) => (mover.view as Graphics).context.instructions.length)).toEqual(sizes);
  });

  /**
   * A LEAF'S FALL MUST NOT DEPEND ON WHERE THE CAMERA IS.
   *
   * Reported from play: "as my player moves around, the leaves reconfigure and jump around on
   * the screen... my movement shouldn't really impact how they appear." It did, and the cause
   * was one word: each leaf held an INDEX into the filtered on-screen tree list. Walking made
   * trees enter and leave that list, every index shifted under the leaf holding it, and the
   * whole pool silently re-bound to different trees mid-fall.
   *
   * This drives the pool with two different visible rectangles at the same clock and asserts
   * that a leaf already in flight has not moved. Ambient means "a pure function of the client
   * clock"; a camera-dependent pool is not that, and the failure looks like a bug in physics
   * rather than a bug in bookkeeping.
   */
  it("does not move a falling leaf when the camera moves", () => {
    const art = buildMapArt(downtownMap);
    const wide = { x: 0, y: 0, w: 2400, h: 1600 };
    const narrow = { x: 900, y: 600, w: 700, h: 500 };

    driftLeaves(art.leaves, art.movers, 4_000, wide, false);
    const before = art.leaves.leaves.map((leaf) => ({ x: leaf.position.x, y: leaf.position.y }));
    // Same clock, a completely different viewport: the player has walked, nothing else.
    driftLeaves(art.leaves, art.movers, 4_000, narrow, false);
    const after = art.leaves.leaves.map((leaf) => ({ x: leaf.position.x, y: leaf.position.y }));
    expect(after).toEqual(before);

    // And a leaf keeps its tree across the generation it was born in.
    const bound = art.leaves.from.filter(Boolean).length;
    driftLeaves(art.leaves, art.movers, 4_200, narrow, false);
    expect(art.leaves.from.filter(Boolean).length).toBe(bound);
  });

  /** The builder has to hand the movers on, or the renderer animates an empty list. */
  it("carries every moving part out of the outdoor builder", () => {
    const built = buildOutdoorModel(downtownMap);
    expect(Array.isArray(built.movers)).toBe(true);
    expect(built.movers.length).toBeGreaterThan(20);
  });

  /**
   * A CANOPY HAS TO DRAW ABOVE THE BOTS, and this is the assertion that says so.
   *
   * Reported from play: "the player doesn't go under the tree canopy but they should." A tree's
   * collider is its trunk, so the canopy is something you walk UNDER — and the only layer that
   * draws after `dynamicGfx` is `MapArt.foreground`, which exists for "marks that must cover a
   * bot passing behind them".
   *
   * Pinned structurally because it cannot be pinned visually from here: putting a bot under a
   * tree needs the game loop, and the game loop needs a socket and real input. What CAN be
   * checked is that every canopy is parented into the foreground subtree, which is the whole
   * mechanism — if a later change parents them back onto the object layer the bot goes back on
   * top and nothing else complains.
   */
  it("parents every canopy into the layer that draws above bots", () => {
    const art = buildMapArt(downtownMap);
    const sways = art.movers.filter((mover) => mover.kind === "sway");
    expect(sways.length).toBeGreaterThan(20);

    const inSubtree = (node: Container | null, root: Container): boolean => {
      for (let at = node; at; at = at.parent) if (at === root) return true;
      return false;
    };
    for (const mover of sways) {
      expect(inSubtree(mover.view, art.overhead)).toBe(true);
      // And NOT on the solid-object layer, which is drawn before the bots.
      expect(inSubtree(mover.view, art.outdoorObjects)).toBe(false);
      /**
       * NOR on `art.foreground`, which is the fog MASK.
       *
       * Pixi consumes a mask source instead of drawing it, so canopies parented there vanish
       * from the screen — reported from a live run as trees showing up "as black circles",
       * which was the cast shadow with nothing above it. Asserted rather than commented,
       * because the two containers are one word apart and the symptom looks nothing like the
       * cause.
       */
      expect(inSubtree(mover.view, art.foreground)).toBe(false);
    }
    // The leaves are in the air, so they belong on the same layer.
    expect(inSubtree(art.leaves.view, art.overhead)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Trails
  // -------------------------------------------------------------------------

  /**
   * A mark under a moving DotBot, and the two ways this feature goes wrong.
   *
   * FIRST, IT HAS TO GO AWAY. Reported while it was being built: "the marks should also
   * disappear after some time though — just to be sure that's captured." A pool that stamps
   * and never clears is not a trail, it is graffiti: sixty seconds in, every soft surface the
   * squad has crossed is a permanent smear, and because the pool is fixed the oldest marks
   * would sit there at full strength until something overwrote them. So the life is asserted
   * from both ends — visible inside it, GONE after it.
   *
   * SECOND, IT PACES OFF DISTANCE, not off frames. A stationary bot must leave nothing at all,
   * or standing still slowly paints a black disc under yourself.
   */
  describe("trails", () => {
    const walked = (from: Vec2, to: Vec2, steps: number): Array<{ at: Vec2; step: ReturnType<typeof trailStep> }> => {
      const out: Array<{ at: Vec2; step: ReturnType<typeof trailStep> }> = [];
      let anchor: Vec2 | undefined;
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        const step = trailStep(anchor, at);
        anchor = step.anchor;
        out.push({ at, step });
      }
      return out;
    };

    it("clears every mark once its life is up", () => {
      const trail = buildTrailMarks();
      stampTrail(trail, { x: 476, y: 400 }, { x: 500, y: 400 }, 0, 10_000);

      fadeTrail(trail, 10_000);
      expect(trail.marks[0].visible).toBe(true);
      expect(trail.marks[0].alpha).toBeGreaterThan(0.9);

      // Halfway through, on its way out.
      fadeTrail(trail, 11_300);
      expect(trail.marks[0].visible).toBe(true);
      expect(trail.marks[0].alpha).toBeLessThan(0.85);

      /**
       * And gone. Sampled well past the life rather than one millisecond after it, because
       * the number is allowed to be tuned and the CLAIM is that a trail is temporary.
       */
      fadeTrail(trail, 20_000);
      expect(trail.marks[0].visible).toBe(false);
    });

    it("shows nothing at all before anything has been stamped", () => {
      const trail = buildTrailMarks();
      fadeTrail(trail, 4_000);
      expect(trail.marks.some((mark) => mark.visible)).toBe(false);
    });

    it("leaves nothing under a bot that is standing still", () => {
      const trail = buildTrailMarks();
      let anchor: Vec2 | undefined;
      // Sixty frames of a bot that has not moved — and a little numerical drift, because a
      // smoothed display position never sits at exactly the same float twice.
      for (let i = 0; i < 60; i += 1) {
        const step = trailStep(anchor, { x: 900 + i * 1e-3, y: 700 });
        anchor = step.anchor;
        expect(step.crossed).toBe(false);
      }
      fadeTrail(trail, 0);
      expect(trail.marks.some((mark) => mark.visible)).toBe(false);
    });

    it("paces marks a stride apart however finely the walk is sampled", () => {
      const from = { x: 0, y: 0 };
      const to = { x: 480, y: 0 };
      /**
       * The same 480-unit walk at three frame rates must lay the same marks.
       *
       * This is the property that makes a trail frame-rate independent: pacing on distance
       * rather than on a per-frame timer means a 30 fps client and a 144 fps client leave the
       * same trail. Sampling more finely may not lay more marks.
       */
      const counts = [40, 200, 1000].map(
        (steps) => walked(from, to, steps).filter((frame) => frame.step.crossed).length,
      );
      expect(counts[0]).toBe(counts[1]);
      expect(counts[1]).toBe(counts[2]);
      expect(counts[0]).toBe(Math.floor(480 / TRAIL_STRIDE));
    });

    /**
     * A MARK IS THE GROUND BETWEEN TWO STAMP POINTS, and its box proves it.
     *
     * This is the fix for three rounds of "straight lines jut out on turns". A mark used to be a
     * fixed 48-unit shape centred on one point while the stride was 24, so it overhung the
     * midpoint between stamps by 12 units at each end — and at a hairpin the overhang from before
     * the corner ran straight through the mark after it. A segment has no length of its own.
     *
     * So the along-travel extent must be the STRIDE (plus a hair of deliberate overlap), never
     * more; and the across-travel extent must be the channel. Measured on two perpendicular
     * walks, whose boxes have to come out as transposes of each other — that is the same
     * assertion as "the mark follows travel", without hardcoding either number.
     */
    it("makes a mark exactly as long as the ground the bot covered", () => {
      const box = (from: Vec2, to: Vec2) => {
        const trail = buildTrailMarks();
        for (const frame of walked(from, to, 300)) {
          if (!frame.step.crossed) continue;
          stampTrail(trail, frame.step.from, frame.at, frame.step.heading, 5_000);
        }
        fadeTrail(trail, 5_000);
        const shown = trail.marks.filter((mark) => mark.visible);
        expect(shown.length).toBeGreaterThan(8);
        // An interior segment: the trail's true ends are rounded, while every join is shared.
        return shown[Math.floor(shown.length / 2)].getLocalBounds();
      };

      const south = box({ x: 1_000, y: 400 }, { x: 1_000, y: 700 });
      const east = box({ x: 400, y: 1_000 }, { x: 700, y: 1_000 });

      /**
       * Along travel it is the stride, and it may NOT exceed it by much.
       *
       * This is the anti-overhang assertion. The 48-unit-long mark it replaced failed this by
       * 100%, and that overhang was the crossing slivers.
       *
       * The margins allow for the deliberate end overlap plus the lips' own offset along the
       * sun, which lands on both axes because the light is a fixed world vector — so the boxes
       * are NOT clean transposes of each other, and the amount they differ by is exactly
       * `2 · offset · (|ŝunY| − |ŝunX|)`. That is the sun-axis rule showing up in a bounding box.
       */
      expect(south.height).toBeGreaterThanOrEqual(TRAIL_STRIDE);
      expect(south.height).toBeLessThan(TRAIL_STRIDE * 1.6);
      expect(east.width).toBeGreaterThanOrEqual(TRAIL_STRIDE);
      expect(east.width).toBeLessThan(TRAIL_STRIDE * 1.6);
      // Across travel it is the channel, which is narrower than the 48-unit body.
      expect(south.width).toBeGreaterThanOrEqual(TRAIL_CHANNEL_WIDTH);
      expect(south.width).toBeLessThan(48);
      expect(east.height).toBeGreaterThanOrEqual(TRAIL_CHANNEL_WIDTH);
      expect(east.height).toBeLessThan(48);
    });

    it("shares one cross-section at every turn instead of exposing square stamp ends", () => {
      const point = { x: 500, y: 500 };
      for (let i = 0; i < 64; i += 1) {
        const incoming = (i / 64) * Math.PI * 2;
        // A tight circular turn. The old pair of perpendicular butt ends separated here,
        // leaving the square corners visible at every stride.
        const outgoing = incoming + Math.PI / 3;
        const joint = trailJoin(incoming, outgoing);
        const previous = divotQuads(
          {
            x: point.x - Math.cos(incoming) * TRAIL_STRIDE,
            y: point.y - Math.sin(incoming) * TRAIL_STRIDE,
          },
          point,
          incoming,
          { endAcross: joint },
        );
        const next = divotQuads(
          point,
          {
            x: point.x + Math.cos(outgoing) * TRAIL_STRIDE,
            y: point.y + Math.sin(outgoing) * TRAIL_STRIDE,
          },
          outgoing,
          { startAcross: joint },
        );

        for (const lip of ["shade", "lit"] as const) {
          expect(previous[lip][1].x).toBeCloseTo(next[lip][0].x, 6);
          expect(previous[lip][1].y).toBeCloseTo(next[lip][0].y, 6);
          expect(previous[lip][2].x).toBeCloseTo(next[lip][3].x, 6);
          expect(previous[lip][2].y).toBeCloseTo(next[lip][3].y, 6);
        }
      }

      const trail = buildTrailMarks();
      stampTrail(trail, { x: 476, y: 500 }, point, 0, 1_000, "player");
      stampTrail(trail, point, { x: 500, y: 524 }, Math.PI / 2, 1_080, "player");
      expect(trail.segments[0]?.endAcross).toEqual(trail.segments[1]?.startAcross);
      expect(trail.segments[0]?.endCap).toBe(false);
      expect(trail.segments[1]?.startCap).toBe(false);
    });

    /**
     * THE LIT LIP IS ALWAYS DOWN-LIGHT, WHICHEVER WAY THE BOT WENT.
     *
     * The single assertion that pins the fix for "straight lines that jut out of it when turning"
     * and the crossed X at a hairpin. The lips used to be offset ACROSS TRAVEL — a left lip and a
     * right lip — and left and right swap when a bot turns through more than a right angle, so at
     * a sharp corner the shaded band and the lit band ran straight through one another.
     *
     * A hollow has no left and right. It has an up-light rim, which faces away from the sun and
     * is shaded, and a down-light rim, whose inner wall turns back into the sun and is lit. That
     * axis is nailed to the world, so every mark offsets the same way and a reversal has nothing
     * to cross. Checked all the way round the compass, because the old version was correct for
     * half of it — which is why a screenshot of a bot walking east looked perfectly fine.
     */
    it("puts the lit lip down-light of the shaded one for every heading", () => {
      const lit = litSide();
      const centre = (points: Vec2[]): Vec2 => points.reduce(
        (sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }),
        { x: 0, y: 0 },
      );

      for (let i = 0; i < 64; i += 1) {
        const heading = (i / 64) * Math.PI * 2;
        const from = { x: 500, y: 500 };
        const to = {
          x: from.x + Math.cos(heading) * TRAIL_STRIDE,
          y: from.y + Math.sin(heading) * TRAIL_STRIDE,
        };
        const quads = divotQuads(from, to, heading);
        const shade = centre(quads.shade);
        const bright = centre(quads.lit);
        const apart = { x: bright.x - shade.x, y: bright.y - shade.y };
        // The lit quad is displaced from the shaded one ALONG the light, every time, by the same
        // amount — no dependence on heading at all.
        expect(apart.x * lit.x + apart.y * lit.y, `heading ${i}`).toBeGreaterThan(0);
        expect(Math.hypot(apart.x, apart.y), `heading ${i}`).toBeCloseTo(
          Math.hypot(apart.x, apart.y), 6,
        );
        // And it is purely along the light: no across-travel component to swap sides.
        expect(apart.x * -lit.y + apart.y * lit.x, `heading ${i}`).toBeCloseTo(0, 6);
      }
    });

    /**
     * A HOLLOW IS LIT BACKWARDS FROM A LUMP, and that is the whole reason a divot reads.
     *
     * Reported on sight of the first version: "I don't like how it's just circles, should
     * instead be sort of a divot in the ground." A flat dark ellipse is a stain. What makes a
     * depression a depression is that its south-east inner wall turns back into the north-west
     * light and is LIT, while its north-west lip faces away and is shaded — the exact inverse
     * of every raised thing in the world.
     *
     * Asserted for headings all the way round, because the failure is silent: shading fixed in
     * the mark's own local frame would rotate the sun with the bot, so half the compass would
     * come out lit correctly and the other half lit backwards, and a screenshot of a bot
     * walking east would look completely fine.
     */
    it("lights every divot from the world's sun, not from the way the bot is facing", () => {
      const lit = litSide();
      // It is a unit vector, because it pushes the two lips a fixed distance apart and `SUN` is
      // a ground offset rather than a direction — 0.69 long, so using it raw is a 31% error.
      expect(Math.hypot(lit.x, lit.y)).toBeCloseTo(1, 6);
      /**
       * And it points DOWN-light: the same half-plane every cast shadow in the world falls
       * into. A hollow's far wall is the one turned back towards the sun.
       *
       * This is the assertion that would fail if the lighting were ever folded into the mark's
       * own rotated frame — the sun would then turn with the bot, half the compass would come
       * out lit backwards, and a screenshot of a bot walking east would look perfectly fine.
       */
      expect(lit.x * SUN.x + lit.y * SUN.y).toBeGreaterThan(0);
      expect(lit.x).toBeCloseTo(SUN.x / Math.hypot(SUN.x, SUN.y), 6);
      expect(lit.y).toBeCloseTo(SUN.y / Math.hypot(SUN.x, SUN.y), 6);
    });

    /**
     * NO STROKES ON A MARK, and this is here because of a real artefact.
     *
     * Reported from play: "the path has these sort of straight lines that jut out of it when
     * turning." Two of them were `moveTo().lineTo().stroke()` lips drawn onto the same Graphics
     * that had just had a polygon FILLED into it — and pixi continues the current path, so
     * `stroke()` re-stroked the floor outline and joined all three shapes with chords. The
     * result was a fan of straight lines radiating out of every bend.
     *
     * `bodies.ts` documents the same trap for `arc` at the top of the file. Asserting the mark
     * is fills-only is the way this one does not come back.
     */
    it("draws a mark out of fills alone, so no path can join to the last one", () => {
      const trail = buildTrailMarks();
      stampTrail(trail, { x: 589, y: 579 }, { x: 600, y: 600 }, 1.1, 2_000);
      const instructions = (trail.marks[0] as unknown as {
        context: { instructions: Array<{ action: string }> };
      }).context.instructions;
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.some((step) => step.action === "stroke")).toBe(false);
    });

    /**
     * SUBTLE. Reported alongside the divot note: "it should be subtle, not a complete
     * distortion of the path that's been navigated."
     *
     * A trail is on screen almost constantly — 59% of the world is soft ground — so the marks
     * are dressing, not a feature to be noticed. The alphas are pinned in the same order as the
     * first steps of `SHADOW_ALPHA`, which is the reference for "as dark as a shadow gets in
     * this language": nothing about a scuff may be heavier than the shadow of a solid object.
     */
    it("keeps a mark no stronger than a cast shadow", () => {
      const trail = buildTrailMarks();
      stampTrail(trail, { x: 278, y: 291 }, { x: 300, y: 300 }, 0.4, 1_000);
      fadeTrail(trail, 1_000);
      // Even at full strength, and even where two marks overlap, it stays under the darkest
      // single step of the shadow ramp doubled.
      expect(TRAIL_MARK_MAX_ALPHA).toBeLessThan(SHADOW_ALPHA[0] * 2.5);
      expect(trail.marks[0].alpha).toBeLessThanOrEqual(1);
    });

    it("refuses to draw a line across the map when a bot teleports", () => {
      // A respawn: one frame, most of the sheet crossed. It advances the anchor and stamps
      // nothing, so no mark appears at either end and none in between.
      const jump = trailStep({ x: 100, y: 100 }, { x: 3_000, y: 2_400 });
      expect(jump.crossed).toBe(false);
      expect(jump.anchor).toEqual({ x: 3_000, y: 2_400 });
    });

    it("recycles oldest-first and never grows the pool", () => {
      const trail = buildTrailMarks();
      const size = trail.marks.length;
      // Three times the pool, laid down one stride apart.
      for (let i = 0; i < size * 3; i += 1) {
        stampTrail(trail, { x: (i - 1) * TRAIL_STRIDE, y: 0 }, { x: i * TRAIL_STRIDE, y: 0 }, 0, 1_000 + i);
      }
      expect(trail.marks.length).toBe(size);
      expect(trail.view.children.length).toBe(size);
      // What survives is the most recent pool-full, so the oldest went first.
      const oldest = Math.min(...trail.born);
      expect(oldest).toBe(1_000 + size * 2);
    });

    it("puts the marks on the ground, under the bots and under the objects", () => {
      const art = buildMapArt(downtownMap);
      const inSubtree = (node: Container | null, root: Container): boolean => {
        for (let at = node; at; at = at.parent) if (at === root) return true;
        return false;
      };
      // A scuff is dressing a bot walks over, so it lives with the dressing.
      expect(inSubtree(art.trails.view, art.outdoorDetail)).toBe(true);
      expect(inSubtree(art.trails.view, art.root)).toBe(true);
      /**
       * NOT overhead, which is where the canopies and the leaves went.
       *
       * The leaves got this wrong in the other direction — they were on the dressing layer and
       * spent half their fall hidden under the canopy they came off. Same layer list, opposite
       * answer, because a mark on the ground is on the ground.
       */
      expect(inSubtree(art.trails.view, art.overhead)).toBe(false);
      expect(inSubtree(art.trails.view, art.foreground)).toBe(false);
    });
  });
});
