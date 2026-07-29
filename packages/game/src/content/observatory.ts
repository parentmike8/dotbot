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
    bottom: "S",
    /**
     * NO `openEnd` here, unlike the pavilion's, and the difference is the shell.
     *
     * This flight is hard against the drum's west wall, so one long side is already
     * enclosed by authored geometry — which is exactly the condition `access` says to
     * omit it for. Declaring it anyway walls the exit half's east side too, and with
     * the shell on the west that leaves the flight with no full-size side exit at
     * all: the audit reported both stair heads sealed and a 17,216-unit pocket
     * stranded on F1. A guard rail against a wall is a wall on both sides.
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
      objects: [
        // The gnomon: the pin the whole building is an instrument around.
        { id: "obs-gnomon", kind: "column", x: CX - 22, y: CY - 22, w: 44, h: 44 },
        { id: "obs-table", kind: "draftingTable", x: CX + 70, y: CY - 100, w: 92, h: 44, facing: "S", scannable: true },
        // Flush with the table's west end rather than parked mid-face: the attached-seam
        // allowance is only for a module that extends a bank at its end.
        { id: "obs-stool", kind: "chair", x: CX + 70, y: CY - 54, w: 30, h: 28, facing: "N" },
        { id: "obs-case", kind: "cabinet", x: CX - 130, y: CY + 74, w: 34, h: 30, facing: "N" },
        { id: "obs-stele", kind: "stele", x: CX + 86, y: CY + 66, w: 40, h: 74 },
      ],
      dots: [{ id: "obs-dot-b", item: { kind: "powerup", type: "health" }, x: CX - 78, y: CY - 74 }],
    },
  ],
};

export const observatory = compileBuilding(OBSERVATORY_SOURCE);
