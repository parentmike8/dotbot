import { thickenPath } from "../geometry";
import { compileCityPlan, type CityPlan } from "../cityPlan";
import { greatTemple, PYRAMID } from "./greatTemple";
import { observatory, OBSERVATORY } from "./observatory";
import {
  blobPoly,
  boxPoly,
  dots,
  objects,
  patrol,
  radial,
  rhythm,
  ribbonPoly,
  type RegionParts,
} from "./regionKit";
import type { Barrier, MapObject } from "../types";

/**
 * THE GREAT TEMPLE PRECINCT — the far end of the world, and the end of the gradient.
 *
 * Two ways in and neither is a road: the abandoned spur out of the yard's south fence,
 * and the trail east off the fairground's midway. That is the point of putting it here.
 * The world runs city → depot → fair → ruin, and by the time you arrive the ground you
 * are walking on has stopped being made at all.
 *
 * The region brief:
 *
 *  - PURPOSE: a ceremonial precinct the forest has closed over, and the way underneath it.
 *  - ZONES: the plaza; the pyramid on its north side; the ball court down the west
 *    flank; the observatory south-east; the cenote outside the precinct to the
 *    north-east; the forest all round. And below all of it, the UNDERCROFT — a cross of
 *    tunnel galleries running out from under the pyramid and beneath the plaza. It is
 *    authored as floors of the temple rather than as scenery here, because you get into
 *    it by walking down.
 *  - SEQUENCE: in off the trail or the spur, onto the plaza, and everything is arranged
 *    round that one space. Climb the pyramid last, because it is the only thing here
 *    with one way down — and go UNDER it last of all, because the tunnels have exactly
 *    one entrance and it is four floors from the surface.
 *  - ADJACENCY: every structure ADDRESSES THE PLAZA. That is the same rule the city
 *    audit applies to a street, and it is the rule that stops a set of monuments reading
 *    as objects at arbitrary distances from each other — which is exactly what the first
 *    draft of this region was.
 *  - NEGATIVE SPACE: the plaza itself. 1000 x 600 of open stone with the pyramid at one
 *    end, watched from a summit, a tower and a court. It is the largest sightline in the
 *    world and it is meant to be frightening to cross.
 *
 * The pyramid went from 520 to 660 across and from two floors to four, and the knock-on
 * through this file is the interesting part. A precinct is a set of things arranged round
 * ONE space, so growing the thing at its head moved the plaza 120 south, pushed the cenote
 * east, sent the abandoned spur back behind the yard's fence, and rerouted the trail that
 * used to start 400 units inside the new terrace wall. Four of those were caught by audits
 * rather than by looking, which is the argument for having them.
 *
 * Faults from earlier versions, kept because they were paid for: a 460 x 400 base read as
 * a lopsided wedding cake (a pyramid is SQUARE), and a stair authored 162 units long
 * against a 130-unit climb overshot the summit and lay across the top of it.
 */

const obj = objects("tmp");
const dot = dots("tmp");

const W0 = 2374;
const W1 = 4174;
const N0 = 1800;
const S1 = 3374;

/**
 * The plaza: the region's armature. Everything else is placed off its edges.
 *
 * Pushed 120 south and 120 shallower to clear the rebuilt pyramid, which went from 520
 * to 660 across. That is the whole knock-on of making the temple bigger and it is worth
 * naming: a precinct is a set of things arranged round ONE space, so growing the thing at
 * the head of it moves everything else rather than just its own four corners.
 *
 * It also now sits directly over the undercroft's east-west gallery, which runs 2560..2800
 * — so the tunnels do genuinely go under the plaza, which is the point.
 */
const PLAZA = { x: 2700, y: 2560, w: 1160, h: 540 };

/** The ball court, down the plaza's west flank, in the I-plan every one of them has. */
const COURT = { x: 2470, y: 2000, alley: 190, bench: 70, len: 380 };

/**
 * The cenote: outside the precinct, north-east, because that is where the water was.
 *
 * Moved east and shrunk, because the pyramid's east face is now at x 3640 and the pool's
 * own trodden edge reached 3602 — a flooded sinkhole overlapping a terrace wall.
 */
const CENOTE = { x: 3940, y: 2070, rx: 190, ry: 150 };

const cityPlan: CityPlan = {
  /** No streets. Not everywhere has roads, and this is the place that proves it. */
  regions: [
    /**
     * The forest, first and underneath everything, so every stone surface is something
     * cleared FROM it rather than something with dirt added on top. That ordering is
     * the difference between a ruin and a clean building with texture on it.
     */
    { id: "tmp-forest", kind: "undergrowth", points: boxPoly(W0, N0, W1 - W0, S1 - N0) },

    /**
     * The plaza. `court` rather than `plaza`: a ritual ground and a shopping precinct
     * are different things people do on different ground, so they are different uses,
     * and the renderer is free to lay one in flags and the other in saw-cut slabs.
     */
    { id: "tmp-plaza", kind: "court", points: boxPoly(PLAZA.x, PLAZA.y, PLAZA.w, PLAZA.h) },

    // The pyramid's own apron, joining its two arches to the plaza and wrapping the
    // blind north face so the tomb entrance has an approach at all.
    /**
     * A TIGHT wrap, not a broad apron.
     *
     * At 110 units all round, this plus the observatory's ground plus the cenote's edge
     * merged with the plaza into one continuous pale field covering half the region — and
     * a ruin whose stone reads as a field is a building site. The stone has to be ISLANDS
     * in the growth. 60 units is enough to give both arches an approach and nothing more.
     */
    {
      id: "tmp-pyramid-apron",
      kind: "court",
      points: boxPoly(PYRAMID.x - 60, PYRAMID.y - 90, PYRAMID.w + 120, PYRAMID.h + 110),
    },

    // The ball court's floor: the alley and its two end zones, in one I-shaped ring.
    {
      id: "tmp-court-floor",
      kind: "court",
      points: [
        { x: COURT.x - 90, y: COURT.y },
        { x: COURT.x + COURT.alley + 90, y: COURT.y },
        { x: COURT.x + COURT.alley + 90, y: COURT.y + 96 },
        { x: COURT.x + COURT.alley, y: COURT.y + 96 },
        { x: COURT.x + COURT.alley, y: COURT.y + COURT.len - 96 },
        { x: COURT.x + COURT.alley + 90, y: COURT.y + COURT.len - 96 },
        { x: COURT.x + COURT.alley + 90, y: COURT.y + COURT.len },
        { x: COURT.x - 90, y: COURT.y + COURT.len },
        { x: COURT.x - 90, y: COURT.y + COURT.len - 96 },
        { x: COURT.x, y: COURT.y + COURT.len - 96 },
        { x: COURT.x, y: COURT.y + 96 },
        { x: COURT.x - 90, y: COURT.y + 96 },
      ],
    },
    // The walk from the court's south end up onto the plaza.
    {
      id: "tmp-court-walk",
      kind: "clearing",
      points: ribbonPoly([
        { x: COURT.x + COURT.alley / 2, y: COURT.y + COURT.len },
        { x: COURT.x + COURT.alley / 2 + 120, y: 2380 },
        { x: 2790, y: PLAZA.y + 40 },
      ], () => 150),
    },

    // The observatory's own ground, reaching its north door and the plaza.
    { id: "tmp-obs-ground", kind: "court", points: blobPoly(OBSERVATORY.x, OBSERVATORY.y, OBSERVATORY.r + 74, OBSERVATORY.r + 68, "obs", 0.16, 19) },
    {
      id: "tmp-obs-walk",
      kind: "clearing",
      points: ribbonPoly([
        { x: OBSERVATORY.x, y: OBSERVATORY.y - OBSERVATORY.r - 60 },
        { x: OBSERVATORY.x - 60, y: PLAZA.y + PLAZA.h - 30 },
      ], () => 160),
    },

    /**
     * The trail in from the fairground, and the spur bed in from the yard.
     *
     * These are the region's two doors, and they are deliberately different kinds of
     * ground: a trodden trail and a railway formation that stops in the trees. One says
     * people still walk here; the other says a company once thought it could get at
     * this place and gave up.
     */
    {
      id: "tmp-trail-w",
      kind: "clearing",
      points: ribbonPoly([
        { x: W0 - 40, y: 3020 },
        { x: 2560, y: 2960 },
        { x: 2700, y: 2860 },
        { x: PLAZA.x + 120, y: PLAZA.y + PLAZA.h - 90 },
      ], (t) => 150 - t * 30),
    },
    /**
     * The spur bed, now entirely NORTH of the yard's back fence.
     *
     * The 660-wide pyramid reaches y 1820 and the fence is at 1774, so there are 46 units
     * between them — which is not room for a railway. The company therefore got as far as
     * the fence and no further, which is a better version of the same story than stopping
     * 40 units short of a wall. Everything it left is on the yard side.
     *
     * The bed ran 470 units south in the first draft and put the buffer stop and the wagon
     * INSIDE the terrace wall, with the wagon on top of a Dot in the tomb chamber — found
     * only because `auditDotPlacement` complained about the Dot.
     */
    { id: "tmp-spur-bed", kind: "ballast", points: boxPoly(3300, 1620, 140, 190) },
    {
      /**
       * The trail from the spur's end round the pyramid's east flank to the plaza.
       *
       * It used to start at (3330, 2250), which is now 400 units inside the pyramid. Round
       * the east side rather than the west, because the west is the ball court's and a
       * trail through a court is a trail through the one place a game was played.
       */
      id: "tmp-spur-trail",
      kind: "clearing",
      points: ribbonPoly([
        { x: 3400, y: 1815 },
        { x: 3660, y: 1870 },
        { x: 3700, y: 2350 },
        { x: 3820, y: PLAZA.y + 60 },
      ], (t) => 140 - t * 20),
    },

    /**
     * The cenote's own trodden edge FIRST, then the water inside it.
     *
     * Authored the other way round the 110-unit-wider apron simply covered the pool, and
     * what showed was a stone rim with dry ground in it. Regions draw in order and the
     * audit reads them in the same order, so the thing that should be on top goes last.
     */
    { id: "tmp-cenote-ground", kind: "clearing", points: blobPoly(CENOTE.x, CENOTE.y, CENOTE.rx + 68, CENOTE.ry + 62, "cengrd", 0.26, 19) },
    { id: "tmp-cenote", kind: "water", points: blobPoly(CENOTE.x, CENOTE.y, CENOTE.rx, CENOTE.ry, "cenote", 0.2, 21) },

    /**
     * Growth back over the stone, laid LAST so it sits on top of the flags.
     *
     * This is the whole difference between a temple and a ruin, and it has to be the
     * last thing authored or it is under the paving instead of coming through it.
     */
    { id: "tmp-moss-a", kind: "undergrowth", points: blobPoly(2840, 2980, 150, 96, "ma", 0.55, 13) },
    { id: "tmp-moss-b", kind: "undergrowth", points: blobPoly(3660, 3050, 190, 90, "mb", 0.55, 13) },
    { id: "tmp-moss-c", kind: "undergrowth", points: blobPoly(3180, 2560, 120, 84, "mc", 0.55, 11) },
    // West of the ball court, not in its alley: growth in the one place a game was played
    // reads as a mess rather than as a ruin, and it buried the Dot in the middle of it.
    { id: "tmp-moss-d", kind: "undergrowth", points: blobPoly(2420, 2470, 120, 100, "md", 0.55, 13) },
  ],
};

const { roads, surfaces, regions } = compileCityPlan(cityPlan);

/**
 * The ball court's benches: the two sloping walls the game was played off.
 *
 * Barriers rather than objects, because they are WALLS — long, solid, and the thing
 * that makes an alley an alley. Authored as thickened paths so the format's own
 * geometry kernel produces the collision, which is the same path a curved quay takes.
 */
function courtBenches(): Barrier[] {
  const west = COURT.x;
  const east = COURT.x + COURT.alley;
  return [
    {
      id: "tmp-court-bench-w",
      solids: thickenPath([{ x: west, y: COURT.y + 96 }, { x: west, y: COURT.y + COURT.len - 96 }], COURT.bench),
    },
    {
      id: "tmp-court-bench-e",
      solids: thickenPath([{ x: east, y: COURT.y + 96 }, { x: east, y: COURT.y + COURT.len - 96 }], COURT.bench),
    },
  ];
}

/**
 * The cenote's rim, and the one place in this world where water is genuinely
 * impassable — because something you can SEE is doing the stopping.
 *
 * `SurfaceKind`'s note on `water` carries the reasoning: a wadeable pool that blocks
 * nothing tells no lie, and invisible collision over water is the same lie as a ghost
 * fixture told the other way round. So the rim is real cut stone with a real gap in it,
 * the gap is the cut stair down to the water, and what stops a bot is a wall.
 */
function cenoteRim(): Barrier {
  const steps = 26;
  const ring = Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return {
      x: CENOTE.x + Math.cos(a) * (CENOTE.rx + 26),
      y: CENOTE.y + Math.sin(a) * (CENOTE.ry + 24),
    };
  });
  // The gap: the cut stair on the south side, which is how you get down to the water.
  const run = [...ring.slice(9), ...ring.slice(0, 6)];
  return { id: "tmp-cenote-rim", solids: thickenPath(run, 30) };
}

const templeObjects: MapObject[] = [
  /**
   * The serpent heads at the foot of the grand stair.
   *
   * Two of these flanking a flight is the single most recognisable thing a
   * Mesoamerican temple has, and they are doing a job beyond recognition: they mark the
   * one way up, from anywhere on the plaza, without a label.
   */
  // On the plaza, not in the terrace wall. At the base edge minus 14 their heads were
  // inside the pyramid's own shell, which is a solid outside a solid.
  obj("serpentHead", PYRAMID.x + PYRAMID.w / 2 - 156, PYRAMID.y + PYRAMID.h + 4, 76, 116, { facing: "S" }),
  obj("serpentHead", PYRAMID.x + PYRAMID.w / 2 + 80, PYRAMID.y + PYRAMID.h + 4, 76, 116, { facing: "S" }),

  /**
   * The altar on the stair's axis, OUT IN THE PLAZA — and the second word is the fix.
   *
   * On the axis, not beside it: an altar off-axis is furniture, an altar on the axis is the
   * reason the stair points where it does, and it is a player's one piece of cover crossing
   * the region's biggest sightline. None of that changed. What changed is that it was at
   * y 2580, and when the plaza moved 120 south for the bigger pyramid that stopped being
   * "out in the plaza" and became "jammed into the 100-unit gap in front of the door".
   *
   * WHICH SEALED THE TEMPLE'S FRONT DOOR. The two serpent heads run y 2484..2600 and the
   * altar ran 2580..2672, so head and altar overlapped by 20 units at each end — and the
   * forecourt in front of the archway became a 160 x 100 pocket with no way in from the
   * plaza at all. Reported from play: "there's no way to get into the temple, there's a
   * massive block at the entry." The navigator could still reach it, which is why nothing
   * complained: it walked the entire 660-wide base to the blind north face and came back
   * through the tomb chamber.
   *
   * At y 2700 there are 100 clear units between the heads and the altar, and the approach
   * to the arch is open across its full 160.
   */
  obj("altar", PYRAMID.x + PYRAMID.w / 2 - 86, 2700, 172, 92),
  /**
   * The braziers flank the ARCHWAY now, not the altar.
   *
   * Beside the altar they were 58 units off it — a false aisle, and one more thing narrowing
   * the one approach that had to stay wide. At the pyramid's face they are flush against the
   * serpent heads, outside the forecourt's 160, and they mark the way in rather than the
   * thing in front of it.
   */
  obj("brazier", 3096, 2500, 56, 56),
  obj("brazier", 3468, 2500, 56, 56),

  /**
   * The stelae, on a rhythm along the plaza's south edge, all facing the pyramid.
   *
   * A rhythm rather than a hand-placed sequence, for the same reason Downtown's street
   * trees are: a spacing with a rule behind it reads as designed however carefully a
   * hand-placed one is chosen. The gap is where the trail arrives.
   */
  // Two gaps: where the trail arrives, and ON THE PYRAMID'S AXIS. You do not stand a stele
  // across a ceremonial approach, and the extraction pad is on that axis too.
  ...rhythm(2820, 3740, 152, [[3060, 3120], [3200, 3400]])
    .map((x) => obj("stele", x, PLAZA.y + PLAZA.h - 116, 52, 104)),

  /**
   * Ring stones in the court's END ZONES, not across its alley.
   *
   * They used to sit on the alley's centreline at each end — `alley / 2 - 54`, so 108 wide in
   * a 120-wide alley, 6 units of daylight either side. That sealed the playing surface at both
   * ends, and the Dot at centre court was unreachable from the player spawn: a walled slot
   * 120 x 228 with a stone plugging each mouth. Reported from play: "there are these four
   * blocks, and there's a dot in the middle of them that is not accessible because the blocks
   * are blocking the user from getting in... let's at least make them so that they're sort of
   * workable, either able to get in through a direction or something like that."
   *
   * Nothing measured it. Every solid here is individually fine and correctly placed — two
   * benches and two markers, which is what a ball court IS — and `auditDotPlacement` asks
   * whether a Dot has clearance, not whether anything can walk to it. Centre court had 48
   * units of clearance in every direction and no way in.
   *
   * The I-plan's whole point is that the alley runs clear end to end and the end zones are the
   * wings either side, so the markers belong in a wing. Each sits clear of its bench in y —
   * the benches span 2061..2319 and these are outside that — so the alley is open north and
   * south and a marker still reads as belonging to the end it marks.
   */
  obj("altar", COURT.x - 90, COURT.y, 108, 54),
  obj("altar", COURT.x + COURT.alley - 18, COURT.y + COURT.len - 54, 108, 54),
  obj("brazier", COURT.x - 74, COURT.y + COURT.len / 2 - 26, 50, 50),
  obj("brazier", COURT.x + COURT.alley + 24, COURT.y + COURT.len / 2 - 26, 50, 50),

  /**
   * The forest, as a wall.
   *
   * Thickets on a rhythm all the way round the precinct, because the growth came in as
   * a front rather than in patches. They are solid, so together they are the thing that
   * says the world ends here — which is what a wall of vegetation does. There is no
   * boundary fence in this region at all; the jungle is the fence.
   */
  // The north line stops for the pyramid and its apron. Unclear on the rhythm alone,
  // four thickets were growing through the terrace wall.
  ...rhythm(W0 + 60, W1 - 60, 172, [[2900, 3700], [3600, 4174]])
    .map((x, i) => obj("thicket", x, N0 + 30 + (i % 2) * 66, 152, 136)),
  ...rhythm(W0 + 60, W1 - 60, 172).map((x, i) => obj("thicket", x, S1 - 210 + (i % 3) * 62, 152, 136)),
  /**
   * The west line stops where the ball court is, because the court IS the boundary
   * there — its bench walls are built against the forest edge, which is where you would
   * put a court. The first pass ran the thickets straight through it, sealed the alley
   * off at both ends and left the Dot in the middle of it somewhere no bot could reach.
   */
  ...rhythm(N0 + 240, S1 - 260, 168, [[1960, 2440]])
    .map((y, i) => obj("thicket", W0 + 30 + (i % 2) * 54, y, 146, 132)),
  // The east line stops for the cenote: a thicket growing out of a flooded sinkhole is
  // the same defect as one growing through a terrace wall.
  ...rhythm(N0 + 240, S1 - 260, 168, [[1900, 2300]])
    .map((y, i) => obj("thicket", W1 - 190 + (i % 2) * 46, y, 146, 132)),

  /**
   * The trees inside the precinct, standing ON the plaza where the flags have failed.
   *
   * These are the ones that carry the ruin. A forest round the outside is scenery; a
   * tree growing out of a ceremonial court is four hundred years of nobody sweeping it,
   * and it is also the only cover on the plaza.
   */
  obj("tree", 3140, 2900, 104, 104),
  obj("tree", 3640, 2960, 112, 112),
  obj("tree", 2820, 2700, 96, 96),
  obj("tree", 3980, 2500, 100, 100),
  obj("tree", 2560, 2260, 96, 96),
  obj("tree", 3020, 2540, 88, 88),
  obj("tree", 3460, 3020, 92, 92),
  obj("tree", 2900, 3040, 86, 86),

  /**
   * Fallen masonry: boulders that came off the terraces, on the pyramid's flanks.
   *
   * Measured OFF the pyramid rather than at fixed coordinates, which is why they survived
   * the base growing by 140 units. The two that did not were both authored as absolute
   * numbers — one at 3560,2460 now four hundred units inside the terrace wall, and one at
   * the old east flank now standing in the cenote.
   */
  obj("boulder", PYRAMID.x - 110, PYRAMID.y + 300, 92, 84),
  obj("boulder", PYRAMID.x - 88, PYRAMID.y + 420, 68, 62),
  obj("boulder", PYRAMID.x - 130, PYRAMID.y + 120, 74, 66),
  /**
   * The east flank gets ONE, and it is 520 down rather than 660.
   *
   * At 660 it landed at 3684,2480 — which is the approach to the observatory's only door,
   * 3700,2560. Caught by `entranceApproachBlockers`, the check that requires a bot's full
   * diameter of clear run either side of every entrance, and it also wedged a bot spawn
   * inside the same rock. Two failures from one boulder measured off the wrong corner.
   */
  obj("boulder", PYRAMID.x + PYRAMID.w + 30, PYRAMID.y + 520, 86, 78),
  obj("boulder", 2900, 3140, 96, 88),
  obj("log", 3260, 3180, 250, 52, { facing: "E" }),
  obj("log", 2680, 2860, 200, 46, { facing: "E" }),

  /**
   * The spur's last hundred units: a buffer stop where the company stopped, and the
   * wagon they left on it. It is the one modern thing in the region and it is broken,
   * which is the world's gradient landing on its final beat.
   */
  /**
   * The last hundred units of the spur, all of it north of the fence now.
   *
   * Three objects in three distinct lanes of a 240-wide gate, because they were in two
   * before and the buffer stop sat on the wagon. Track, then the stop flush at its end,
   * then the wagon beside both — 24 units clear of the pyramid's north face, which is
   * every unit there is.
   */
  obj("track", 3330, 1660, 60, 90),
  obj("bufferStop", 3330, 1750, 84, 46, { facing: "S" }),
  /**
   * The wagon, east of the shed's outer arc.
   *
   * Checked against the roundhouse's PLAN and not its bounding box, twice now and for the
   * same reason: at y 1560 its top corner was 5 units inside the shed, and at x 3230 its
   * whole west end was — and in both cases the bounding box could not have told anyone,
   * because a fan of engine bays is a 922 x 406 box that the shed occupies a third of.
   */
  obj("wagon", 3420, 1600, 74, 174, { facing: "N" }),

  /**
   * Place names here are physical signs now, using the same plate as Downtown.
   *
   * The temple sign is south-west of the south arch's serpent-and-brazier approach.
   * Its first position was hidden under the adjacent tree crown; this one is below
   * both the crown and serpent while remaining outside the central entrance route. The
   * observatory sign is east of its north door. Neither occupies the route it names.
   */
  obj("sign", 3132, 2630, 44, 12),
  obj("sign", 3810, 2570, 44, 12),
  /**
   * Plaza extraction sign east of the pad. The altar-to-pad axis and the west-side
   * arrival trail remain clear, preserving the square's useful approaches.
   */
  obj("sign", 3384, 2952, 44, 12),
];

export const templeRegion: RegionParts = {
  id: "tmp",
  name: "The Great Temple",
  roads,
  surfaces,
  regions,
  barriers: [...courtBenches(), cenoteRim()],
  objects: templeObjects,
  dotSpawns: [
    dot("health", 2900, 2560),
    dot("radar", 3400, 2900),
    dot("dashOvercharge", COURT.x + COURT.alley / 2, COURT.y + COURT.len / 2),
    dot("incognito", CENOTE.x - 40, CENOTE.y + CENOTE.ry + 70),
    // Off the pyramid's south-east corner. It was at 3700,2520, which the enlarged base
    // put inside a boulder that came off the new east flank.
    dot("health", 3700, 2620),
  ],
  buildings: [greatTemple, observatory],
  extractionPoints: [
    /**
     * On the plaza, on the pyramid's axis south of the altar.
     *
     * The most exposed pad in the world: open flags, watched from a summit, a tower and
     * a court, and the nearest cover is the altar. An extraction should cost something.
     *
     * At y 2760 it was UNDER the altar once the altar moved south to unseal the temple's
     * front door — three things on one 540-deep axis is one too many. 2880 keeps it south
     * of the altar with 88 units between them, and the stele rhythm now has a gap on this
     * axis so nothing stands across the approach behind it either.
     */
    { id: "extract-plaza", name: "GREAT PLAZA", rect: { x: PYRAMID.x + PYRAMID.w / 2 - 55, y: 2880, w: 110, h: 110 } },
  ],
  insertionPoints: [
    { id: "tmp-trail", name: "WEST TRAIL", position: { x: 2620, y: 2930 } },
    /**
     * Off the pyramid's own footprint, and off its rubble.
     *
     * Third position for this drop. At 3480,2320 it was inside the terrace wall; at
     * 3720,2340 it was 0.1 units from a boulder that came off the enlarged east flank —
     * and `validateInsertionMap` passed it, because it searches OUTWARD from an arrival
     * point for room and a squad of three found some. That is the right behaviour at
     * runtime and it hides an authoring mistake, so the point itself is checked directly:
     * 69 units of clearance here against the 24 a bot needs.
     */
    { id: "tmp-spur", name: "END OF LINE", position: { x: 3700, y: 2500 } },
  ],
  botSpawns: [
    {
      id: "tmp-1", name: "Jade", squadId: "rival-19", faction: "ambient", isAmbient: true, color: "#4f9a7a", position: { x: 3120, y: 2740 },
      patrol: patrol("temple-plaza-edge", "Guard the temple plaza approach and ceremonial stair axis.", [
        { x: 3120, y: 2740 }, { x: 3480, y: 2716 }, { x: 3504, y: 3000 }, { x: 3000, y: 2952 }, { x: 3000, y: 2820 },
      ]),
    },
    /**
     * On the plaza's west half, and the second attempt at moving it.
     *
     * It was 40 units off the observatory's north wall with a boulder on its other side,
     * which is where a bot gets wedged and stays wedged. Moved to 3150,2720 it was 30 units
     * from `tmp-1` — and a bot is 48 across, so the two of them started the run inside each
     * other and neither could plan a first step. Both checks caught it, which is the point
     * of having a spawn-clearance test and a bots-actually-move test rather than one.
     */
    {
      id: "tmp-2", name: "Obsidian", squadId: "rival-20", faction: "ambient", isAmbient: true, color: "#4a4a55", position: { x: 3020, y: 2880 },
      patrol: patrol("temple-observatory-junction", "Watch the observatory and temple trail junction.", [
        { x: 3020, y: 2880 }, { x: 2760, y: 3060 }, { x: 3124, y: 3200 }, { x: 3340, y: 3000 },
      ]),
    },
    // On the summit platform outside the shrine door, which is at y 2180. The old
    // position — the pyramid's centre, 170 down — is the middle of the high altar,
    // and "the centre of the landmark" is the middle of a solid every time.
    {
      id: "tmp-3", name: "Copal", squadId: "rival-21", faction: "ambient", isAmbient: true, color: "#a8763f", position: { x: PYRAMID.x + PYRAMID.w / 2, y: 2230 }, floorId: "temple:ROOF",
      patrol: patrol("temple-summit", "Guard the summit shrine door and platform edge.", [
        { x: PYRAMID.x + PYRAMID.w / 2, y: 2230 },
        { x: PYRAMID.x + PYRAMID.w / 2 + 180, y: 2320 },
        { x: PYRAMID.x + PYRAMID.w / 2, y: 2368 },
        { x: PYRAMID.x + PYRAMID.w / 2 - 180, y: 2320 },
      ]),
    },
    {
      id: "tmp-4", name: "Quetzal", squadId: "rival-22", faction: "ambient", isAmbient: true, color: "#3f8fa8", position: { x: OBSERVATORY.x + 40, y: OBSERVATORY.y + 60 }, floorId: "observatory:GROUND",
      patrol: patrol("observatory-instrument-floor", "Walk the observatory instrument, entry, and stair-side floor.", [
        { x: OBSERVATORY.x + 40, y: OBSERVATORY.y + 60 },
        { x: OBSERVATORY.x + 220, y: OBSERVATORY.y + 60 },
        { x: OBSERVATORY.x + 220, y: OBSERVATORY.y + 240 },
        { x: OBSERVATORY.x - 32, y: OBSERVATORY.y + 240 },
      ]),
    },
  ],
};
