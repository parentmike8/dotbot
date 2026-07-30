import { compileBuilding, type SourceBuilding } from "../mapSource";
import { STANDARD_DOORWAY_CLEAR_WIDTH } from "../doorwayClearance";

/**
 * Lot 6 Depot — warehouse, SW quadrant of Downtown. Footprint 160,1000 700x460.
 *
 * The first production building expressed in map source. It reads the same as it
 * always did — two roll-ups feeding a dock strip, three rack runs on wide picking
 * aisles, workshop SW, dispatch office SE, stair to the cellar NE — but it is now
 * authored the way an LLM or the editor would author it: outer outline, wall
 * centrelines, openings placed by anchor point.
 *
 * `lot6Parity.test.ts` holds a frozen copy of the hand-authored version and proves
 * the two are the same building: same doorways, same walkable space, same
 * reachability, same audit verdict.
 */

const EXT = 12; // exterior wall thickness
const INT = 8; // interior partition thickness
const DOOR = STANDARD_DOORWAY_CLEAR_WIDTH; // full-size DotBot plus steering margin
const ROLLUP = 120; // vehicle door

/**
 * The stair core, as one L from the shell's north face to its east face. Both
 * floors share the shaft, so both restate the enclosure — only the door moves,
 * because the cellar is entered at the south end of the run rather than the north.
 */
function stairCore(doorAt: number) {
  return {
    id: "lot6-core",
    thickness: INT,
    path: [{ x: 752, y: 1012 }, { x: 752, y: 1164 }, { x: 848, y: 1164 }],
    openings: [{ kind: "door" as const, width: DOOR, near: { x: 752, y: doorAt } }],
  };
}

export const LOT6_SOURCE: SourceBuilding = {
  id: "lot6",
  kind: "warehouse",
  name: "LOT 6 DEPOT",
  shellThickness: EXT,
  outline: { shape: "rect", x: 160, y: 1000, w: 700, h: 460 },
  stairs: [{
    id: "lot6-stair",
    rect: { x: 756, y: 1012, w: 88, h: 148 },
    from: "GROUND",
    to: "B1",
    bottom: "S",
  }],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "Take freight off the yard and turn it around through the racking.",
        zones: ["dock strip", "picking aisles", "workshop", "dispatch office", "stair core"],
        sequence: "In through a roll-up, staged on the dock strip, picked from the racks, out the other roll-up.",
        adjacency: "Dispatch overlooks the floor through an interior window; the workshop is off the traffic line.",
        negativeSpace: "The dock strip stays clear end to end so a pallet can be set down anywhere along it.",
      },
      shellOpenings: [
        { kind: "rollup", width: ROLLUP, near: { x: 340, y: 1000 } },
        { kind: "rollup", width: ROLLUP, near: { x: 620, y: 1000 } },
        // Person door into the stair core, beside the second roll-up.
        { kind: "door", width: DOOR, near: { x: 816, y: 1000 } },
        { kind: "window", width: 36, near: { x: 860, y: 1220 } },
        { kind: "window", width: 36, near: { x: 860, y: 1280 } },
        { kind: "window", width: 36, near: { x: 320, y: 1460 } },
        { kind: "window", width: 36, near: { x: 520, y: 1460 } },
        { kind: "window", width: 36, near: { x: 660, y: 1460 } },
        { kind: "window", width: 36, near: { x: 160, y: 1250 } },
        { kind: "window", width: 36, near: { x: 160, y: 1330 } },
      ],
      walls: [
        stairCore(1050),
        {
          id: "lot6-workshop",
          thickness: INT,
          // North face, then down the east face to the south shell.
          path: [{ x: 172, y: 1184 }, { x: 296, y: 1184 }, { x: 296, y: 1448 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 296, y: 1308 } }],
        },
        {
          id: "lot6-dispatch",
          thickness: INT,
          // North face west from the shell, then down the west face.
          path: [{ x: 848, y: 1304 }, { x: 704, y: 1304 }, { x: 704, y: 1448 }],
          openings: [
            { kind: "door", width: DOOR, near: { x: 752, y: 1304 } },
            // The office watches the floor through an interior window.
            { kind: "window", width: 48, near: { x: 812, y: 1304 } },
          ],
        },
      ],
      objects: [
        // Structure aligned with the racking.
        { id: "lot6-column-w", kind: "column", x: 385, y: 1124, w: 16, h: 16 },
        { id: "lot6-column-e", kind: "column", x: 585, y: 1124, w: 16, h: 16 },
        // Dock strip staging.
        { id: "lot6-dock-pallet-a", kind: "pallet", x: 300, y: 1030, w: 48, h: 36 },
        { id: "lot6-dock-pallet-b", kind: "pallet", x: 356, y: 1044, w: 48, h: 36 },
        { id: "lot6-dock-pallet-c", kind: "pallet", x: 580, y: 1036, w: 48, h: 36 },
        // Parked against the west wall so the dock strip stays a clean lane, with
        // the oil point beside it rather than stranded across the floor.
        { id: "lot6-forklift", kind: "forklift", x: 180, y: 1032, w: 44, h: 96, facing: "S", solid: true },
        { id: "lot6-oil-a", kind: "drum", x: 250, y: 1092, w: 24, h: 24 },
        { id: "lot6-oil-b", kind: "drum", x: 250, y: 1124, w: 24, h: 24 },
        // Rack runs with wide aisles.
        { id: "lot6-rack-a", kind: "shelf", x: 380, y: 1160, w: 26, h: 220, scannable: true },
        { id: "lot6-rack-b", kind: "shelf", x: 500, y: 1160, w: 26, h: 220 },
        { id: "lot6-rack-c", kind: "shelf", x: 620, y: 1160, w: 26, h: 220 },
        // Outbound staging, backed onto the stair-core wall and controlled from
        // the dispatch office. The bank is flush end-to-end, leaving a full
        // 66-unit aisle back to the third rack run.
        { id: "lot6-outbound-a", kind: "crateStack", x: 712, y: 1180, w: 34, h: 34 },
        { id: "lot6-outbound-b", kind: "crateStack", x: 752, y: 1180, w: 32, h: 32 },
        { id: "lot6-outbound-pallet", kind: "pallet", x: 790, y: 1178, w: 48, h: 36 },
        // Workshop.
        { id: "lot6-bench", kind: "workbench", x: 180, y: 1200, w: 112, h: 34, facing: "S", scannable: true },
        { id: "lot6-tools", kind: "toolCabinet", x: 180, y: 1402, w: 44, h: 26, scannable: true },
        { id: "lot6-locker-a", kind: "locker", x: 180, y: 1300, w: 26, h: 38 },
        { id: "lot6-locker-b", kind: "locker", x: 180, y: 1342, w: 26, h: 38 },
        { id: "lot6-workshop-crate", kind: "crateStack", x: 246, y: 1408, w: 32, h: 32 },
        // Dispatch office: desk and filing return form one run along the back
        // wall, leaving the door approach and the interior window sightline clear.
        { id: "lot6-desk", kind: "desk", x: 716, y: 1404, w: 90, h: 44, facing: "N" },
        { id: "lot6-filing", kind: "filingCabinet", x: 816, y: 1404, w: 28, h: 44 },
        { id: "lot6-plant", kind: "plant", x: 818, y: 1318, w: 20, h: 20 },
      ],
      dots: [
        { id: "lot6-dot-dock", item: { kind: "powerup", type: "dashOvercharge" }, x: 560, y: 1080 },
        { id: "lot6-dot-aisle", item: { kind: "powerup", type: "health" }, x: 452, y: 1270 },
      ],
    },
    {
      label: "B1",
      brief: {
        purpose: "Plant and bonded cage under the shed, reached only by the stair.",
        zones: ["generator room", "cage storage", "locker wall", "stair core"],
        sequence: "Down the stair, along the cage fronts, back up. The plant room is a dead end.",
        adjacency: "The generator sits behind its own door so the noise never reaches the cage runs.",
        negativeSpace: "The run in front of the cages stays clear for two bots to pass.",
      },
      walls: [
        // Same shaft as GROUND, entered from the cellar at its south end.
        stairCore(1124),
        {
          id: "lot6-plant",
          thickness: INT,
          // East face down from the north shell, then west along the south face.
          path: [{ x: 344, y: 1012 }, { x: 344, y: 1184 }, { x: 172, y: 1184 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 344, y: 1096 } }],
        },
      ],
      objects: [
        // Generator room.
        { id: "lot6-generator", kind: "generator", x: 190, y: 1030, w: 72, h: 52, scannable: true },
        /**
         * Below the switchgear, clear of the plant room's own door.
         *
         * At x 292 the drums stood 17 units from a bot coming through the door in
         * the east wall (y 1068..1124) — they blocked the only way into the room
         * they were stored in. Moving them further east made it worse. They belong
         * on the south wall, out of the entry line entirely.
         */
        { id: "lot6-fuel-a", kind: "drum", x: 190, y: 1148, w: 24, h: 24 },
        { id: "lot6-fuel-b", kind: "drum", x: 218, y: 1148, w: 24, h: 24 },
        { id: "lot6-switchgear", kind: "utilityBox", x: 190, y: 1120, w: 40, h: 22 },
        { id: "lot6-vent", kind: "vent", x: 300, y: 1140, w: 22, h: 22 },
        // Cage storage: three rack runs.
        { id: "lot6-cage-a", kind: "shelf", x: 420, y: 1060, w: 26, h: 220 },
        { id: "lot6-cage-b", kind: "shelf", x: 520, y: 1060, w: 26, h: 220 },
        { id: "lot6-cage-c", kind: "shelf", x: 620, y: 1060, w: 26, h: 220 },
        /**
         * Stacked at the foot of cage run C, not adrift in the east bay.
         *
         * At 700,1320 and 740,1380 these two stood diagonally 40 and 60 units apart in the
         * middle of the basement's open east half, relating to nothing — the only thing on this
         * floor that read as dropped rather than placed. Overflow in a cage store goes at the
         * end of an aisle, where it is still on the run it belongs to and still out of the way.
         */
        { id: "lot6-cage-crate-a", kind: "crateStack", x: 620, y: 1290, w: 34, h: 34 },
        { id: "lot6-cage-crate-b", kind: "crateStack", x: 620, y: 1330, w: 34, h: 34 },
        // Locker wall and maintenance bench along the south.
        { id: "lot6-cellar-locker-a", kind: "locker", x: 420, y: 1400, w: 26, h: 38, scannable: true },
        { id: "lot6-cellar-locker-b", kind: "locker", x: 450, y: 1400, w: 26, h: 38 },
        { id: "lot6-cellar-locker-c", kind: "locker", x: 480, y: 1400, w: 26, h: 38 },
        { id: "lot6-cellar-locker-d", kind: "locker", x: 510, y: 1400, w: 26, h: 38 },
        { id: "lot6-cellar-bench", kind: "workbench", x: 600, y: 1402, w: 110, h: 28, facing: "N" },
      ],
      dots: [
        { id: "lot6-dot-cage", item: { kind: "powerup", type: "dashOvercharge" }, x: 480, y: 1340 },
        { id: "lot6-dot-bond", item: { kind: "powerup", type: "incognito" }, x: 700, y: 1230 },
      ],
    },
  ],
};

export const lot6Depot = compileBuilding(LOT6_SOURCE);
