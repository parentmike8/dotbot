import { compileCityPlan, type CityPlan } from "../cityPlan";
import { HALL, pavilion } from "./pavilion";
import { blobPoly, boxPoly, dots, objects, rhythm, ribbonPoly, type RegionParts } from "./regionKit";
import type { MapObject } from "../types";

/**
 * THE PLEASURE GROUND — the fair south of the city, and the jungle taking it back.
 *
 * Third Ave runs out of Downtown through the south gate and becomes the fair's drive,
 * which is the whole transition: the street does not stop, it just runs out of city.
 *
 * The region brief:
 *
 *  - PURPOSE: a pleasure ground that closed and was never cleared.
 *  - ZONES: the drive and its car park at the north; the pavilion facing back up it;
 *    the midway running west; the rides along both sides of the midway; the reclaimed
 *    south, where the growth has come in.
 *  - SEQUENCE: down the drive, past the pavilion, along the midway, and the further
 *    west and south you go the less of it is left.
 *  - ADJACENCY: every ride addresses the midway, because a fairground is an axis with
 *    attractions hung off it. Nothing here is scattered.
 *  - NEGATIVE SPACE: the midway itself, 300 units of open promenade with cover only at
 *    its edges. It is the region's long sightline and the reason the rides matter.
 *
 * The composition rests on one decision: the midway is the LINE BETWEEN two states.
 * North of it the fair still reads as a fair; south of it the undergrowth has won, and
 * the ferris wheel stands in it. That gives the region a story you can see in one
 * frame, and it makes the handover to the temple region legible — the jungle arrives
 * here first, and the trail east leaves through it.
 *
 * A note on motion, since a fairground is the obvious place to want it: everything
 * here is DERELICT, so everything here is genuinely still. The language's fourth rule
 * — nothing in motion drawn statically — is satisfied without a single animated frame,
 * because a wheel that does not turn is the truth about the place.
 */

const obj = objects("fair");
const dot = dots("fair");

const W0 = 26;
const W1 = 2374;
const N0 = 1600;
const S1 = 3374;

/** Third Ave, continued south as the fair's drive. Same centreline as in the city. */
const DRIVE_X = 1220;
const CARRIAGEWAY = 120;
const FOOTWAY = 96;
const DRIVE_END = 2060;
const DRIVE_W_KERB = DRIVE_X - CARRIAGEWAY / 2; // 1160
const DRIVE_W_BACK = DRIVE_W_KERB - FOOTWAY; //   1064
const DRIVE_E_KERB = DRIVE_X + CARRIAGEWAY / 2; // 1280
const DRIVE_E_BACK = DRIVE_E_KERB + FOOTWAY; //   1376

/** The midway's centreline, and everything on the site is placed off it. */
const MIDWAY: Array<{ x: number; y: number }> = [
  { x: 2300, y: 2410 },
  { x: 1980, y: 2375 },
  { x: 1780, y: 2358 },
  { x: 1400, y: 2345 },
  { x: 1000, y: 2352 },
  { x: 600, y: 2382 },
  { x: 180, y: 2424 },
];

const cityPlan: CityPlan = {
  streets: [{
    /**
     * Starts 26 units NORTH of the region, inside the city's fence line.
     *
     * Third Ave ends at y 1574 and this began at 1600, which is the fence's own
     * thickness — so the carriageway had a 26-unit hole in it exactly where the gate
     * is, and the one place the two regions are meant to read as one street was the
     * one place the street stopped. Reported from play: "the break in the road is not
     * good." A street that continues has to continue THROUGH the wall it passes.
     */
    id: "fair-drive",
    from: { x: DRIVE_X, y: N0 - 26 },
    to: { x: DRIVE_X, y: DRIVE_END },
    width: CARRIAGEWAY,
    footway: FOOTWAY,
  }],
  patches: [
    /**
     * The car park west of the drive and the queueing ground east of it.
     *
     * These stay rectangles because they are the two pieces of this region a person
     * laid out: a graded car park and the trodden apron where the crowd waited. The
     * rest of the fair is authored as regions, and the difference is legible — the
     * closer the ground is to being made, the closer it is to being square.
     */
    { id: "fair-carpark", kind: "yard", x: W0, y: N0, w: DRIVE_W_BACK - W0, h: 300 },
    { id: "fair-queue", kind: "clearing", x: DRIVE_E_BACK, y: N0, w: W1 - DRIVE_E_BACK, h: 300 },
  ],
  regions: [
    /**
     * The wild ground, laid down first so everything else is something reclaimed FROM
     * it. Authoring it the other way round — paving with growth added on top — is what
     * makes a derelict place look like a clean place with dirt on it.
     */
    { id: "fair-wild", kind: "undergrowth", points: boxPoly(W0, 1900, W1 - W0, S1 - 1900) },

    /** The midway: a promenade, and the region's whole armature. */
    {
      id: "fair-midway",
      kind: "plaza",
      points: ribbonPoly(MIDWAY, (t) => 300 - t * 80),
    },

    /**
     * The trodden ground round the pavilion, reaching all four of its archways.
     *
     * A hall entered on four sides needs approach on four sides, and a ring is the
     * honest shape for it — the crowd wore the grass off all the way round, because
     * that is what a crowd does to a building it circles.
     */
    { id: "fair-hall-ground", kind: "clearing", points: blobPoly(HALL.x, HALL.y, 405, 400, "hall", 0.16, 20) },

    /** The forecourt at the drive's foot, joining the street to the midway. */
    { id: "fair-forecourt", kind: "clearing", points: blobPoly(DRIVE_X, 2100, 280, 220, "fore", 0.2, 17) },

    // Worn ground under each ride, so a ride stands on its own apron rather than in
    // the weeds. Where the apron is gone the ride has been abandoned longer.
    { id: "fair-carousel-ground", kind: "clearing", points: blobPoly(1180, 2130, 215, 210, "car", 0.22, 15) },
    { id: "fair-swing-ground", kind: "clearing", points: blobPoly(560, 2150, 205, 200, "swg", 0.24, 15) },

    /**
     * Weeds coming up THROUGH the midway.
     *
     * Small, several, and on the promenade rather than beside it. This is the one
     * gesture that separates "closed" from "abandoned": paving with growth in its
     * joints has not been swept for years, and no amount of dressing at the edges says
     * that.
     */
    { id: "fair-weeds-a", kind: "undergrowth", points: blobPoly(1620, 2300, 96, 74, "wa", 0.6, 11) },
    { id: "fair-weeds-b", kind: "undergrowth", points: blobPoly(880, 2440, 130, 86, "wb", 0.6, 11) },
    { id: "fair-weeds-c", kind: "undergrowth", points: blobPoly(340, 2360, 110, 92, "wc", 0.6, 11) },
    { id: "fair-weeds-d", kind: "undergrowth", points: blobPoly(2140, 2470, 120, 80, "wd", 0.6, 11) },

    /**
     * The trail east, off the midway and into the growth.
     *
     * The link to the temple region, and it is a TRAIL rather than a road on purpose:
     * the world's gradient runs city → depot → fair → ruin, and the ground you walk on
     * has to get less made at every step or the gradient is only in the objects.
     */
    {
      id: "fair-trail-e",
      kind: "clearing",
      points: ribbonPoly([
        { x: 1900, y: 2470 },
        { x: 2020, y: 2650 },
        { x: 2140, y: 2830 },
        { x: 2280, y: 2960 },
        { x: W1 + 30, y: 3020 },
      ], (t) => 170 - t * 50),
    },
  ],
  approaches: [
    // The drive's foot to the forecourt: the one piece of paving that has to hold, since
    // it is how a squad walking out of Downtown reaches the fair at all.
    { id: "fair-drive-foot", from: { x: DRIVE_X, y: DRIVE_END - 20 }, to: { x: DRIVE_X, y: 2160 }, width: 120 },
  ],
};

const { roads, surfaces, regions } = compileCityPlan(cityPlan);

/** A kiosk line along the midway's north edge, with the rides punched out of it. */
/**
 * Gaps only where a ride or the hall actually is, and no wider.
 *
 * The first set of gaps was generous enough that the 190-unit rhythm produced THREE
 * kiosks along a 2000-unit promenade — a midway with nothing on it. A gap is for a
 * building or a ride, not for comfort.
 */
const KIOSK_GAPS: Array<[number, number]> = [
  [1040, 1330], // the carousel
  [1490, 2050], // the pavilion
  [420, 720], // the swing ride
];

const fairObjects: MapObject[] = [
  // -- The rides, each addressing the midway -----------------------------
  /**
   * The carousel: the fair's own signature, and the most legible object in the region
   * from directly overhead. Round, striped, scalloped, with one horse missing.
   */
  obj("carousel", 1015, 1965, 330, 330),

  /** A chairoplane, seats hanging still. Radial, and it survives this camera. */
  obj("swingRide", 405, 1995, 310, 310),

  /**
   * The waltzer, south of the midway where the growth has already reached it. Its dish
   * holds rainwater, which is the one detail that says abandoned about a RIDE rather
   * than about the ground it stands on.
   */
  obj("waltzer", 930, 2560, 300, 300),

  /**
   * The wheel, standing in the undergrowth south of the midway.
   *
   * Seen from directly above it is a line — a narrow band with gondolas along it — and
   * drawing it as anything else would be the exact perspective cheat this language
   * exists to refuse. Placed off the promenade and pointing south, so the line reads
   * against the midway rather than along it, and so the jungle is what it is standing
   * in. It is the thing you see first from the gate and the last thing still upright.
   */
  obj("ferrisWheel", 2130, 2540, 132, 620),

  // -- The midway's furniture, on a rhythm with the rides punched out -----
  ...rhythm(240, 2280, 152, KIOSK_GAPS).map((x) => obj("kiosk", x, 2166, 78, 54)),
  ...rhythm(320, 2280, 152, KIOSK_GAPS).map((x) => obj("bench", x, 2494, 96, 24, { facing: "N" })),
  // Festoon poles down both edges, on the half beat so the two rhythms interleave.
  // The north festoon line breaks for the pavilion: on the plain rhythm a lamp post stood
  // 15 units in front of the hall's south archway, which is the single most common way an
  // otherwise fine street ruins a building. The south line has no building to dodge.
  ...rhythm(240, 2300, 190, [[1620, 1900]]).map((x) => obj("lampPost", x, 2244, 18, 18)),
  ...rhythm(340, 2300, 190).map((x) => obj("lampPost", x, 2452, 18, 18)),
  /**
   * One sign on the queueing ground outside the pavilion's north arch, BESIDE the
   * arch rather than in front of it.
   *
   * It was at HALL.x - 22, which is the archway's own centre line — a 44-wide sign
   * squarely in the middle of a 110-wide opening, leaving two 33-unit slots for a
   * 48-wide bot. Reported from play: "the sign at the north entrance doesn't let me
   * get there." What it reads is derived from the building nearest it.
   */
  obj("sign", HALL.x + 96, 1636, 44, 12),

  // -- The gate and the car park ------------------------------------------
  obj("bollard", DRIVE_W_KERB - 24, 1980, 18, 18),
  obj("bollard", DRIVE_E_KERB + 6, 1980, 18, 18),
  ...rhythm(120, 900, 130).map((x) => obj("parkingStall", x, 1660, 116, 54)),
  ...rhythm(120, 900, 130).map((x) => obj("parkingStall", x, 1780, 116, 54)),
  obj("car", 258, 1668, 104, 42, { facing: "E" }),
  obj("car", 518, 1790, 104, 42, { facing: "E" }),
  obj("dumpster", 960, 1832, 70, 40, { solid: true }),
  obj("drum", 1040, 1836, 28, 28),
  ...rhythm(1450, 2280, 208).map((x) => obj("tree", x, 1650, 46, 46)),

  // -- The reclaimed south -------------------------------------------------
  /**
   * Thickets on a rhythm along the region's south and west, because the growth came in
   * as a front rather than in patches. They are solid, so together they are the wall
   * that says the site ends here — which is what a wall of vegetation actually does.
   */
  ...rhythm(120, 2280, 176).map((x, i) => obj("thicket", x, 3080 + (i % 3) * 74, 148, 132)),
  ...rhythm(2660, 3200, 168).map((y) => obj("thicket", 90, y, 140, 128)),
  ...rhythm(1500, 2300, 210).map((x) => obj("thicket", x, 2740, 132, 118)),

  // The skeletons of stalls the growth took first: a line of them off the midway's
  // south side, still on the rhythm they were pitched to.
  ...rhythm(500, 1000, 170).map((x) => obj("kiosk", x, 2720, 70, 50)),
  obj("log", 1300, 2800, 230, 48, { facing: "E" }),
  obj("log", 700, 3000, 200, 44, { facing: "E" }),
  obj("thicket", 1720, 2960, 160, 140),
  obj("thicket", 1980, 3120, 150, 134),
  /**
   * The generator house and the tanks that ran the lights, dumped where they stood.
   *
   * The reclaimed half was a field with a ride in it. A fairground's back-of-house is the
   * least glamorous and most characteristic thing on the site — every ride on the midway
   * was fed from here — so putting it in the part the growth took first says both things
   * at once: what the place was for, and that nobody came back for it.
   */
  obj("generator", 1320, 2600, 150, 90),
  obj("drum", 1490, 2604, 34, 34),
  obj("drum", 1490, 2644, 34, 34),
  obj("drum", 1530, 2624, 32, 32),
  obj("crateStack", 1340, 2710, 48, 48),
  obj("dumpster", 1420, 2716, 74, 42, { solid: true }),
  obj("kiosk", 1620, 2700, 78, 54),
  obj("kiosk", 1760, 2760, 78, 54),
  ...rhythm(1180, 1560, 190).map((x) => obj("tree", x, 3000, 96, 96)),

  // Trees along the midway's west end, where the avenue is turning back into wood.
  // Jungle scale, not street scale. At 54 units these read as boulders on the floor; a
  // tree that has been growing since the fair closed is twice that.
  ...rhythm(200, 820, 210).map((x) => obj("tree", x, 2620, 104, 104)),
  ...rhythm(300, 760, 230).map((x) => obj("tree", x, 2870, 92, 92)),
  obj("tree", 360, 2180, 76, 76),

  /**
   * The wood closing in from the west, on its own rhythm.
   *
   * The reclaimed half had a front along its south edge and a line down its west, and
   * nothing in between — a field with a wall of vegetation round it. Growth advances in
   * fingers, so the middle gets thickets on a coarser interval than the front, with trees
   * between them: the front says the site ends, and these say it is being taken.
   */
  ...rhythm(240, 900, 208).map((x, i) => obj("thicket", x, 2760 + (i % 2) * 96, 142, 128)),
  ...rhythm(300, 860, 224).map((x) => obj("tree", x, 2960, 98, 98)),
  obj("log", 420, 2680, 190, 44, { facing: "E" }),
  obj("thicket", 1000, 2900, 150, 132),
];

export const fairground: RegionParts = {
  id: "fair",
  name: "The Pleasure Ground",
  roads,
  surfaces,
  regions,
  objects: fairObjects,
  dotSpawns: [
    dot("health", 1500, 2330),
    dot("dashOvercharge", 820, 2330),
    dot("radar", 1180, 2400),
    dot("incognito", 2100, 2860),
    dot("health", 420, 2450),
    dot("dashOvercharge", 300, 1740),
  ],
  buildings: [pavilion],
  extractionPoints: [
    // On the midway, halfway along: open promenade with cover only at its edges, which
    // is exactly the pressure an extraction should be under.
    { id: "extract-midway", name: "MIDWAY", rect: { x: 890, y: 2300, w: 110, h: 110 } },
  ],
  insertionPoints: [
    { id: "fair-carpark", name: "CAR PARK", position: { x: 760, y: 1760 } },
    // On the open stretch of promenade between the carousel and the pavilion, where the
    // festoon rhythm has a whole beat missing. A squad needs 120 units of clear depth and
    // the midway is the only ground in the region that reliably has it.
    { id: "fair-avenue", name: "THE AVENUE", position: { x: 1250, y: 2340 } },
  ],
  /** See the note on `railYard`'s spawns: a spawn inside a solid never moves. */
  botSpawns: [
    { id: "fair-1", name: "Tinsel", squadId: "rival-15", isAmbient: true, color: "#c96b9b", position: { x: 1620, y: 2420 } },
    // South of the swing ride's platform, which ends at y 2305. Was inside it.
    { id: "fair-2", name: "Cotton", squadId: "rival-16", isAmbient: true, color: "#d9a05b", position: { x: 620, y: 2350 } },
    // Standing AT the bar, not in it: the counter's east face is HALL.x - 176.
    { id: "fair-3", name: "Bulb", squadId: "rival-17", isAmbient: true, color: "#8c7ab8", position: { x: HALL.x - 130, y: HALL.y + 30 }, floorId: "pavilion:GROUND" },
    // Out in the gallery ring. HALL.x + 230 was inside the east box's couch.
    { id: "fair-4", name: "Reel", squadId: "rival-18", isAmbient: true, color: "#5f8c7a", position: { x: HALL.x + 120, y: HALL.y + 40 }, floorId: "pavilion:F1" },
  ],
};
