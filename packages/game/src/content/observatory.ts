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
    rect: { x: CX - 150, y: CY - 60, w: 88, h: 120 },
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
     * NO `access: "openEnd"`, and this is the third time that has been settled. A flank wall
     * plus a PER-FLOOR CAP instead — see `observatory-stair-guard` and `-cap` on each floor.
     *
     * What was missing before was only the cap. The flank wall was right: it runs the
     * flight's length on the side the room is on, and the shell closes the other. But neither
     * END was closed, so on F1 you could walk in off the sighting chamber and stand on the
     * half of the flight that belongs to GROUND — "there should be a wall on the floor on the
     * side of the stairs where you shouldn't be able to enter in from."
     *
     * `openEnd` derives that cap correctly and cannot be used here, which was measured
     * rather than assumed: it rails the exit half's two long sides as well, and in a drum
     * 340 across with the flight hard against the shell that costs both stair heads their
     * full-size side exit and strands 10,560 units of F1. Tried it, read the audit, reverted.
     *
     * So the cap is authored, once per floor, because WHICH end needs it differs by floor:
     * on GROUND the exit half is the south one, on F1 the north.
     *
     * 120 LONG, not 160, and the caps are why. The drum is 340 across, so a 160 flight against
     * the shell leaves 53 units at each end — and once an end is capped, 53 minus two bot
     * radii is a 5-unit window nothing can use, which stranded 9,856 units of F1. At 120 the
     * strips are 73 and both stay walkable.
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
      walls: [
        // The flight's open flank. The shell closes its other side.
        {
          id: "observatory-stair-guard",
          thickness: 12,
          path: [{ x: CX - 62, y: CY - 60 }, { x: CX - 62, y: CY + 60 }],
        },
        /**
         * The far cap, at the SOUTH end — this floor's exit half. Without it a bot could
         * walk in off the chamber and stand on the treads that belong to F1.
         */
        {
          id: "observatory-stair-cap",
          thickness: 8,
          path: [{ x: CX - 150, y: CY + 56 }, { x: CX - 56, y: CY + 56 }],
        },
      ],
      objects: [
        // 66 units off the altar, not 62. The aisle rule wants a real one or none.
        { id: "obs-niche-e", kind: "shelf", x: CX + 120, y: CY - 60, w: 28, h: 120 },
        { id: "obs-niche-s", kind: "shelf", x: CX - 60, y: CY + 116, w: 120, h: 28 },
        { id: "obs-altar", kind: "altar", x: CX - 54, y: CY - 26, w: 108, h: 54 },
        { id: "obs-brazier", kind: "brazier", x: CX + 74, y: CY + 78, w: 46, h: 46 },
        { id: "obs-jar", kind: "drum", x: CX - 120, y: CY + 104, w: 30, h: 30 },
      ],
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
      walls: [
        // The flight's open flank, one floor up. A guard on one floor only is a flight you
        // can step onto sideways from the other.
        {
          id: "observatory-stair-guard-f1",
          thickness: 12,
          path: [{ x: CX - 62, y: CY - 60 }, { x: CX - 62, y: CY + 60 }],
        },
        // The far cap, at the NORTH end — this floor's exit half, and the opposite end from
        // the one GROUND caps. That asymmetry is the whole reason a shared wall cannot do it.
        {
          id: "observatory-stair-cap-f1",
          thickness: 8,
          path: [{ x: CX - 150, y: CY - 56 }, { x: CX - 56, y: CY - 56 }],
        },
      ],
      objects: [
        // The gnomon: the pin the whole building is an instrument around.
        { id: "obs-gnomon", kind: "column", x: CX - 22, y: CY - 22, w: 44, h: 44 },
        /**
         * Turned onto the east wall rather than laid across the drum's north.
         *
         * At 92 x 44 across the north it left 48 units between itself and the gnomon — a bot's
         * exact diameter, so zero freedom for its centre — and once the flight's north end was
         * capped that pinch was the only route between F1's north and south halves. 11,392
         * units of the sighting chamber went unreachable. Turned, the gap is 58.
         */
        { id: "obs-table", kind: "draftingTable", x: CX + 80, y: CY - 60, w: 44, h: 92, facing: "W", scannable: true },
        // Flush with the table's west end rather than parked mid-face: the attached-seam
        // allowance is only for a module that extends a bank at its end.
        { id: "obs-stool", kind: "chair", x: CX + 80, y: CY - 88, w: 30, h: 28, facing: "S" },
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
