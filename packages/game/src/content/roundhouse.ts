import { compileBuilding, type SourceBuilding } from "../mapSource";
import { radial, sectorPoly } from "./regionKit";

/**
 * Fenchurch Roundhouse — the engine shed, and the reason the map format grew a polygon
 * outline in the first place.
 *
 * A roundhouse is a fan of bays round a turntable. That is not a stylistic choice about
 * railways, it is what the building IS: an engine cannot steer, so the only way to put
 * several of them under one roof is to point them all at a table that turns. Which makes
 * it the sharpest available test of the contract's claim that buildings are not boxes,
 * because this one is not merely non-rectangular, it is *annular*, and every door in it
 * sits on a curve.
 *
 * The shed wraps the table's south side so all three bays fire north across the pit.
 * That orientation does work beyond authenticity: it keeps the fan's whole span inside
 * the region, and it means a player standing on the table — which is where the extraction
 * pad is — is being watched from three dark openings at once.
 *
 * ONE FLOOR, deliberately. A drop gallery under the bays was authored and cut: an
 * annulus with no doors in it is reached only by its stair, and the crescent of floor
 * inside the inner arc pinches to nothing between the bays, so the audit found 38k
 * units² of gallery a bot could see and not get to. The yard's stair lives in the signal
 * box, where a small square building can hold one.
 *
 * ONE THING TO KNOW BEFORE MOVING ANYTHING IN HERE. Every coordinate below has to satisfy
 * `263 ≤ r ≤ 477` and `18° ≤ θ ≤ 162°` measured from TABLE, because that is the floor.
 * The first draft of this file placed the workbench, the tool cabinet and the forge by eye
 * along the south edge, and all three were 40–50 units OUTSIDE the shell — a shop end
 * standing in the yard. A curved building has no "south wall" to line furniture up on;
 * it has a band, and the band has to be checked.
 */

/** The turntable's centre. Everything in this building is measured from it. */
export const TABLE = { x: 2960, y: 1230 };
export const TABLE_RADIUS = 165;

const INNER = 255;
const OUTER = 485;
const FROM = Math.PI * 0.1;
const TO = Math.PI * 0.9;

/**
 * Bay centres, on a rhythm along the inner arc, with the last 26° of the fan left for the
 * shop end.
 *
 * Three bays rather than four or five. At `INNER` the fan's arc is 641 units, so four bays
 * leave a 45-unit pier between 130-wide doors and five leave 32 — a shed made of gaps. A
 * pier has to look like it holds a roof up.
 */
const BAY_END = Math.PI * 0.755;
const BAYS = [0, 1, 2].map((i) => FROM + ((BAY_END - FROM) * (i + 0.5)) / 3);

export const ROUNDHOUSE_SOURCE: SourceBuilding = {
  id: "roundhouse",
  kind: "warehouse",
  name: "ROUNDHOUSE",
  shellThickness: 16,
  outline: { shape: "polygon", points: sectorPoly(TABLE, INNER, OUTER, FROM, TO, 16) },
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "Stable, examine and light-repair the engines that work out of the city.",
        zones: ["three engine bays", "the shop end west", "stores in the deep arc between bays"],
        sequence: "Off the table into a bay, examined over the pit, parts fetched from the stores between the bays or made up in the shop end, back out onto the table.",
        adjacency: "Every bay opens onto the turntable and nothing else. Stores sit in the deep part of the arc BETWEEN bays, so a fitter walks along the ends of the engines rather than across them.",
        negativeSpace: "The strip inside the bay doors, the whole width of the shed. It is the only way from any bay to any other, and it is why nothing may run across the arc.",
      },
      shellOpenings: [
        // Three engine doors on the inner arc, each placed by anchor so the compiler works
        // out where on the curve it lands. Authoring these by arc length is exactly what
        // the format exists to make unnecessary.
        ...BAYS.map((angle) => ({
          kind: "rollup" as const,
          width: 130,
          near: radial(TABLE, angle, INNER),
        })),
        // The fitters' door out the back, so the shed is not a dead end when the table is
        // held against you.
        { kind: "door" as const, width: 60, near: radial(TABLE, Math.PI * 0.62, OUTER) },
        // Daylight over the shop end and over the far bay, on the outer wall.
        { kind: "window" as const, width: 92, near: radial(TABLE, Math.PI * 0.82, OUTER) },
        { kind: "window" as const, width: 92, near: radial(TABLE, Math.PI * 0.28, OUTER) },
      ],
      objects: [
        /**
         * The inspection pits, one down each bay, laid as track.
         *
         * `track` is flat and passable, which is right twice over: a pit is a hole a fitter
         * stands in rather than an obstacle, and a rail proud of the floor is not cover for
         * anybody. Each one is proportioned to the direction its own bay runs, so a bay
         * reads as a bay from the doorway.
         */
        { id: "rh-pit-1", kind: "track", x: 3172, y: 1399, w: 130, h: 90 },
        { id: "rh-pit-2", kind: "track", x: 2994, y: 1506, w: 90, h: 130 },
        { id: "rh-pit-3", kind: "track", x: 2760, y: 1489, w: 90, h: 130 },

        /**
         * The shop end, past the last bay, and every piece of it checked against the band.
         *
         * A curved building has no south wall to line a bench up on. The first draft put
         * this row along y 1590-1680 by eye and all of it was 40 units outside the shell —
         * a shop standing in the yard. These sit at r 328..466 and θ 136..157, which is the
         * wedge of floor the fan leaves west of bay 3.
         */
        { id: "rh-bench", kind: "workbench", x: 2600, y: 1430, w: 100, h: 36, facing: "N", scannable: true },
        { id: "rh-tools", kind: "toolCabinet", x: 2620, y: 1396, w: 44, h: 30, facing: "S" },
        { id: "rh-forge", kind: "generator", x: 2618, y: 1476, w: 96, h: 44, facing: "N" },

        /**
         * Stores in the deep part of the arc BETWEEN bays, never across it.
         *
         * The first arrangement ran a shelf, a bench and a tool cabinet from the inner arc
         * to the outer one, which sealed the shed's east end off from the rest of it — the
         * audit found 18k units² of floor nobody could reach. A fan has only one corridor,
         * the strip inside the doors, and everything has to leave it open.
         */
        /**
         * 84 units off the outer arc, not 44.
         *
         * The first position put this bench's east end 44 units from the shell, which is 4
         * short of a bot, and it sealed 18k units² of the shed's east lobe off from the
         * corridor. It read as a defect in the furniture and it was a defect in
         * ARITHMETIC: in an annulus the floor's width at any given y is
         * `2·sqrt(469² − dy²)`, so a bench that clears the wall by a comfortable margin
         * at one end of its run can be 4 units short at the other.
         */
        { id: "rh-shopbench", kind: "workbench", x: 3100, y: 1560, w: 90, h: 36, facing: "N" },
        { id: "rh-vice", kind: "repairBench", x: 2862, y: 1644, w: 90, h: 36, facing: "N" },
        { id: "rh-drum-a", kind: "drum", x: 2900, y: 1520, w: 28, h: 28 },
        { id: "rh-drum-b", kind: "drum", x: 2932, y: 1520, w: 28, h: 28 },
      ],
      dots: [
        { id: "rh-dot-a", item: { kind: "powerup", type: "health" }, x: 2820, y: 1560 },
        { id: "rh-dot-b", item: { kind: "powerup", type: "dashOvercharge" }, x: 3240, y: 1470 },
      ],
    },
  ],
};

export const roundhouse = compileBuilding(ROUNDHOUSE_SOURCE);
