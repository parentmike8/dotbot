import { compileBuilding, type SourceBuilding, type SourceOpening } from "../mapSource";

/**
 * Mercy Clinic — hospital, NW quadrant of Downtown. Footprint 200,140 620x440.
 *
 * A north band of four clinical rooms — exam, exam, imaging, pharmacy — served by
 * an east-west corridor; the south half is an open waiting hall with reception,
 * the stair core, and a staff room with WC on the east. Ambulance door west into
 * the corridor, main entrance south, staff door east.
 *
 * Migrated from the run helpers in content/downtownLegacy.ts;
 * content/downtownMigration.test.ts holds the proof that nothing moved.
 */

const INT = 8; // interior partition thickness
const DOOR = 56; // single leaf
const DOUBLE = 88; // paired leaf

/** A glazed band on the shell, anchored on the elevation it belongs to. */
function glazing(x: number, y: number, width = 44): SourceOpening {
  return { kind: "window", width, near: { x, y } };
}

export const MERCY_SOURCE: SourceBuilding = {
  id: "mercy",
  kind: "hospital",
  name: "MERCY CLINIC",
  shellThickness: 12,
  outline: { shape: "rect", x: 200, y: 140, w: 620, h: 440 },
  stairs: [{
    id: "mercy-stair",
    rect: { x: 604, y: 400, w: 196, h: 80 },
    from: "GROUND",
    to: "F1",
    bottom: "W",

  }],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "Receive walk-ins and ambulance cases, and treat them in the north band.",
        zones: ["waiting hall", "clinical band", "corridor", "stair core", "staff room"],
        sequence: "In from Main St, past reception, along the corridor, into a room. Ambulances arrive west, straight into the corridor.",
        adjacency: "Reception faces the entrance; pharmacy sits at the far end of the corridor beside the staff door.",
        negativeSpace: "The corridor and the hall floor stay clear — a trolley has to get from the west door to any room.",
      },
      shellOpenings: [
        { kind: "door", width: DOUBLE, near: { x: 460, y: 580 } }, // main entrance from Main St
        { kind: "door", width: DOOR, near: { x: 200, y: 356 } }, // ambulance door into the corridor
        { kind: "door", width: DOOR, near: { x: 820, y: 528 } }, // staff entrance
        // South: waiting hall daylight, either side of the entrance.
        glazing(280, 580), glazing(360, 580), glazing(560, 580),
        // West: exam room and waiting hall.
        glazing(200, 220), glazing(200, 280), glazing(200, 460), glazing(200, 524),
        // North: one per clinical room.
        glazing(290, 140), glazing(450, 140), glazing(600, 140), glazing(742, 140),
        // East: pharmacy.
        glazing(820, 200), glazing(820, 262),
      ],
      walls: [
        {
          id: "mercy-clinical-band",
          thickness: INT,
          // The corridor's north wall, with a door per room.
          path: [{ x: 212, y: 324 }, { x: 808, y: 324 }],
          openings: [
            { kind: "door", width: DOOR, near: { x: 328, y: 324 } }, // exam 1
            { kind: "door", width: DOOR, near: { x: 460, y: 324 } }, // exam 2
            { kind: "door", width: DOOR, near: { x: 600, y: 324 } }, // imaging
            { kind: "door", width: DOOR, near: { x: 740, y: 324 } }, // pharmacy
          ],
        },
        // Partitions between the four clinical rooms.
        { id: "mercy-exam-split-a", thickness: INT, path: [{ x: 376, y: 152 }, { x: 376, y: 320 }] },
        { id: "mercy-exam-split-b", thickness: INT, path: [{ x: 536, y: 152 }, { x: 536, y: 320 }] },
        { id: "mercy-imaging-split", thickness: INT, path: [{ x: 676, y: 152 }, { x: 676, y: 320 }] },
        // Stair core east: corridor wall above, staff band below.
        { id: "mercy-core-north", thickness: INT, path: [{ x: 600, y: 396 }, { x: 808, y: 396 }] },
        { id: "mercy-core-south", thickness: INT, path: [{ x: 600, y: 484 }, { x: 808, y: 484 }] },
        // Staff WC, entered from the hall.
        {
          id: "mercy-wc",
          thickness: INT,
          path: [{ x: 600, y: 488 }, { x: 600, y: 568 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 600, y: 528 } }],
        },
        // Staff room, reachable only through its own exterior door.
        { id: "mercy-staff", thickness: INT, path: [{ x: 720, y: 488 }, { x: 720, y: 568 }] },
      ],
      objects: [
        // Exam 1 (NW): table, worktop, stool.
        { id: "mercy-exam-a-bed", kind: "bed", x: 232, y: 162, w: 48, h: 88, facing: "N", scannable: true },
        { id: "mercy-exam-a-cabinet", kind: "cabinet", x: 216, y: 268, w: 34, h: 22 },
        { id: "mercy-exam-a-sink", kind: "sink", x: 320, y: 158, w: 26, h: 18 },
        /**
         * Beside the worktop, which is where a clinician's stool lives, and not out in
         * the middle of the room.
         *
         * At 322 it left a 42-unit slot between itself and the bed — six short of a
         * bot — so the moment a chair collided, the whole north half of exam 1 was cut
         * off from its own door and the bed had nowhere to put a blueprint. Flush to
         * the cabinet the room is 102 units clear.
         */
        { id: "mercy-exam-a-stool", kind: "chair", x: 250, y: 268, w: 20, h: 20, facing: "E" },
        // Exam 2.
        { id: "mercy-exam-b-bed", kind: "bed", x: 396, y: 162, w: 48, h: 88, facing: "N" },
        { id: "mercy-exam-b-cabinet", kind: "cabinet", x: 384, y: 268, w: 34, h: 22 },
        { id: "mercy-exam-b-sink", kind: "sink", x: 484, y: 158, w: 26, h: 18 },
        // Same fix, same reason: exam 2 sealed its own north-east pocket, which is the
        // 2048 square units the connectivity audit was reporting.
        { id: "mercy-exam-b-stool", kind: "chair", x: 418, y: 268, w: 20, h: 20, facing: "E" },
        // Imaging: scanner table and console.
        { id: "mercy-scanner", kind: "cot", x: 566, y: 170, w: 44, h: 84, facing: "N", scannable: true },
        { id: "mercy-console", kind: "serverRack", x: 632, y: 154, w: 26, h: 56 },
        { id: "mercy-imaging-power", kind: "utilityBox", x: 632, y: 220, w: 26, h: 20 },
        // Pharmacy: shelving runs and dispensing worktop.
        { id: "mercy-pharmacy-shelf-a", kind: "shelf", x: 688, y: 168, w: 24, h: 108, scannable: true },
        // Six units east, so the pharmacy run is a 64-unit work aisle rather than a
        // 58-unit one — wide enough to look like a way between the shelves and too
        // narrow to be one. Read off the plan in the §4.1 pass before the audit was
        // consulted, which is the order that pass exists to enforce.
        { id: "mercy-pharmacy-shelf-b", kind: "shelf", x: 776, y: 168, w: 24, h: 108 },
        { id: "mercy-dispensing", kind: "counter", x: 782, y: 286, w: 24, h: 26 },
        { id: "mercy-pharmacy-fridge", kind: "fridge", x: 682, y: 286, w: 30, h: 30, facing: "E" },
        // Corridor: one crash cart, nothing else — it is a lane.
        { id: "mercy-crash-cart", kind: "medicalCart", x: 770, y: 332, w: 30, h: 22 },
        // Waiting hall: reception faces the entrance; two chair rows west.
        { id: "mercy-reception", kind: "receptionDesk", x: 360, y: 420, w: 140, h: 26, facing: "S", scannable: true },
        { id: "mercy-wait-a", kind: "chair", x: 240, y: 480, w: 22, h: 22, facing: "S" },
        { id: "mercy-wait-b", kind: "chair", x: 286, y: 480, w: 22, h: 22, facing: "S" },
        { id: "mercy-wait-c", kind: "chair", x: 332, y: 480, w: 22, h: 22, facing: "S" },
        /**
         * Back-to-back with the front row, not 18 units behind it.
         *
         * Two rows of seats with an 18-unit slot between them is furniture a bot cannot
         * pass through that looks like it could — the same defect as a false aisle, and
         * invisible to that rule because a 22-unit chair is not a long run. Joined, the
         * six seats read as one bench block, which is what a waiting hall has.
         */
        { id: "mercy-wait-d", kind: "chair", x: 240, y: 502, w: 22, h: 22, facing: "N" },
        { id: "mercy-wait-e", kind: "chair", x: 286, y: 502, w: 22, h: 22, facing: "N" },
        { id: "mercy-wait-f", kind: "chair", x: 332, y: 502, w: 22, h: 22, facing: "N" },
        { id: "mercy-wait-table", kind: "table", x: 232, y: 424, w: 44, h: 32 },
        { id: "mercy-hall-plant-w", kind: "plant", x: 218, y: 544, w: 20, h: 20 },
        { id: "mercy-hall-plant-e", kind: "plant", x: 566, y: 540, w: 20, h: 20 },
        // Staff WC (west room) and staff room (east room).
        { id: "mercy-wc-pan", kind: "toilet", x: 664, y: 530, w: 26, h: 34, facing: "S" },
        // Clear of the WC door's threshold, which reaches to x=614. The basin was
        // clipping it by four units — a fixture standing in its own doorway.
        { id: "mercy-wc-basin", kind: "sink", x: 618, y: 494, w: 24, h: 16 },
        { id: "mercy-staff-locker-a", kind: "locker", x: 728, y: 490, w: 26, h: 38, scannable: true },
        { id: "mercy-staff-locker-b", kind: "locker", x: 728, y: 532, w: 26, h: 36 },
        /**
         * West along the south wall, out of the staff entrance's walking line: the
         * door at 820,528 opens into x 794 and the plant reached to 808.
         *
         * Moved west again, to 700. "Out of the walking line" was measured against the
         * door's own clear width; an ENTRANCE gets a bot's full diameter of approach on
         * both sides, which is the wider rule the octagon's blocked archways bought us,
         * and at 762 this still clipped it.
         */
        { id: "mercy-staff-plant", kind: "plant", x: 700, y: 548, w: 18, h: 18 },
      ],
      dots: [
        { id: "mercy-dot-exam", item: { kind: "powerup", type: "health" }, x: 470, y: 208 },
        { id: "mercy-dot-pharmacy", item: { kind: "powerup", type: "health" }, x: 742, y: 226 },
      ],
    },
    {
      label: "F1",
      brief: {
        purpose: "Recover patients after treatment, watched from one nurse station.",
        zones: ["recovery ward", "nurse station", "supply room", "staff WC", "lounge"],
        sequence: "Up the stair into the lounge, past the nurse station, along the ward bays.",
        adjacency: "The station sits mid-floor so every bay is in view; supplies are behind it, out of the ward.",
        negativeSpace: "The lane either side of the nurse station stays open — it is the only way across the floor.",
      },
      shellOpenings: [
        glazing(280, 580), glazing(340, 580), glazing(520, 580),
        glazing(200, 210), glazing(200, 280), glazing(200, 360), glazing(200, 500),
        glazing(290, 140), glazing(430, 140), glazing(550, 140), glazing(700, 140),
        glazing(820, 200), glazing(820, 270), glazing(820, 528),
      ],
      walls: [
        // Ward bays: privacy partitions off the north wall.
        { id: "mercy-bay-a", thickness: INT, path: [{ x: 354, y: 152 }, { x: 354, y: 268 }] },
        { id: "mercy-bay-b", thickness: INT, path: [{ x: 474, y: 152 }, { x: 474, y: 268 }] },
        { id: "mercy-bay-c", thickness: INT, path: [{ x: 594, y: 152 }, { x: 594, y: 268 }] },
        // Stair core, same shaft as GROUND, entered from the lounge south of it.
        { id: "mercy-core-north", thickness: INT, path: [{ x: 600, y: 396 }, { x: 808, y: 396 }] },
        {
          id: "mercy-core-south",
          thickness: INT,
          path: [{ x: 600, y: 484 }, { x: 808, y: 484 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 768, y: 484 } }],
        },
        // Supply room SW: north face, then down its east face to the shell.
        {
          id: "mercy-supply",
          thickness: INT,
          path: [{ x: 212, y: 434 }, { x: 384, y: 434 }, { x: 384, y: 568 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 350, y: 434 } }],
        },
        // Staff WC beside it, sharing the supply room's east wall.
        {
          id: "mercy-ward-wc",
          thickness: INT,
          path: [{ x: 388, y: 492 }, { x: 472, y: 492 }, { x: 472, y: 568 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 472, y: 530 } }],
        },
      ],
      objects: [
        // Recovery ward: four bays, each bed + bedside unit; IV poles between.
        { id: "mercy-ward-bed-a", kind: "bed", x: 268, y: 162, w: 48, h: 92, facing: "N", scannable: true },
        { id: "mercy-ward-bed-b", kind: "bed", x: 388, y: 162, w: 48, h: 92, facing: "N" },
        { id: "mercy-ward-bed-c", kind: "bed", x: 508, y: 162, w: 48, h: 92, facing: "N" },
        { id: "mercy-ward-bed-d", kind: "bed", x: 628, y: 162, w: 48, h: 92, facing: "N" },
        { id: "mercy-ward-unit-a", kind: "medicalCabinet", x: 230, y: 166, w: 26, h: 20 },
        { id: "mercy-ward-unit-b", kind: "medicalCabinet", x: 444, y: 166, w: 26, h: 20 },
        { id: "mercy-ward-unit-c", kind: "medicalCabinet", x: 564, y: 166, w: 26, h: 20 },
        { id: "mercy-ward-unit-d", kind: "medicalCabinet", x: 684, y: 166, w: 26, h: 20 },
        // Flush against its bed, not parked 12 units off it. A 12-unit slot beside a
        // bed is a gap a bot can see and cannot enter; an IV stand stands at the
        // bedside anyway.
        { id: "mercy-iv-a", kind: "ivStand", x: 316, y: 190, w: 16, h: 16 },
        { id: "mercy-iv-b", kind: "ivStand", x: 676, y: 200, w: 16, h: 16 },
        // Nurse station: counter facing the ward, desk tucked behind. Kept
        // narrow so the lanes on both sides of the station stay walkable.
        { id: "mercy-station-counter", kind: "counter", x: 420, y: 380, w: 110, h: 24, scannable: true },
        { id: "mercy-station-desk", kind: "desk", x: 430, y: 414, w: 72, h: 44, facing: "S" },
        /**
         * East far enough to leave a lane past the nurse station.
         *
         * The counter ends at 530 and the cart stood at 566: a 36-unit gap, against a
         * 48-unit bot. That sealed the whole ward — 67,584 square units of floor cut
         * off from its own arrival route — and the comment above about keeping the
         * lanes walkable was already the intent. A walk-through cart is what let the
         * lane look open while it was not.
         */
        { id: "mercy-ward-cart", kind: "medicalCart", x: 584, y: 388, w: 30, h: 22 },
        // Supply room SW.
        { id: "mercy-supply-shelf-a", kind: "shelf", x: 222, y: 442, w: 24, h: 110 },
        { id: "mercy-supply-shelf-b", kind: "shelf", x: 262, y: 540, w: 90, h: 24 },
        { id: "mercy-supply-crate", kind: "crateStack", x: 300, y: 528, w: 34, h: 34 },
        // Staff WC.
        { id: "mercy-ward-wc-pan", kind: "toilet", x: 398, y: 532, w: 26, h: 34, facing: "S" },
        { id: "mercy-ward-wc-basin", kind: "sink", x: 396, y: 496, w: 24, h: 16 },
        // Lounge SE below the stair: soft corner, no solid blockers — this is
        // the only route between the stair door and the open floor.
        { id: "mercy-lounge-rug", kind: "rug", x: 640, y: 502, w: 110, h: 58 },
        { id: "mercy-lounge-chair-a", kind: "chair", x: 656, y: 516, w: 22, h: 22, facing: "E" },
        { id: "mercy-lounge-chair-b", kind: "chair", x: 712, y: 516, w: 22, h: 22, facing: "W" },
        { id: "mercy-lounge-plant", kind: "plant", x: 780, y: 544, w: 20, h: 20 },
      ],
      dots: [
        { id: "mercy-dot-ward-w", item: { kind: "powerup", type: "health" }, x: 330, y: 300 },
        { id: "mercy-dot-ward-e", item: { kind: "powerup", type: "health" }, x: 570, y: 300 },
        { id: "mercy-dot-supply", item: { kind: "powerup", type: "incognito" }, x: 300, y: 500 },
      ],
    },
  ],
};

export const mercyClinic = compileBuilding(MERCY_SOURCE);
