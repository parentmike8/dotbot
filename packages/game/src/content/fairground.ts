import { compileCityPlan, type CityPlan } from "../cityPlan";
import { HALL, pavilion } from "./pavilion";
import { blobPoly, boxPoly, dots, objects, patrol, rhythm, ribbonPoly, type RegionParts } from "./regionKit";
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
 * the big top stands in it. That gives the region a story you can see in one frame, and
 * it makes the handover to the temple region legible — the jungle arrives here first, and
 * the trail east leaves through it, bending round the tent on its way.
 *
 * A NOTE ON MOTION, since a fairground is the obvious place to want it — and since the
 * earlier version of this note got it wrong in a way that changed the content.
 *
 * It said everything here is derelict so everything here is genuinely still, and called
 * that a virtue. It is not. Rule 4 is a ban on freezing a moving thing into a still mark,
 * not a preference for still subjects, and reading it the other way is why a chairoplane
 * was deleted instead of given swinging seats. **Motion is wanted here** — the carousel,
 * swing ride and waltzer should turn, slowly and unevenly, because WIND moving rides nobody
 * maintains is a better derelict story than a ride welded solid. See `docs/world-motion.md`.
 *
 * What the four attractions on the site DO have in common is that their plan names them —
 * a striped disc, an airborne chair ring, a dished platform, a two-peaked tent — and that is a rule
 * about a strictly overhead camera, which is a different thing entirely. A ferris wheel
 * fails it because a vertical wheel from above is a line however fast it spins.
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
    { id: "fair-skelter-ground", kind: "clearing", points: blobPoly(560, 2150, 205, 200, "swg", 0.24, 15) },
    /**
     * The big top's apron, and it is the one that is nearly GONE.
     *
     * Deliberately smaller than the tent it belongs to — 300 x 220 under a 460 x 320
     * mass — so the growth is standing right up against the canvas on three sides. Every
     * other ride here gets an apron that clears it. This one is at the end of the midway,
     * which is the end the jungle reached first, and a worn ring that fitted would say
     * somebody still walks round it.
     */
    { id: "fair-bigtop-ground", kind: "clearing", points: blobPoly(2130, 2740, 150, 110, "btop", 0.3, 15) },

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
     *
     * It ran dead straight from the midway to the region's east edge, which put it
     * through the middle of where the big top now stands. Bent round the tent's west and
     * south flanks instead, and it is the better trail for it: a path that turns because
     * something is in the way is a path somebody wore, and a straight one across open
     * ground is a line on a drawing. The bend also keeps the tent's west lane open — the
     * kiosk at 1838 and the canvas at 1900 leave 62 units between them, and the trail
     * points a squad at that gap rather than at the canvas.
     */
    {
      id: "fair-trail-e",
      kind: "clearing",
      points: ribbonPoly([
        { x: 1900, y: 2470 },
        { x: 1810, y: 2640 },
        { x: 1800, y: 2830 },
        { x: 1930, y: 2980 },
        { x: 2180, y: 3030 },
        { x: W1 + 30, y: 3040 },
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

  /**
   * The chairoplane, restored at the promenade's west end.
   *
   * Its earlier pale squares were too small to read as seats and, worse, were frozen.
   * The current glyph gives every chair a back and short suspension and moves the
   * whole airborne ring, so motion supplies the identity without inventing a side view.
   */
  obj("swingRide", 405, 1995, 310, 310),

  /**
   * The waltzer, south of the midway where the growth has already reached it. Its dish
   * holds rainwater, which is the one detail that says abandoned about a RIDE rather
   * than about the ground it stands on.
   */
  obj("waltzer", 930, 2560, 300, 300),

  /**
   * THE BIG TOP, at the head of the midway, and it took over the ferris wheel's job.
   *
   * The wheel's job was to be the thing you see first from the gate and the last thing
   * still standing, and it could not do it: seen from directly above a vertical wheel is
   * a line, and no amount of drawing made a line read as a wheel. A tent does the job
   * properly, because a two-pole tent's plan IS a big top — a stadium of canvas with a
   * peak at each end — and it is the largest single mass in the region.
   *
   * It keeps the wheel's site and the wheel's role: standing in the growth at the far end
   * of the midway, half taken by the jungle, the biggest mass on the site and the last
   * thing still upright. The trail east now bends round it, which is a better trail than
   * the straight one was — the bend has a reason, and the tent is on the way out.
   *
   * The queueing ground north of the pavilion was the first choice and the numbers killed
   * it, which is worth recording because that apron looks empty on a plan. The pavilion's
   * octagon reaches x 2037 at its east corners and the city fence stands at 2374, so a
   * 300-wide tent between them leaves 17 units of lane on one side and 20 on the other,
   * and SEALS the whole east flank of the building. A landmark that closes a route is the
   * same defect as an invisible wall, arrived at from the other side.
   *
   * Its north hem is at y 2590, which is 72 units clear of the bench line ending at 2518.
   * That is the number that was checked first, and it is why the tent is not 30 units
   * further north: at y 2560 the gap was 42, and a bot is 48 across.
   */
  obj("bigTop", 1900, 2590, 460, 320, { facing: "N" }),

  // -- The midway's furniture, on a rhythm with the rides punched out -----
  ...rhythm(240, 2280, 152, KIOSK_GAPS).map((x) => obj("kiosk", x, 2166, 78, 54)),
  ...rhythm(320, 2280, 152, KIOSK_GAPS).map((x) => obj("bench", x, 2494, 96, 24, { facing: "N" })),
  // Festoon poles down both edges, on the half beat so the two rhythms interleave.
  // The north festoon line breaks for the pavilion: on the plain rhythm a lamp post stood
  // 15 units in front of the hall's south archway, which is the single most common way an
  // otherwise fine street ruins a building. The south line has no building to dodge.
  // `facing` is the direction the mast arm reaches, and it always reaches over the way it
  // lights — so the north line points south down the midway and the south line points north.
  ...rhythm(240, 2300, 190, [[1620, 1900]]).map((x) => obj("lampPost", x, 2244, 18, 18, { facing: "S" })),
  ...rhythm(340, 2300, 190).map((x) => obj("lampPost", x, 2452, 18, 18, { facing: "N" })),
  /**
   * One sign on the queueing ground outside the pavilion's north arch, BESIDE the
   * arch rather than in front of it or under the nearby tree line.
   *
   * It was at HALL.x - 22, which is the archway's own centre line — a 44-wide sign
   * squarely in the middle of a 110-wide opening, leaving two 33-unit slots for a
   * 48-wide bot. Reported from play: "the sign at the north entrance doesn't let me
   * get there." What it reads is derived from the building nearest it.
   */
  obj("sign", HALL.x - 172, 1636, 44, 12),

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
  // The gap is the big top. The rhythm ran 1500 → 2340 and put three thickets inside the
  // tent, which is the same defect as the four that were growing through the temple's
  // terrace wall: a rule-placed line has to stop for a building.
  ...rhythm(1500, 2300, 210, [[1840, 2374]]).map((x) => obj("thicket", x, 2740, 132, 118)),

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

  /**
   * Midway extraction sign on the pad's east side. North and south are the promenade's
   * two long walking lanes, so neither is an acceptable place for a solid plate.
   */
  obj("sign", 1018, 2348, 44, 12),
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
    // On the trail east where it comes back out from behind the big top. It was at
    // 2100,2860 — which is now inside the tent, since the trail it used to sit on ran
    // straight through where the tent stands.
    dot("incognito", 2020, 3010),
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
    {
      id: "fair-1", name: "Tinsel", squadId: "rival-15", faction: "ambient", isAmbient: true, color: "#c96b9b", position: { x: 1620, y: 2420 },
      patrol: patrol("fair-main-avenue", "Guard the fair's main avenue between the ride fronts.", [
        { x: 1620, y: 2420 }, { x: 2050, y: 2420 }, { x: 2050, y: 2552 }, { x: 1400, y: 2576 }, { x: 1400, y: 2420 },
      ]),
    },
    // South of the swing ride's base, which ends at y 2305. Was inside it.
    {
      id: "fair-2", name: "Cotton", squadId: "rival-16", faction: "ambient", isAmbient: true, color: "#d9a05b", position: { x: 620, y: 2350 },
      patrol: patrol("fair-west-entrance", "Watch the swing ride and west fair entrance.", [
        { x: 620, y: 2350 }, { x: 900, y: 2350 }, { x: 900, y: 2650 }, { x: 520, y: 2650 }, { x: 520, y: 2426 },
      ]),
    },
    // Standing AT the bar, not in it: the counter's east face is HALL.x - 176.
    {
      id: "fair-3", name: "Bulb", squadId: "rival-17", faction: "ambient", isAmbient: true, color: "#8c7ab8", position: { x: HALL.x - 130, y: HALL.y + 30 }, floorId: "pavilion:GROUND",
      patrol: patrol("pavilion-bar-hall", "Walk the pavilion bar, hall entrance, and room edge.", [
        { x: HALL.x - 130, y: HALL.y + 30 }, { x: HALL.x + 120, y: HALL.y + 30 },
        { x: HALL.x + 120, y: HALL.y + 196 }, { x: HALL.x - 20, y: HALL.y + 196 },
      ]),
    },
    // Out in the gallery ring. HALL.x + 230 was inside the east box's couch.
    {
      id: "fair-4", name: "Reel", squadId: "rival-18", faction: "ambient", isAmbient: true, color: "#5f8c7a", position: { x: HALL.x + 120, y: HALL.y + 40 }, floorId: "pavilion:F1",
      patrol: patrol("pavilion-gallery", "Watch the pavilion gallery perimeter and stair landing.", [
        { x: HALL.x + 120, y: HALL.y + 40 }, { x: HALL.x + 196, y: HALL.y + 136 },
        { x: HALL.x + 96, y: HALL.y + 228 }, { x: HALL.x - 132, y: HALL.y + 180 },
        { x: HALL.x - 180, y: HALL.y + 80 },
      ]),
    },
  ],
};
