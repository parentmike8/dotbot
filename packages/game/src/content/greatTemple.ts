import { compileBuilding, type SourceBuilding } from "../mapSource";

/**
 * THE GREAT TEMPLE — a stepped pyramid you climb, and the format being asked for
 * something it was not built to do.
 *
 * The problem, stated plainly: a stair belongs to a building and links two of its floors,
 * and a grand ceremonial stair up the outside of a pyramid is neither an interior stair
 * nor an outdoor one. Every way round it turned out to be a lie — the mass as scenery
 * with a stair drawn on it, or a summit reached by a hidden lift inside. What the format
 * actually wants, once you stop fighting it, is this:
 *
 *   GROUND is the entrance hall inside the base. ROOF is the summit platform. The grand
 *   stair is a real GROUND → ROOF stair, and the shell opens with an archway at its foot.
 *
 * Which is not a workaround. It is what a pyramid with a substructure IS: a tunnel mouth
 * at the bottom of the stair and a shrine at the top. And it produces the region's best
 * piece of level design for free — the hall gives you a CHOICE the moment you are inside.
 * Straight on up the flight to the shrine, or through the cross-wall door into the tomb
 * chamber, which has its own arch out onto the pyramid's blind north face.
 *
 * Two things the previous draft got wrong, both geometric rather than aesthetic:
 *
 *  - The base was 460 x 400 and read as a lopsided wedding cake. A pyramid is square.
 *  - Its stair ran 162 units against a 130-unit climb, so it overshot the summit and lay
 *    across the top of it like a ladder.
 *
 * And one this draft got wrong: the first version of the interior left the floor either
 * side of the stair walled off from everything, which is 100k units² of room inside a
 * solid mass that a bot could stand in and never reach. The hall is the full width of the
 * base now, so every part of the floor is somewhere.
 */

/** The base, square, addressing the plaza to its south. */
export const PYRAMID = { x: 3060, y: 1900, w: 520, h: 520 };
const CX = PYRAMID.x + PYRAMID.w / 2; // 3320

/** Inside the terrace wall. Every coordinate below is checked against this box. */
const IN = { w: PYRAMID.x + 40, e: PYRAMID.x + PYRAMID.w - 40, n: PYRAMID.y + 40, s: PYRAMID.y + PYRAMID.h - 40 };

/**
 * The grand stair: 150 wide, rising the hall's full depth.
 *
 * Wider than Downtown's 88 on purpose. A ceremonial stair is the widest thing in a
 * complex — it is meant to take a procession, not a fitter — and the contract only
 * forbids narrowing a flight below the proven figure, never widening one. Its flanks have
 * 145 units of open hall either side, so a bot arriving at either end can leave sideways
 * instead of being committed to the flight.
 */
const STAIR = { x: CX - 75, y: 2200, w: 150, h: IN.s - 2200 };
/** The cross wall between the hall and the chamber, abutting the stair's head exactly. */
const CROSS_Y = STAIR.y - 13;

export const GREAT_TEMPLE_SOURCE: SourceBuilding = {
  id: "temple",
  kind: "monument",
  name: "GREAT TEMPLE",
  /** A terrace wall is enormously thick. 40 is the mass reading as mass. */
  shellThickness: 40,
  outline: { shape: "rect", ...PYRAMID },
  stairs: [{
    id: "temple-grand-stair",
    rect: STAIR,
    from: "GROUND",
    to: "ROOF",
    bottom: "S",
    /**
     * Freestanding: the flight stands in the middle of the hall with floor either side, so
     * the dashed half gets balustrades and a far-end cap while the entry half stays open
     * at its foot and along both flanks.
     */
    access: "openEnd",
  }],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "The substructure: the hall at the stair's foot, and the tomb chamber behind it.",
        zones: ["the entrance hall", "the stair's foot", "the tomb chamber", "the north arch"],
        sequence: "In off the plaza through the south arch into the hall, then either straight up the flight to the shrine or west through the cross-wall door into the chamber and out its own arch onto the blind north face.",
        adjacency: "The chamber sits behind the hall with one door between them, so it can be held by one bot and is worth holding. Its second arch is on the face nobody on the plaza is watching.",
        negativeSpace: "The stair's foot and the whole width of the hall in front of it. It is the one place inside the mass that everything on the summit can see down onto.",
      },
      shellOpenings: [
        // The stair's own mouth, on the plaza face.
        { kind: "archway", width: 152, near: { x: CX, y: PYRAMID.y + PYRAMID.h } },
        // The way out of the chamber, on the blind north face.
        // West of centre, so the braziers inside can stand clear of both the doorway and
        // the lane down the chamber's west end.
        { kind: "archway", width: 96, near: { x: CX - 140, y: PYRAMID.y } },
      ],
      walls: [
        {
          /**
           * The cross wall, hall to chamber, running the full width of the base with one
           * door in it. It stops exactly where the stair's head begins, so there is no
           * 17-unit slot between the two for a bot to get wedged in and no pocket of floor
           * belonging to neither.
           */
          id: "temple-cross",
          thickness: 26,
          path: [{ x: IN.w, y: CROSS_Y }, { x: IN.e, y: CROSS_Y }],
          openings: [{ kind: "door", width: 84, near: { x: CX - 150, y: CROSS_Y } }],
        },
      ],
      objects: [
        /**
         * ONE object in each flank of the hall, hard against the terrace wall.
         *
         * A stele and a brazier stacked down each flank looked better and sealed the
         * chamber off: they left 40 units to the shell and 61 to the flight, and a bot is
         * 48 wide, so the door in the cross wall opened onto a slot nobody could walk out
         * of. The whole 31k-unit chamber came back as unreachable. Each flank is 145 units
         * wide and has to keep a lane, so it gets one thing in it.
         */
        { id: "temple-hall-brazier-w", kind: "brazier", x: 3110, y: 2310, w: 48, h: 48 },
        { id: "temple-hall-brazier-e", kind: "brazier", x: 3482, y: 2310, w: 48, h: 48 },

        // The chamber: the sarcophagus lid on its plinth, carved panels either side, and
        // the cold braziers below them.
        { id: "temple-tomb", kind: "altar", x: 3245, y: 2020, w: 150, h: 76 },
        { id: "temple-panel-w", kind: "stele", x: 3190, y: 2026, w: 40, h: 64 },
        { id: "temple-panel-e", kind: "stele", x: 3410, y: 2026, w: 40, h: 64 },
        /**
         * The braziers stand at the north arch, not in the sarcophagus row.
         *
         * Two attempts at this and both sealed the room. Below the panels, the row pinched
         * the strip between the tomb and the cross wall to 15 units. Beside them, the row
         * grew to span the chamber's full width with 4- and 15-unit gaps in it and 42 at
         * each end, which cut the north strip off from the south — 17k units² of floor.
         * Third position, and the one that works: paired in the MIDDLE of the north strip.
         * At the chamber's two ends they blocked the only lanes past the sarcophagus row —
         * 20 and 26 units left on the west, 10 and 36 on the east, and a bot needs 48.
         *
         * A room needs ONE bank and a lane, and the bank here is tomb-plus-panels.
         */
        { id: "temple-brazier-w", kind: "brazier", x: 3250, y: 1950, w: 44, h: 44 },
        { id: "temple-brazier-e", kind: "brazier", x: 3346, y: 1950, w: 44, h: 44 },
      ],
      dots: [
        { id: "temple-dot-a", item: { kind: "powerup", type: "incognito" }, x: CX, y: 2130 },
      ],
    },
    {
      label: "ROOF",
      brief: {
        purpose: "The summit: the shrine cell, and the one commanding position over the whole precinct.",
        zones: ["the stair head", "the shrine cell", "the platform ring"],
        sequence: "Off the flight onto the platform, round the cell or straight in through its door.",
        adjacency: "The cell stands clear of the parapet on all four sides so the platform is a ring you can circle, which is what makes holding the summit a matter of position rather than of standing on a spot.",
        negativeSpace: "The platform ring itself. It is the region's whole sightline, and there is exactly one way down.",
      },
      walls: [
        {
          /**
           * The shrine cell: a closed box on the platform with its door facing the stair.
           * Its walls are the reason a summit is worth reaching — the only cover up here.
           */
          id: "temple-shrine",
          thickness: 22,
          closed: true,
          path: [
            { x: 3200, y: 2010 },
            { x: 3440, y: 2010 },
            { x: 3440, y: 2180 },
            { x: 3200, y: 2180 },
          ],
          openings: [{ kind: "door", width: 76, near: { x: CX, y: 2180 } }],
        },
      ],
      objects: [
        { id: "temple-high-altar", kind: "altar", x: 3260, y: 2050, w: 120, h: 60 },
        // On the platform, flanking the stair head and well clear of the cell's back.
        // Hard against the parapet. At 3160/3428 they left 33 units between themselves
        // and the flight — the audit's `blocked-stair-side`, and correctly: a bot leaving
        // the stair head sideways needs 48, and the summit is the one place on the map
        // where being unable to step off a flight is fatal.
        { id: "temple-high-brazier-w", kind: "brazier", x: 3110, y: 2262, w: 52, h: 52 },
        { id: "temple-high-brazier-e", kind: "brazier", x: 3478, y: 2262, w: 52, h: 52 },
      ],
      dots: [
        { id: "temple-dot-b", item: { kind: "powerup", type: "dashOvercharge" }, x: CX, y: 2140 },
        { id: "temple-dot-c", item: { kind: "powerup", type: "health" }, x: 3140, y: 2020 },
      ],
    },
  ],
};

export const greatTemple = compileBuilding(GREAT_TEMPLE_SOURCE);
