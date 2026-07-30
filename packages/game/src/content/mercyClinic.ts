import { compileBuilding, type SourceBuilding, type SourceOpening } from "../mapSource";
import { STANDARD_DOORWAY_CLEAR_WIDTH } from "../doorwayClearance";

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
const DOOR = STANDARD_DOORWAY_CLEAR_WIDTH; // full-size DotBot plus one steering cell per side
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
        /**
         * Exam 1 (NW): table on the west wall, worktop run along the north wall.
         *
         * The worktop, the sink and the stool used to be three unrelated objects — the
         * cabinet in the south-west corner, the sink diagonally opposite it on the north
         * wall, and the stool flush against the cabinet. Nobody washes their hands at one
         * end of a room and writes at the other, and the probe found the consequence: no
         * bot could stand beside the cabinet at all, because the bed boxed it in from the
         * north and the corridor wall from the south. A worktop you cannot reach with a
         * sink nowhere near it is two mistakes making each other invisible.
         *
         * Now they are one installation on one wall, in the order a clinician uses them:
         * worktop, sink at its end, stool tucked under. Walk in from the corridor and the
         * whole working side of the room is in front of you, with the table to the left.
         */
        /**
         * Order along the run matters, and getting it wrong once proved why. The first
         * attempt put the sink at the east end with the stool directly beneath it, against
         * the partition — which walled the sink in on all four sides and stranded it exactly
         * as the cabinet had been stranded before. Sink first, then worktop, then the stool
         * tucked at the worktop's far end: every piece keeps open floor to the south, and
         * the stool sits at a run END, where an attached seam is what the contract wants.
         */
        { id: "mercy-exam-a-bed", kind: "bed", x: 216, y: 162, w: 48, h: 88, facing: "N", scannable: true },
        { id: "mercy-exam-a-sink", kind: "sink", x: 292, y: 154, w: 24, h: 16 },
        { id: "mercy-exam-a-cabinet", kind: "cabinet", x: 318, y: 154, w: 54, h: 22 },
        { id: "mercy-exam-a-stool", kind: "chair", x: 352, y: 178, w: 20, h: 20, facing: "N" },
        // Exam 2: the same room, because a clinic's exam rooms ARE the same room. What
        // was wrong here was never the repetition — it was the layout being repeated.
        { id: "mercy-exam-b-bed", kind: "bed", x: 384, y: 162, w: 48, h: 88, facing: "N" },
        { id: "mercy-exam-b-sink", kind: "sink", x: 452, y: 154, w: 24, h: 16 },
        { id: "mercy-exam-b-cabinet", kind: "cabinet", x: 478, y: 154, w: 54, h: 22 },
        { id: "mercy-exam-b-stool", kind: "chair", x: 512, y: 178, w: 20, h: 20, facing: "N" },
        /**
         * Imaging: scanner table west, control console on the east wall at its head.
         *
         * The console was 14 units off the partition it was meant to be against, in a
         * 36-unit slot beside the scanner — out of reach, like exam 1's worktop. Facing
         * the scanner across the room is not an option either: a 132-wide room cannot
         * hold a 44-wide table and a 26-wide console with a comfortable aisle between
         * them, and the false-aisle rule is right to say so. So the console goes where a
         * radiographer's console actually goes, against the wall by the patient's head,
         * short enough that it does not become a second wall down the room.
         */
        { id: "mercy-scanner", kind: "cot", x: 552, y: 168, w: 44, h: 84, facing: "N", scannable: true },
        { id: "mercy-console", kind: "serverRack", x: 646, y: 154, w: 26, h: 36 },
        { id: "mercy-imaging-power", kind: "utilityBox", x: 646, y: 196, w: 26, h: 20 },
        /**
         * Pharmacy: shelving on both side walls, dispensing worktop facing the door.
         *
         * Both shelf runs go flush to their walls, which widens the work aisle between
         * them from 64 to 72, and the dispensing counter moves out of the south-east
         * corner onto the north wall — where it faces the door, which is the whole job of
         * a dispensing counter. In the corner it faced a wall and was the last thing you
         * would find in the room.
         *
         * The fridge goes to the NORTH-west corner, beside the dispensing counter, and not
         * the south-west one. In the south-west it reached x=714 and the pharmacy door's
         * walking line starts at 712 — a fridge two units into its own doorway, which the
         * doorway rule caught and which is the third time this pass that "tuck it in the
         * corner" has meant "put it where somebody has to walk". Cold stock beside the
         * dispensing point is also just where it belongs.
         */
        { id: "mercy-pharmacy-fridge", kind: "fridge", x: 684, y: 154, w: 30, h: 30, facing: "E" },
        { id: "mercy-dispensing", kind: "counter", x: 716, y: 154, w: 56, h: 24 },
        { id: "mercy-pharmacy-shelf-a", kind: "shelf", x: 684, y: 190, w: 24, h: 108, scannable: true },
        { id: "mercy-pharmacy-shelf-b", kind: "shelf", x: 780, y: 168, w: 24, h: 108 },
        // Corridor: one crash cart, east of the pharmacy door's full-size threshold.
        { id: "mercy-crash-cart", kind: "medicalCart", x: 774, y: 332, w: 30, h: 22 },
        /**
         * Waiting hall: reception beside the entrance's walking line, seating in an L.
         *
         * Three things were wrong and they were one thing. The desk sat centred on the
         * main entrance, so the only way from the door to the corridor was to squeeze
         * round its east end. The six chairs were welded into one 114 x 44 block in the
         * south-west corner with 28 units to the west wall and 44 to the south — dead on
         * two sides, and three of the six seats had no floor a bot could stand on beside
         * them. And a 44 x 32 table floated in the open 24 units north-west of the block,
         * belonging to nothing. Meanwhile the hall's whole east half was empty.
         *
         * All three come from filling a corner instead of composing a room. So: the desk
         * slides west until its east end is exactly the entrance's west jamb, which keeps
         * the walk from door to corridor dead straight; it gets a chair and a filing
         * cabinet behind it so it reads as somewhere a person works rather than a bar
         * across the floor; and the seating becomes two benches in an L along the west and
         * south walls with a table in the crook, every seat approachable from the open
         * side. Fewer objects, more floor, and a hall you can read on the way in.
         *
         * The desk is 110 wide, and two rounds of the probe say why. At 140 it reached back
         * to x=276 and left a 40-unit choke between its west end and the seating bench,
         * which sealed a 16 x 72 strip of hall — and sealed the pocket just inside the
         * AMBULANCE door, the one route in this building that has to stay open. Then the
         * filing cabinet's back at y=374 left 46 units of corridor in front of the four room
         * doors, two short of a bot, and that single pinch cut exam 1 AND the whole west half
         * of the hall off from the rest of the building. The workstation now stands 56 clear
         * of the clinical band. The expensive mistakes on this floor are two units wide.
         */
        { id: "mercy-reception", kind: "receptionDesk", x: 306, y: 410, w: 110, h: 26, facing: "S", scannable: true },
        // Cabinet at one end of the counter, the seat at the other. Mid-run the chair was a
        // small fixture parked 4 units off the face of a 110-unit desk, which is the
        // `wedged-fixture` shape exactly — and this time the rule was right: there is no
        // wall between a desk and its own chair.
        { id: "mercy-reception-file", kind: "filingCabinet", x: 306, y: 382, w: 26, h: 24 },
        { id: "mercy-reception-chair", kind: "chair", x: 394, y: 384, w: 22, h: 22, facing: "S" },
        // Below the ambulance door's approach, which owns the west wall down to y=384.
        { id: "mercy-wait-bench-w", kind: "bench", x: 214, y: 432, w: 22, h: 124, facing: "E" },
        // Stops at 368, a bot's full diameter clear of the main entrance's west jamb.
        { id: "mercy-wait-bench-s", kind: "bench", x: 244, y: 546, w: 124, h: 22, facing: "N" },
        // 64 clear of the west bench rather than parked 14 units off its face: a small
        // fixture that close to the middle of a long run reads as neither joined nor
        // passable, which is exactly what `wedged-fixture` is for.
        { id: "mercy-wait-table", kind: "table", x: 300, y: 470, w: 44, h: 40 },
        /**
         * At the reception counter's east end, where a plant in a foyer goes.
         *
         * At 566,540 it had been standing 23 units off the WC door's threshold for as long
         * as street furniture has been solid, and it was the reason that WC read as an
         * island in the probe — not the fixtures inside it, which is where I looked first.
         * It cannot go in the corridor either: the corridor is 68 deep and a 20-unit pot in
         * the middle of it leaves 36, so the clinic's one artery would be blocked by a
         * houseplant. Parked in the open hall it just drew the eye to how empty the east
         * half is; the east half SHOULD be empty, because that is the trolley route the
         * floor brief reserves. So it goes where it terminates something.
         */
        { id: "mercy-hall-plant-e", kind: "plant", x: 424, y: 410, w: 20, h: 20 },
        /**
         * Staff WC (west room) and staff room (east room).
         *
         * Both fixtures move to the far end. The pan stood 4 units inside the door's own
         * swing at x=664 and the basin faced it across the entry, so the only standable
         * spot in the room was a 320-unit sliver cut off from the hall — a WC nobody could
         * use, which the probe found as an island and the eye finds as a fixture in a
         * doorway. Against the east wall the room has its whole width as approach.
         */
        { id: "mercy-wc-pan", kind: "toilet", x: 686, y: 528, w: 26, h: 34, facing: "S" },
        { id: "mercy-wc-basin", kind: "sink", x: 690, y: 494, w: 24, h: 16 },
        { id: "mercy-staff-locker-a", kind: "locker", x: 728, y: 490, w: 26, h: 38, scannable: true },
        { id: "mercy-staff-locker-b", kind: "locker", x: 728, y: 532, w: 26, h: 36 },
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
          // Standard again: the compiler-wide doorway rule replaces the temporary
          // paired-leaf workaround that was needed when a person door was only 56 clear.
          openings: [{ kind: "door", width: DOOR, near: { x: 750, y: 484 } }],
        },
        /**
         * The shaft's west end is closed on F1, and this is task #76.
         *
         * The flight runs west-to-east with its bottom at the west, so on GROUND the west
         * end is where you step on and the core is correctly open to the corridor there.
         * F1 inherited that opening and it is the wrong end upstairs: west is the EXIT half
         * on this floor, so walking in from the ward put you on the far half of the flight
         * from the room, which drops you a storey you did not ask for. That is the
         * `mercy:F1: mercy-stair-down can be walked onto from the wrong side` line in the
         * ledger, and it was the only entry in it.
         *
         * Sealing this end leaves the south door at 768 as the one way in, which lands you
         * in the entry half — so the flight is entered from the bottom going up and from
         * the top going down, and never side-on. The wall's east face lands exactly on the
         * shaft's west edge at x=604, so it closes the opening without narrowing the run.
         */
        { id: "mercy-core-west", thickness: INT, path: [{ x: 600, y: 396 }, { x: 600, y: 484 }] },
        // Supply room SW: north face, then down its east face to the shell.
        {
          id: "mercy-supply",
          thickness: INT,
          path: [{ x: 212, y: 434 }, { x: 384, y: 434 }, { x: 384, y: 568 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 348, y: 434 } }],
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
        /**
         * Recovery ward: four bays laid out the same way, because a ward IS four of the
         * same bay. The repetition was never the problem — the inconsistency was.
         *
         * Bay A had its bedside unit on the WEST of the bed and B, C and D on the east,
         * which reads as three decisions and one accident. Worse, B and C wedged their unit
         * into the 8-unit slot between the bed and the bay partition, so in two of the four
         * bays nobody could stand beside the thing the bed is served from. Bay A's IV stand
         * was in the same trap on the other side.
         *
         * Now every bay is bed flush to its west partition, unit against the bed's east
         * side, and the rest of the bay's width is the approach — which is what the width
         * is for. The IV stands are gone rather than made consistent: two of four beds had
         * one, both were 16-unit decorations jammed into the leftover gap, and B and C are
         * 112 units wide, which does not hold a bed, a unit, a pole and a body.
         */
        { id: "mercy-ward-bed-a", kind: "bed", x: 216, y: 162, w: 48, h: 92, facing: "N", scannable: true },
        { id: "mercy-ward-bed-b", kind: "bed", x: 362, y: 162, w: 48, h: 92, facing: "N" },
        { id: "mercy-ward-bed-c", kind: "bed", x: 482, y: 162, w: 48, h: 92, facing: "N" },
        { id: "mercy-ward-bed-d", kind: "bed", x: 602, y: 162, w: 48, h: 92, facing: "N" },
        { id: "mercy-ward-unit-a", kind: "medicalCabinet", x: 266, y: 166, w: 26, h: 20 },
        { id: "mercy-ward-unit-b", kind: "medicalCabinet", x: 412, y: 166, w: 26, h: 20 },
        { id: "mercy-ward-unit-c", kind: "medicalCabinet", x: 532, y: 166, w: 26, h: 20 },
        { id: "mercy-ward-unit-d", kind: "medicalCabinet", x: 652, y: 166, w: 26, h: 20 },
        /**
         * Nurse station: counter facing the ward, desk behind it, chair at the desk.
         *
         * The desk faced SOUTH — away from the ward, over the empty floor — while this
         * floor's brief says the station "sits mid-floor so every bay is in view". A desk
         * whose whole reason to exist is the sightline north was pointed at the back wall.
         * It faces north now, over its own counter, and it has a chair at the west end so
         * the station reads as a post somebody keeps rather than two bars on the floor.
         * The chair sits flush to the desk's end on purpose: a small fixture a few units
         * off the middle of a longer run is the `wedged-fixture` shape.
         */
        { id: "mercy-station-counter", kind: "counter", x: 420, y: 380, w: 110, h: 24, scannable: true },
        { id: "mercy-station-desk", kind: "desk", x: 430, y: 414, w: 72, h: 44, facing: "N" },
        // At the desk's EAST end. At the west end it landed in the 34-unit band between the
        // desk and the supply-room and WC walls, where no bot can stand — so the chair was
        // unreachable for a reason that had nothing to do with the chair.
        { id: "mercy-station-chair", kind: "chair", x: 480, y: 460, w: 22, h: 22, facing: "N" },
        /**
         * East far enough to leave a lane past the nurse station.
         *
         * The counter ends at 530 and the cart stood at 566: a 36-unit gap, against a
         * 48-unit bot. That sealed the whole ward — 67,584 square units of floor cut
         * off from its own arrival route — and the comment above about keeping the
         * lanes walkable was already the intent. A walk-through cart is what let the
         * lane look open while it was not.
         */
        /**
         * North of the core wall, not astride it. At y=388 this cart straddled the stair
         * core's north partition — 4 units of it in the ward and the rest inside the shaft —
         * and `solid-overlap` cannot see it, because that rule only compares object to
         * object (`left.ownerKind === "object" && right.ownerKind === "object"`). It took
         * zooming in on the render to notice a trolley with a wall through it.
         */
        { id: "mercy-ward-cart", kind: "medicalCart", x: 584, y: 366, w: 30, h: 22 },
        /**
         * Supply room SW: shelving on the west and south walls, crates in the corner.
         *
         * The crate stack overlapped the south shelf run by 34 x 22 — two solids in the
         * same place, and the single entry in Mercy's recorded floor-quality debt. Both
         * runs now go flush to their walls and the crates sit east of the shelf with a
         * seam, so the room reads as a corner stacked to the walls with its floor free.
         */
        { id: "mercy-supply-shelf-a", kind: "shelf", x: 214, y: 442, w: 24, h: 110 },
        { id: "mercy-supply-shelf-b", kind: "shelf", x: 244, y: 544, w: 90, h: 24 },
        { id: "mercy-supply-crate", kind: "crateStack", x: 340, y: 530, w: 34, h: 34 },
        /**
         * Staff WC. Both fixtures west, because the door is east and the room is 80 x 72 —
         * which after a bot's 24 of standoff from four walls leaves one standable band
         * through the middle. The basin used to sit in that band's north edge with the pan
         * across from it, so it could be looked at and not reached.
         */
        { id: "mercy-ward-wc-pan", kind: "toilet", x: 390, y: 538, w: 34, h: 30, facing: "S" },
        { id: "mercy-ward-wc-basin", kind: "sink", x: 390, y: 498, w: 24, h: 16 },
        /**
         * Lounge SE below the stair: soft corner, no solid blockers — this is
         * the only route between the stair door and the open floor.
         *
         * The two chairs faced each other across a bare rug with nothing between them,
         * which reads as two chairs that happen to be near each other. A side table
         * between them is what makes it a place someone sits.
         *
         * Two wrong answers before this one, and both were the same mistake in different
         * places. This band is 72 deep. Anything standing in the middle of it leaves 20
         * north and 30 south, so the first attempt's table could be seen and not touched.
         * Moving the row up against the core wall then left 54 units to the south wall —
         * enough for a bot to FIT and not enough for the navigator to thread, which turned
         * the group into a wall across the one route between the stair door and the floor.
         *
         * So the group goes into the SOUTH-EAST CORNER and stops being a row across
         * anything. The band's whole west reach stays open as the route, the seats have 48
         * units of approach in front of them, and the rug lies under the group instead of
         * out in the traffic.
         */
        { id: "mercy-lounge-rug", kind: "rug", x: 688, y: 512, w: 120, h: 56 },
        { id: "mercy-lounge-chair-a", kind: "chair", x: 700, y: 544, w: 22, h: 22, facing: "N" },
        { id: "mercy-lounge-table", kind: "table", x: 726, y: 544, w: 26, h: 22 },
        { id: "mercy-lounge-chair-b", kind: "chair", x: 756, y: 544, w: 22, h: 22, facing: "N" },
        { id: "mercy-lounge-plant", kind: "plant", x: 784, y: 544, w: 20, h: 20 },
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
