import { compileCityPlan, type CityPlan } from "../cityPlan";
import { roundhouse, TABLE, TABLE_RADIUS } from "./roundhouse";
import { signalBox } from "./signalBox";
import { blobPoly, boxPoly, dots, fenceRun, objects, patrol, rhythm, rhythmRule, type RegionParts } from "./regionKit";
import type { MapObject } from "../types";

/**
 * FENCHURCH YARD — the city's locomotive depot, and the world's first step out of it.
 *
 * It is east of Downtown because that is where the rails go, and Main St runs straight
 * into it as the works road: one street, two regions, and a level crossing where the
 * yard's own lead cuts across it. That crossing is the whole transition — you do not
 * arrive in the yard, you notice the tarmac has ballast in it.
 *
 * The region brief:
 *
 *  - PURPOSE: turn, coal, water and stable the engines that work out of the city.
 *  - ZONES: the main line along the north; the throat where the yard's road leaves it;
 *    the works road across the middle; the turntable and its roundhouse to the south;
 *    the wagon sidings east.
 *  - SEQUENCE: off the main line at the throat, take water and coal, down the lead,
 *    onto the table, into a bay. Every piece of it is on that one line of travel, which
 *    is what stops a yard reading as parallel stripes.
 *  - ADJACENCY: the coal stage stands over the coal road; the tank stands beside the
 *    lead; the box stands where the points are; the shed opens onto the table.
 *  - NEGATIVE SPACE: the turntable itself. It is the arena of the region — three bay
 *    doors watch it, the extraction pad sits on it, and there is exactly one way off.
 *
 * The yard is WORKING but shabby: weeds in the corners, not through the middle. That
 * places it on the world's gradient — a live city, then a working depot, then a
 * derelict fairground, then a ruin — so the further you get from Downtown the older
 * everything is. A region reads as much from where it sits in that sequence as from
 * what is in it.
 */

const SOURCE_FILE = "packages/game/src/content/railYard.ts";
const obj = objects("yard", SOURCE_FILE);
const dot = dots("yard");

// The region's bounds, inside the sheet edge and the boundary fences.
const W0 = 2400;
const W1 = 4174;
/** The yard runs deeper than Downtown: a turntable and its fan need the room. */
const S1 = 1774;

/** Main St, continued east as the works road. Same centreline, so it really is one street. */
const WORKS_Y = 800;
const CARRIAGEWAY = 120;
const FOOTWAY = 96;
const WORKS_N_KERB = WORKS_Y - CARRIAGEWAY / 2; //  740
const WORKS_N_BACK = WORKS_N_KERB - FOOTWAY; //     644
const WORKS_S_KERB = WORKS_Y + CARRIAGEWAY / 2; //  860
const WORKS_S_BACK = WORKS_S_KERB + FOOTWAY; //     956

/** The main line's formation: three through roads on one bed. */
const LINE_TOP = 26;
const LINE_BOTTOM = 294;
const ROADS = [90, 166, 242];
const GAUGE = 52;

/** The lead: the single line off the throat that feeds the turntable, and the crossing. */
const LEAD_X = 2934;

const cityPlan: CityPlan = {
  streets: [{
    /**
     * Starts 26 units WEST of the region, inside the city's fence line, for the same
     * reason `fair-drive` starts north of its own: Main St ends at x 2374 and this
     * began at 2400, leaving the fence's thickness of bare ground across the
     * carriageway in the middle of the gate.
     */
    id: "works-rd",
    from: { x: W0 - 26, y: WORKS_Y },
    to: { x: W1, y: WORKS_Y },
    width: CARRIAGEWAY,
    footway: FOOTWAY,
  }],
  patches: [
    // Hardstanding north of the road: the throat, the coal road, the box.
    { id: "yard-throat", kind: "yard", x: W0, y: LINE_BOTTOM, w: W1 - W0, h: WORKS_N_BACK - LINE_BOTTOM },
    // Hardstanding south of it: the whole depot.
    { id: "yard-depot", kind: "yard", x: W0, y: WORKS_S_BACK, w: W1 - W0, h: S1 - WORKS_S_BACK },
  ],
  regions: [
    /**
     * The main line's ballast bed, laid as a region rather than a patch.
     *
     * A track bed is the one piece of ground in the yard that genuinely is a long
     * straight band, so the polygon is a box — but it is a *region*, because the
     * renderer gives ballast shoulders that fall away at the edge, and that fall is
     * what makes a bed read as proud of the ground instead of painted on it.
     */
    { id: "yard-mainline-bed", kind: "ballast", points: boxPoly(W0, LINE_TOP, W1 - W0, LINE_BOTTOM - LINE_TOP) },
    // The lead's own bed, straight down through the crossing to the table.
    { id: "yard-lead-bed", kind: "ballast", points: boxPoly(LEAD_X - 46, LINE_BOTTOM, GAUGE + 92, 1065 - LINE_BOTTOM) },
    // The coal road, running west off the lead under the stage.
    { id: "yard-coal-bed", kind: "ballast", points: boxPoly(W0, 474, LEAD_X - W0, 116) },
    // The table's apron: the one round piece of ground in the yard, and everything
    // radial about the region hangs off it.
    { id: "yard-table-bed", kind: "ballast", points: blobPoly(TABLE.x, TABLE.y, TABLE_RADIUS + 108, TABLE_RADIUS + 100, "table", 0.1, 22) },
    // The wagon sidings' bed, east.
    { id: "yard-siding-bed", kind: "ballast", points: boxPoly(3420, 966, W1 - 3420, 320) },

    /**
     * Weeds, and where they are is the point.
     *
     * In the corners — behind the sidings, along the back fence, in the angle the
     * roundhouse leaves — and never on a route. A working yard is kept clear where it
     * is worked and abandoned where it is not, so the weeds are how the region says
     * which parts still get used.
     */
    { id: "yard-weeds-ne", kind: "undergrowth", points: blobPoly(4030, 400, 150, 96, "wne", 0.5, 13) },
    { id: "yard-weeds-se", kind: "undergrowth", points: blobPoly(4020, 1600, 160, 120, "wse", 0.5, 13) },
    { id: "yard-weeds-sw", kind: "undergrowth", points: blobPoly(2520, 1660, 190, 100, "wsw", 0.5, 15) },
    { id: "yard-weeds-w", kind: "undergrowth", points: blobPoly(2470, 1180, 96, 210, "ww", 0.45, 13) },
  ],
  approaches: [
    // Out of the box's yard door to the works road's north footway.
    { id: "yard-box-approach", from: { x: 3140, y: 606 }, to: { x: 3140, y: WORKS_N_BACK + 14 }, width: 84 },
  ],
};

const { roads, surfaces, regions } = compileCityPlan(cityPlan);

const yardObjects: MapObject[] = [
  // -- The main line ------------------------------------------------------
  ...obj.derived(
    rhythmRule("yard-main-lines", "main-line track list", "y", "ROADS", ROADS[0], ROADS.at(-1)!, 76),
    () => ROADS.map((y) => obj("track", W0, y, W1 - W0, GAUGE)),
  ),

  // -- The throat --------------------------------------------------------
  /**
   * The lead, crossing the works road on the level.
   *
   * Drawn as one continuous run straight through the carriageway, because that is
   * what a works crossing is — the road gives way to the rail, not the other way
   * round — and it is the single detail that welds the two regions into one place.
   */
  obj.authored("lead", "track", LEAD_X, LINE_BOTTOM, GAUGE, 1065 - LINE_BOTTOM),
  obj.authored("coal-road", "track", W0, 506, LEAD_X - W0, GAUGE),

  /**
   * The coaling stage, standing over the coal road with its chute facing it.
   *
   * The tallest thing in the yard, and concrete rather than iron on purpose: a yard
   * of uniformly dark ironwork has no scale in it, and the one pale mass is what
   * gives the rest something to be measured against.
   */
  obj.authored("coaling-tower-2470-330", "coalingTower", 2470, 330, 190, 168),
  // The stage is fed from a bank of wagons on the coal road behind it.
  obj.authored("wagon-2700-494", "wagon", 2700, 494, 200, 76, { facing: "E" }),
  // x 2470, not 2440: at 2440 its west end reached into the Main St gate's approach,
  // pinching the city's own road where it enters the yard.
  obj.authored("wagon-2470-596", "wagon", 2470, 596, 190, 74, { facing: "E" }),

  /** The water tank, beside the lead: an engine takes water on its way to the table. */
  obj.authored("water-tank-2760-336", "waterTank", 2760, 336, 132, 132),

  // Points rodding and the ground frame at the throat, tucked clear of the crossing.
  obj.authored("utility-box-2896-320", "utilityBox", 2896, 320, 30, 22, { facing: "S" }),
  obj.authored("drum-2870-620", "drum", 2870, 620, 28, 28),
  obj.authored("drum-2900-620", "drum", 2900, 620, 28, 28),
  obj.authored("crate-stack-3320-320", "crateStack", 3320, 320, 44, 44),
  obj.authored("pallet-3320-380", "pallet", 3320, 380, 52, 38),
  obj.authored("pallet-3380-380", "pallet", 3380, 380, 52, 38),

  // Sleepers stacked along the throat's east end, on a rhythm.
  ...obj.derived(
    rhythmRule("yard-sleeper-stacks", "sleeper stack rhythm", "x", "rhythm(3400, 3900, 96)", 3400, 3900, 96),
    () => rhythm(3400, 3900, 96).map((x) => obj("crateStack", x, 560, 46, 46)),
  ),

  // Lamps down the works road, matching Downtown's spacing so one street reads as one.
  ...obj.derived(
    rhythmRule("yard-works-n-lamps", "north works-road lamp rhythm", "x", "rhythm(W0 + 100, W1 - 100, 200, [[LEAD_X - 90, LEAD_X + 140]])", W0 + 100, W1 - 100, 200, [[LEAD_X - 90, LEAD_X + 140]]),
    () => rhythm(W0 + 100, W1 - 100, 200, [[LEAD_X - 90, LEAD_X + 140]])
      .map((x) => obj("lampPost", x - 9, WORKS_N_KERB - 22, 18, 18, { facing: "S" })),
  ),
  ...obj.derived(
    rhythmRule("yard-works-s-lamps", "south works-road lamp rhythm", "x", "rhythm(W0 + 200, W1 - 100, 200, [[LEAD_X - 90, LEAD_X + 140]])", W0 + 200, W1 - 100, 200, [[LEAD_X - 90, LEAD_X + 140]]),
    () => rhythm(W0 + 200, W1 - 100, 200, [[LEAD_X - 90, LEAD_X + 140]])
      .map((x) => obj("lampPost", x - 9, WORKS_S_KERB + 4, 18, 18, { facing: "N" })),
  ),
  /**
   * One sign on the works road, outside the box — and BESIDE its door, not in front of it.
   *
   * It was at x 3118, which spans the doorway's own centre line (3140) fifty units out from
   * the shell. A bot needs 24 units of clearance from each of them, so the only standable
   * ground in front of the signal box's ONLY door was a band about two units wide, and the
   * navigator could not find a route into the building at all.
   *
   * This is the third sign to do exactly this, and the second in as many sessions — the
   * fairground's north arch had one dead centre of a 110-wide opening. A sign belongs at the
   * edge of an approach, because the approach is what it is pointing at.
   *
   * What it says is derived from the building it stands against — see `signs.ts` — never
   * typed here.
   */
  obj.authored("sign-3216-660", "sign", 3216, 660, 44, 12),

  // -- The turntable and its apron ---------------------------------------
  /**
   * The table. Flat, because a turntable deck is something you walk across, and the
   * strongest single image the region has: everything round it is radial, which is
   * the one kind of structure a strict overhead view does not flatten.
   */
  obj.authored("turntable-table-x-table-radius-table-y-table-radius", "turntable", TABLE.x - TABLE_RADIUS, TABLE.y - TABLE_RADIUS, TABLE_RADIUS * 2, TABLE_RADIUS * 2),

  // Ash and clinker where engines stand waiting for the road, north of the pit.
  obj.authored("drum-2790-1010", "drum", 2790, 1010, 30, 30),
  obj.authored("drum-2822-1012", "drum", 2822, 1012, 28, 28),
  obj.authored("dumpster-3140-1000", "dumpster", 3140, 1000, 70, 40, { solid: true }),

  // -- The wagon sidings, east -------------------------------------------
  ...obj.derived(
    rhythmRule("yard-siding-lines", "siding track list", "y", "[1000, 1090, 1180]", 1000, 1180, 90),
    () => [1000, 1090, 1180].map((y) => obj("track", 3420, y, W1 - 3420 - 40, GAUGE)),
  ),
  ...obj.derived(
    rhythmRule("yard-siding-stops", "siding buffer-stop list", "y", "[1000, 1090, 1180]", 1000, 1180, 90),
    () => [1000, 1090, 1180].map((y) => obj("bufferStop", W1 - 62, y - 6, 46, GAUGE + 12, { facing: "E" })),
  ),

  /**
   * Two rakes of wagons, and the third road left empty.
   *
   * A yard with every siding full is a diagram of a yard. The empty road is where the
   * next train goes, and it is also the only cover-free lane through the sidings —
   * which makes crossing it a decision.
   */
  ...obj.derived(
    rhythmRule("yard-rake-n", "north wagon rhythm", "x", "rhythm(3470, 3900, 216)", 3470, 3900, 216),
    () => rhythm(3470, 3900, 216).map((x) => obj("wagon", x, 994, 200, 64, { facing: "E" })),
  ),
  ...obj.derived(
    rhythmRule("yard-rake-s", "south wagon rhythm", "x", "rhythm(3560, 3990, 216)", 3560, 3990, 216),
    () => rhythm(3560, 3990, 216).map((x) => obj("wagon", x, 1084, 200, 64, { facing: "E" })),
  ),

  // -- The back fence ----------------------------------------------------
  // Weeds have taken the strip behind the shed; the thickets are the region saying
  // there is nothing back there. The spur gate stays clear through this rhythm.
  ...obj.derived(
    rhythmRule(
      "yard-back-thickets",
      "back-fence thicket rhythm",
      "x",
      "rhythm(3480, 4090, 152, [[3560, 3900]])",
      3480,
      4090,
      152,
      [[3560, 3900]],
    ),
    () => rhythm(3480, 4090, 152, [[3560, 3900]]).map((x) => obj("thicket", x, 1600, 116, 104)),
  ),
  ...obj.derived(
    rhythmRule("yard-spur-thickets", "spur-gate thicket rhythm", "x", "rhythm(2500, 2960, 168)", 2500, 2960, 168),
    () => rhythm(2500, 2960, 168).map((x) => obj("thicket", x, 1734, 124, 108)),
  ),

  /**
   * The scrap road, and the reason it exists is that the yard had two dead quarters.
   *
   * A depot is not empty hardstanding — the space between the sidings and the shed is where
   * everything worn out ends up, and drawn as bare tarmac it read as an unfinished part of
   * the map. So: a fourth road nobody clears, the wheelsets and sleepers stacked along it,
   * and a rake of condemned wagons at the end.
   *
   * All of it EAST of x 3440, because the roundhouse's fan reaches x 3421 at its northern
   * end and a bounding box does not say so. Placed by eye, six of these stood inside the
   * shed. In an annulus the only safe test is `271 <= r <= 469` from the turntable.
   */
  obj.authored("scrap-road", "track", 3460, 1290, W1 - 3500, GAUGE),
  obj.authored("buffer-stop-w1-62-1284", "bufferStop", W1 - 62, 1284, 46, GAUGE + 12, { facing: "E" }),
  ...obj.derived(
    rhythmRule("yard-scrap-wagons", "scrap-road wagon rhythm", "x", "rhythm(3500, 3800, 216)", 3500, 3800, 216),
    () => rhythm(3500, 3800, 216).map((x) => obj("wagon", x, 1284, 200, 64, { facing: "E" })),
  ),
  ...obj.derived(
    rhythmRule("yard-scrap-crates", "scrap-road crate rhythm", "x", "rhythm(3480, 3980, 128)", 3480, 3980, 128),
    () => rhythm(3480, 3980, 128).map((x) => obj("crateStack", x, 1400, 46, 46)),
  ),
  ...obj.derived(
    rhythmRule("yard-scrap-pallets", "scrap-road pallet rhythm", "x", "rhythm(3520, 3980, 128)", 3520, 3980, 128),
    () => rhythm(3520, 3980, 128).map((x) => obj("pallet", x, 1470, 54, 40)),
  ),
  obj.authored("dumpster-3480-1560", "dumpster", 3480, 1560, 74, 42, { solid: true }),
  obj.authored("dumpster-3480-1610", "dumpster", 3480, 1610, 74, 42, { solid: true }),
  obj.authored("drum-3570-1564", "drum", 3570, 1564, 30, 30),
  obj.authored("drum-3604-1564", "drum", 3604, 1564, 30, 30),
  obj.authored("drum-3570-1600", "drum", 3570, 1600, 30, 30),
  // Clear of the COAL ROAD arrival point, 200 units west: a squad spreads 72 units east
  // and south of where it lands, so an insertion needs a genuinely empty 120 square.
  obj.authored("crate-stack-2700-980", "crateStack", 2700, 980, 46, 46),
  obj.authored("crate-stack-2752-984", "crateStack", 2752, 984, 42, 42),
  obj.authored("drum-2700-1044", "drum", 2700, 1044, 30, 30),
  obj.authored("drum-2734-1044", "drum", 2734, 1044, 30, 30),
  // South of the shed's outer arc. At y 1690 its east end was 7 units inside the
  // roundhouse's wall, which a bounding-box check reports as fine.
  obj.authored("log-2620-1724", "log", 2620, 1724, 210, 46, { facing: "E" }),

  /**
   * Roundhouse sign, beside the east bay rather than across it. Its radial position is
   * inside the table apron and outside the shed's inner arc, leaving the bay road clear.
   */
  obj.authored("sign-3150-1268", "sign", 3150, 1268, 44, 12),
  /**
   * Turntable extraction sign on the north-east shoulder. The lead is the table's only
   * route back to the yard and runs west of it, so the plate cannot narrow that passage.
   */
  obj.authored("sign-3050-1138", "sign", 3050, 1138, 44, 12),
];

export const railYard: RegionParts = {
  id: "yard",
  name: "Fenchurch Yard",
  sourceFile: SOURCE_FILE,
  roads,
  surfaces,
  regions,
  walls: [
    /**
     * The yard's own back fence, with the spur gate in it.
     *
     * A railway is always fenced, and here the fence is doing level design: it makes
     * the yard a place you are inside rather than a patch of a continuous carpet, and
     * the single gap is the abandoned spur running south into the jungle — the one way
     * on to the temple, and legible as a way out from anywhere in the yard.
     */
    /**
     * The 240-wide gate contains the abandoned rail formation on its west side and the
     * continuing foot trail on its east. The pyramid leaves no usable route behind the
     * old western opening; this opening keeps the ballast, stop, clearing and full-size
     * traversal lane in one composition.
     */
    ...fenceRun("yard-fence-s", "h", S1, W0 - 26, 4200, 26, [[3600, 3840]]),
  ],
  objects: yardObjects,
  dotSpawns: [
    dot("dashOvercharge", 3000, 690),
    dot("health", 3300, 1090),
    dot("radar", 2500, 1160),
    dot("incognito", 4040, 900),
    dot("health", 3660, 640),
  ],
  buildings: [roundhouse, signalBox],
  extractionPoints: [
    /**
     * On the turntable, which is the best extraction pad in the world so far: a round
     * open deck with one way off it, watched by three bay doors and a signal box.
     */
    { id: "extract-table", name: "TURNTABLE", rect: { x: TABLE.x - 55, y: TABLE.y - 55, w: 110, h: 110 } },
  ],
  insertionPoints: [
    // On hardstanding rather than on the carriageway — a squad needs 120 units of
    // clear depth and the road is exactly 120 with a lamp every 200 along both kerbs.
    { id: "yard-west", name: "COAL ROAD", position: { x: 2500, y: 1080 } },
    { id: "yard-east", name: "SIDINGS", position: { x: 4020, y: 620 } },
  ],
  /**
   * A spawn needs `botRadius` of clearance from every solid, or the navigator
   * will not plan FROM it and the bot stands there for the whole match — while
   * re-running a failed exhaustive search every tick. Three of these four were
   * authored against a landmark's centre, because a landmark is the obvious
   * thing to describe a position by and its centre is the middle of a solid.
   * Describe them by the space beside the landmark instead.
   */
  botSpawns: [
    // In the 136-unit aisle between the two wagon rakes (y 1084-1148 and 1284-1348),
    // not inside the southern one.
    {
      id: "yard-1", name: "Rust", squadId: "rival-11", faction: "ambient", isAmbient: true, color: "#b06b3a", position: { x: 3600, y: 1216 },
      patrol: patrol("yard-wagon-rakes", "Inspect both wagon rakes and their loading aisle.", [
        { x: 3600, y: 1216 }, { x: 4000, y: 1216 }, { x: 4000, y: 1420 }, { x: 3424, y: 1444 }, { x: 3400, y: 1216 },
      ]),
    },
    // South-east of the water tank's base, which ends at x 2892 / y 468.
    {
      id: "yard-2", name: "Cinder", squadId: "rival-12", faction: "ambient", isAmbient: true, color: "#8d6e63", position: { x: 2930, y: 520 },
      patrol: patrol("yard-water-works-road", "Guard the water tank and works-road approach.", [
        { x: 2930, y: 520 }, { x: 3150, y: 520 }, { x: 3150, y: 760 }, { x: 2820, y: 760 }, { x: 2820, y: 600 },
      ]),
    },
    {
      id: "yard-3", name: "Ash", squadId: "rival-13", faction: "ambient", isAmbient: true, color: "#6d6a63", position: { x: 2860, y: 1560 }, floorId: "roundhouse:GROUND",
      patrol: patrol("roundhouse-apron", "Walk the roundhouse bay mouths and turntable-side apron.", [
        { x: 2860, y: 1560 }, { x: 3100, y: 1516 }, { x: 3300, y: 1460 }, { x: 3100, y: 1360 }, { x: 2860, y: 1400 },
      ]),
    },
    // On the box's south approach: the operating floor is deliberately a tight
    // one-person room, while this loop gives a guard the yard door and works-road
    // crossing without turning the stair landing into a four-step patrol.
    {
      id: "yard-4", name: "Signal", squadId: "rival-14", faction: "ambient", isAmbient: true, color: "#4a7c8c", position: { x: 3140, y: 680 },
      patrol: patrol("signal-box-south-approach", "Guard the signal-box yard door and works-road crossing.", [
        { x: 3140, y: 680 }, { x: 3380, y: 680 }, { x: 3380, y: 800 }, { x: 2940, y: 800 }, { x: 2940, y: 680 },
      ]),
    },
  ],
};
