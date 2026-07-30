import { Container, Graphics } from "pixi.js";
import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { worldMap } from "@dotbot/game/content/world";
import type { MapObject } from "@dotbot/game/types";
import { drawModelObject } from "./modelGlyphs";
import { buildOutdoorModel } from "./modelOutdoor";
import { buildMapArt } from "../mapArt";
import { animateAmbient, collectMovers, movingPart, type AmbientMover } from "./modelMotion";
import { SHADOW_ALPHA, type ShadowPad } from "./tone";

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
    // The canopy and the trunk, once each. Before `stillPart` existed the trunk was added
    // unconditionally and this caught it growing one per redraw.
    expect(view.children).toHaveLength(2);
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
});
