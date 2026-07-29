import { compileBuilding, type SourceBuilding } from "../mapSource";

/**
 * THE OBSERVATORY — a round tower on the plaza's south-east corner.
 *
 * Round, because that is the one form a strict overhead camera cannot flatten. A
 * rectilinear building seen from directly above is a rectangle whatever else is true
 * about it; a drum is unmistakably a drum, and in a region whose whole subject is
 * masonry that is worth a building on its own.
 *
 * It also answers a question the pyramid does not. The pyramid is a mass you climb the
 * outside of. This is a room you are inside, with a spiral of a plan and sight lines
 * that only work through the four sighting slots — so the two enterable buildings in
 * this region are opposites, and neither is the other one again.
 */

export const OBSERVATORY = { x: 3700, y: 2760, r: 200 };
const CX = OBSERVATORY.x;
const CY = OBSERVATORY.y;
const R = OBSERVATORY.r;

export const OBSERVATORY_SOURCE: SourceBuilding = {
  id: "observatory",
  kind: "monument",
  name: "OBSERVATORY",
  shellThickness: 30,
  outline: { shape: "circle", x: CX, y: CY, r: R, steps: 30 },
  stairs: [{
    /**
     * The stair up, hard against the shell on the west side, so the round floor's
     * middle stays open. A stair in the centre of a drum would divide the one room
     * the building has.
     */
    id: "observatory-stair",
    rect: { x: CX - 150, y: CY - 80, w: 88, h: 160 },
    from: "GROUND",
    to: "F1",
    /**
     * Entered from the NORTH, which is where the door is.
     *
     * It was `"S"`, so you came off the drum's only door, walked the length of the
     * room, and turned back on yourself to climb. Reported from play, and correct:
     * "the entry of the stairs should probably face the door." A stair's open end is
     * the one piece of a building whose orientation is decided for it by the way in.
     *
     * Turning it also made the guards work. With the entry south, `openEnd` walled
     * the NORTH half — the half against the door — and with the shell close on the
     * west that left the flight no full-size side exit at all: the audit reported
     * both stair heads sealed and a 17,216-unit pocket stranded on F1. Entered from
     * the north, the guards fall on the south half and the room stays open.
     */
    bottom: "N",
    /**
     * NO `access: "openEnd"`, because an authored wall does the job instead — see
     * `observatory-stair-guard` on both floors.
     *
     * Derived guards wall the exit half on both long sides plus its far cap, and this
     * drum is 200 across with the flight hard against its shell. Whichever way the
     * flight is turned, that seals it: entered from the south the audit reported both
     * stair heads blocked and 17,216 units stranded on F1, and entered from the north
     * it reported the same thing 6,000 units smaller. A guard rail against a wall is a
     * wall on both sides, and a round room this size has no third side to spare.
     *
     * One wall down the open flank is what every stair in the city actually is, and it
     * leaves both ends of the flight open, which is what a stair needs.
     */
  }],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "The lower chamber: where the readings were kept and the offerings made.",
        zones: ["the entrance bay north", "the record niches round the wall", "the stair well west"],
        sequence: "In from the plaza on the north, round the wall past the niches, up the stair.",
        adjacency: "Niches are all wall-backed, because a niche IS a wall — and it means the middle of the room stays the room.",
        negativeSpace: "The centre of the floor, which is where the sighting shaft comes down and where a fight in here happens.",
      },
      shellOpenings: [
        { kind: "door", width: 84, near: { x: CX, y: CY - R } },
        { kind: "window", width: 60, near: { x: CX + R, y: CY + 40 } },
      ],
      objects: [
        // 66 units off the altar, not 62. The aisle rule wants a real one or none.
        { id: "obs-niche-e", kind: "shelf", x: CX + 120, y: CY - 60, w: 28, h: 120 },
        { id: "obs-niche-s", kind: "shelf", x: CX - 60, y: CY + 116, w: 120, h: 28 },
        { id: "obs-altar", kind: "altar", x: CX - 54, y: CY - 26, w: 108, h: 54 },
        { id: "obs-brazier", kind: "brazier", x: CX + 74, y: CY + 78, w: 46, h: 46 },
        { id: "obs-jar", kind: "drum", x: CX - 120, y: CY + 104, w: 30, h: 30 },
      ],
      walls: [{
        // The stair's open flank, so you cannot step onto the flight sideways from the
        // room. The shell closes its other side. See the note on the stair.
        id: "observatory-stair-guard",
        thickness: 12,
        path: [{ x: CX - 62, y: CY - 80 }, { x: CX - 62, y: CY + 80 }],
      }],
      dots: [{ id: "obs-dot-a", item: { kind: "powerup", type: "radar" }, x: CX + 40, y: CY + 60 }],
    },
    {
      label: "F1",
      brief: {
        purpose: "The sighting chamber: four slots cut on the bearings that mattered.",
        zones: ["the sighting slots on the cardinals", "the gnomon at the centre", "the stair head"],
        sequence: "Up the stair, round the drum from slot to slot, reading each bearing off the gnomon.",
        adjacency: "The gnomon must be dead centre or every slot lies; nothing else may stand near it.",
        negativeSpace: "The whole ring of floor, deliberately. It is the only room in the region with a view out of it in four directions and no cover in any of them.",
      },
      shellOpenings: [
        // Four slots on the cardinals. Narrow, because a sighting slot is narrow — and
        // because a `window` glazes the wall without cutting it, so these give the room
        // its light and its sight lines without giving it a fifth way in.
        { kind: "window", width: 54, near: { x: CX, y: CY - R } },
        { kind: "window", width: 54, near: { x: CX, y: CY + R } },
        { kind: "window", width: 54, near: { x: CX - R, y: CY } },
        { kind: "window", width: 54, near: { x: CX + R, y: CY } },
      ],
      walls: [{
        // The stair's open flank. See the note on the stair itself for why this is an
        // authored wall rather than a derived guard.
        id: "observatory-stair-guard-f1",
        thickness: 12,
        path: [{ x: CX - 62, y: CY - 80 }, { x: CX - 62, y: CY + 80 }],
      }],
      objects: [
        // The gnomon: the pin the whole building is an instrument around.
        { id: "obs-gnomon", kind: "column", x: CX - 22, y: CY - 22, w: 44, h: 44 },
        { id: "obs-table", kind: "draftingTable", x: CX + 70, y: CY - 100, w: 92, h: 44, facing: "S", scannable: true },
        // Flush with the table's west end rather than parked mid-face: the attached-seam
        // allowance is only for a module that extends a bank at its end.
        { id: "obs-stool", kind: "chair", x: CX + 70, y: CY - 54, w: 30, h: 28, facing: "N" },
        /**
         * `obs-case`, a cabinet, is GONE rather than moved.
         *
         * It stood at (CX - 130, CY + 74) — squarely in the stair's south end, which is
         * the end you arrive at on F1 — so 16,704 units of chamber, the whole east half,
         * was cut off from its own arrival route by a cabinet. Moved north of the flight
         * it pinched a 6,016-unit pocket against the gnomon instead.
         *
         * Which is the room telling us something. This floor is a 170-radius drum whose
         * brief reserves "the whole ring of floor, deliberately", and it was carrying
         * five fixtures plus a stair. Four is what it holds.
         */
        { id: "obs-stele", kind: "stele", x: CX + 86, y: CY + 66, w: 40, h: 74 },
      ],
      // Was at (CX - 78, CY - 74), which is INSIDE the stair rect — a Dot on the
      // flight itself. It went unreported while the flight had no guards, because the
      // audit could still flood into it from the side.
      dots: [{ id: "obs-dot-b", item: { kind: "powerup", type: "health" }, x: CX - 20, y: CY + 96 }],
    },
  ],
};

export const observatory = compileBuilding(OBSERVATORY_SOURCE);
