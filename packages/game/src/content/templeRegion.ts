import { thickenPath } from "../geometry";
import { compileCityPlan, type CityPlan } from "../cityPlan";
import { greatTemple, PYRAMID } from "./greatTemple";
import { observatory, OBSERVATORY } from "./observatory";
import {
  blobPoly,
  boxPoly,
  dots,
  objects,
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
 *  - PURPOSE: a ceremonial precinct the forest has closed over.
 *  - ZONES: the plaza; the pyramid on its north side; the ball court down the west
 *    flank; the observatory south-east; the cenote outside the precinct to the
 *    north-east; the forest all round.
 *  - SEQUENCE: in off the trail or the spur, onto the plaza, and everything is arranged
 *    round that one space. Climb the pyramid last, because it is the only thing here
 *    with one way down.
 *  - ADJACENCY: every structure ADDRESSES THE PLAZA. That is the same rule the city
 *    audit applies to a street, and it is the rule that stops a set of monuments reading
 *    as objects at arbitrary distances from each other — which is exactly what the first
 *    draft of this region was.
 *  - NEGATIVE SPACE: the plaza itself. 1000 x 600 of open stone with the pyramid at one
 *    end, watched from a summit, a tower and a court. It is the largest sightline in the
 *    world and it is meant to be frightening to cross.
 *
 * The one thing the earlier version got worst was the pyramid, and both faults were
 * geometric rather than aesthetic: a 460 x 400 base that read as a lopsided wedding
 * cake, and a stair authored 162 units long against a 130-unit climb, which overshot the
 * summit and lay across the top of it. Both are fixed in `greatTemple.ts`, and the note
 * there says how.
 */

const obj = objects("tmp");
const dot = dots("tmp");

const W0 = 2374;
const W1 = 4174;
const N0 = 1800;
const S1 = 3374;

/** The plaza: the region's armature. Everything else is placed off its edges. */
const PLAZA = { x: 2700, y: 2440, w: 1160, h: 660 };

/** The ball court, down the plaza's west flank, in the I-plan every one of them has. */
const COURT = { x: 2470, y: 2000, alley: 190, bench: 70, len: 380 };

/** The cenote: outside the precinct, north-east, because that is where the water was. */
const CENOTE = { x: 3880, y: 2080, rx: 210, ry: 165 };

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
    // The bed stops 40 units short of the pyramid. It ran 470 units south at first, which
    // put the buffer stop and the wagon INSIDE the terrace wall — and the wagon then sat
    // on top of a Dot in the tomb chamber, which is how the collision was found at all.
    { id: "tmp-spur-bed", kind: "ballast", points: boxPoly(3260, N0 - 26, 140, 86) },
    {
      id: "tmp-spur-trail",
      kind: "clearing",
      points: ribbonPoly([
        { x: 3330, y: 2250 },
        { x: 3330, y: 2340 },
        { x: PYRAMID.x + PYRAMID.w + 60, y: PYRAMID.y - 60 },
        { x: 3760, y: 2340 },
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
   * The altar on the stair's axis, out in the plaza.
   *
   * On the axis, not beside it. An altar off-axis is furniture; an altar on the axis is
   * the reason the stair points where it does, and it gives a player crossing the plaza
   * one piece of cover in the middle of the region's biggest sightline.
   */
  obj("altar", PYRAMID.x + PYRAMID.w / 2 - 86, 2580, 172, 92),
  obj("brazier", PYRAMID.x + PYRAMID.w / 2 - 200, 2596, 56, 56),
  obj("brazier", PYRAMID.x + PYRAMID.w / 2 + 144, 2596, 56, 56),

  /**
   * The stelae, on a rhythm along the plaza's south edge, all facing the pyramid.
   *
   * A rhythm rather than a hand-placed sequence, for the same reason Downtown's street
   * trees are: a spacing with a rule behind it reads as designed however carefully a
   * hand-placed one is chosen. The gap is where the trail arrives.
   */
  ...rhythm(2820, 3740, 152, [[3060, 3120]]).map((x) => obj("stele", x, PLAZA.y + PLAZA.h - 116, 52, 104)),

  // Ring stones at the ball court's ends, which is what a ball court is for.
  obj("altar", COURT.x + COURT.alley / 2 - 54, COURT.y + 22, 108, 54),
  obj("altar", COURT.x + COURT.alley / 2 - 54, COURT.y + COURT.len - 76, 108, 54),
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

  // Fallen masonry: boulders that came off the terraces, on the pyramid's flanks.
  obj("boulder", PYRAMID.x - 96, PYRAMID.y + 300, 92, 84),
  obj("boulder", PYRAMID.x - 74, PYRAMID.y + 400, 68, 62),
  obj("boulder", PYRAMID.x + PYRAMID.w + 20, PYRAMID.y + 250, 86, 78),
  obj("boulder", 3560, 2460, 74, 66),
  obj("boulder", 2900, 3140, 96, 88),
  obj("log", 3260, 3180, 250, 52, { facing: "E" }),
  obj("log", 2680, 2860, 200, 46, { facing: "E" }),

  /**
   * The spur's last hundred units: a buffer stop where the company stopped, and the
   * wagon they left on it. It is the one modern thing in the region and it is broken,
   * which is the world's gradient landing on its final beat.
   */
  obj("track", 3300, N0 - 26, 60, 90),
  // Shoved to the east side of the widened gate's mouth, leaving a walkable lane down
  // the west of it. Was at x 3288 in a 140-wide gate, i.e. dead centre of the only way
  // through, with 33 units either side of a 48-wide bot.
  obj("bufferStop", 3376, 1840, 84, 46, { facing: "S" }),
  // The wagon is on the yard side of the fence, which is where it was abandoned: the
  // company got as far as the gate and stopped. East side, for the same reason as the
  // buffer stop — the gate is 240 wide and this leaves 126 of it clear.
  // North of the shed's outer arc: at y 1560 its top corner was 5 units inside the
  // roundhouse, which the bounding box could not have told anyone.
  obj("wagon", 3372, 1600, 74, 174, { facing: "N" }),
  obj("boulder", 3700, 2180, 78, 70),
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
    dot("health", 3700, 2520),
  ],
  buildings: [greatTemple, observatory],
  extractionPoints: [
    /**
     * On the plaza, on the pyramid's axis south of the altar.
     *
     * The most exposed pad in the world: open flags, watched from a summit, a tower and
     * a court, and the nearest cover is the altar. An extraction should cost something.
     */
    { id: "extract-plaza", name: "GREAT PLAZA", rect: { x: PYRAMID.x + PYRAMID.w / 2 - 55, y: 2760, w: 110, h: 110 } },
  ],
  insertionPoints: [
    { id: "tmp-trail", name: "WEST TRAIL", position: { x: 2620, y: 2930 } },
    // Off the pyramid's own footprint: at 3480,2320 the drop was inside the terrace wall.
    { id: "tmp-spur", name: "END OF LINE", position: { x: 3720, y: 2340 } },
  ],
  botSpawns: [
    { id: "tmp-1", name: "Jade", squadId: "rival-19", isAmbient: true, color: "#4f9a7a", position: { x: 3120, y: 2740 } },
    { id: "tmp-2", name: "Obsidian", squadId: "rival-20", isAmbient: true, color: "#4a4a55", position: { x: 3700, y: 2520 } },
    // On the summit platform outside the shrine door, which is at y 2180. The old
    // position — the pyramid's centre, 170 down — is the middle of the high altar,
    // and "the centre of the landmark" is the middle of a solid every time.
    { id: "tmp-3", name: "Copal", squadId: "rival-21", isAmbient: true, color: "#a8763f", position: { x: PYRAMID.x + PYRAMID.w / 2, y: 2230 }, floorId: "temple:ROOF" },
    { id: "tmp-4", name: "Quetzal", squadId: "rival-22", isAmbient: true, color: "#3f8fa8", position: { x: OBSERVATORY.x + 40, y: OBSERVATORY.y + 60 }, floorId: "observatory:GROUND" },
  ],
};
