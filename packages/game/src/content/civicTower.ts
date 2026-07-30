import { compileBuilding, type SourceBuilding, type SourceObject, type SourceOpening, type SourceWall } from "../mapSource";

/**
 * Civic Tower — office, NE quadrant of Downtown. Footprint 1480,120 560x420.
 *
 * Eight occupied floors plus a walkable roof. Two scissor-stair shafts sit on the
 * north wall with a WC stack between them, so climbing the tower means crossing
 * every floor. A pair of structural columns marks the open plan.
 *
 * Migrated from the run helpers in content/downtownLegacy.ts;
 * content/downtownMigration.test.ts holds the proof that nothing moved.
 */

const INT = 8;
const DOOR = 56;
const DOUBLE = 88;

const STAIR_A = { x: 1492, y: 132, w: 88, h: 160 }; // NW shaft
const STAIR_B = { x: 1940, y: 132, w: 88, h: 160 }; // NE shaft
const UP_DOOR = 264; // door on the south half of a shaft run
const DOWN_DOOR = 168; // door on the north half

function glazing(x: number, y: number, width = 44): SourceOpening {
  return { kind: "window", width, near: { x, y } };
}

/** The NW shaft: down its east face, then west along its south face. */
function coreA(doorY: number): SourceWall {
  return {
    id: "civic-core-a",
    thickness: INT,
    path: [{ x: 1584, y: 132 }, { x: 1584, y: 296 }, { x: 1492, y: 296 }],
    openings: [{ kind: "door", width: DOOR, near: { x: 1584, y: doorY } }],
  };
}

/** The NE shaft: down its west face, then east along its south face. */
function coreB(doorY: number): SourceWall {
  return {
    id: "civic-core-b",
    thickness: INT,
    path: [{ x: 1936, y: 132 }, { x: 1936, y: 296 }, { x: 2028, y: 296 }],
    openings: [{ kind: "door", width: DOOR, near: { x: 1936, y: doorY } }],
  };
}

/** The WC stack between the shafts: two rooms entered from the south. */
function wcBlock(): SourceWall[] {
  return [
    { id: "civic-wc-split-w", thickness: INT, path: [{ x: 1704, y: 132 }, { x: 1704, y: 252 }] },
    { id: "civic-wc-split-m", thickness: INT, path: [{ x: 1784, y: 132 }, { x: 1784, y: 252 }] },
    { id: "civic-wc-split-e", thickness: INT, path: [{ x: 1864, y: 132 }, { x: 1864, y: 252 }] },
    {
      id: "civic-wc-front",
      thickness: INT,
      path: [{ x: 1704, y: 256 }, { x: 1864, y: 256 }],
      openings: [
        { kind: "door", width: DOOR, near: { x: 1752, y: 256 } },
        { kind: "door", width: DOOR, near: { x: 1832, y: 256 } },
      ],
    },
  ];
}

/**
 * One function, nine floors, and until now one defect repeated eighteen times.
 *
 * Each WC is 72 wide and 120 deep, so after a bot's 24 of standoff from four walls the
 * only standable ground in it is a 24-wide band down the middle, and the pan against the
 * north wall pushes the south end of that band to y=198. The basins were 16 deep, ending
 * at y=158 — forty units from the nearest place a bot can stand, against a reach of about
 * thirty. Every floor of the tower had two basins you could see and never touch.
 *
 * The fix is depth, not position: a 32-deep vanity ends flush with the pan at y=174, which
 * is 24 from the band and within reach. It also reads better, because a basin and a pan
 * that line up are a fitted run rather than two objects that happen to share a wall.
 *
 * This is why the generator is the thing to fix. The alternative was eighteen edits and
 * eighteen chances to get one of them wrong.
 */
function wcFixtures(floor: string): SourceObject[] {
  return [
    { id: `civic-${floor}-wc-pan-w`, kind: "toilet", x: 1712, y: 140, w: 26, h: 34, facing: "N" },
    { id: `civic-${floor}-wc-basin-w`, kind: "sink", x: 1744, y: 142, w: 22, h: 32 },
    { id: `civic-${floor}-wc-pan-e`, kind: "toilet", x: 1822, y: 140, w: 26, h: 34, facing: "N" },
    { id: `civic-${floor}-wc-basin-e`, kind: "sink", x: 1794, y: 142, w: 22, h: 32 },
  ];
}

/** Facade glazing shared by the upper floors. */
function upperGlazing(): SourceOpening[] {
  return [
    glazing(1480, 190), glazing(1480, 250), glazing(1480, 340), glazing(1480, 420), glazing(1480, 480),
    glazing(1620, 120), glazing(1680, 120), glazing(1900, 120),
    glazing(1550, 540), glazing(1630, 540), glazing(1710, 540),
    glazing(1790, 540), glazing(1870, 540), glazing(1950, 540),
    glazing(2040, 180), glazing(2040, 240), glazing(2040, 320), glazing(2040, 400), glazing(2040, 480),
  ];
}

export const CIVIC_SOURCE: SourceBuilding = {
  id: "civic",
  kind: "office",
  name: "CIVIC TOWER",
  shellThickness: 12,
  outline: { shape: "rect", x: 1480, y: 120, w: 560, h: 420 },
  /**
   * Scissor stairs: the shaft alternates every floor, so climbing the tower
   * means crossing the whole plate each time rather than riding one corner up.
   */
  stairs: [
    { id: "civic-stair-g", rect: STAIR_A, from: "GROUND", to: "F1", bottom: "S" },
    { id: "civic-stair-1", rect: STAIR_B, from: "F1", to: "F2", bottom: "S" },
    { id: "civic-stair-2", rect: STAIR_A, from: "F2", to: "F3", bottom: "S" },
    { id: "civic-stair-3", rect: STAIR_B, from: "F3", to: "F4", bottom: "S" },
    { id: "civic-stair-4", rect: STAIR_A, from: "F4", to: "F5", bottom: "S" },
    { id: "civic-stair-5", rect: STAIR_B, from: "F5", to: "F6", bottom: "S" },
    { id: "civic-stair-6", rect: STAIR_A, from: "F6", to: "F7", bottom: "S" },
    { id: "civic-stair-7", rect: STAIR_B, from: "F7", to: "ROOF", bottom: "S" },
  ],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "Receive the public and get them into the tower.",
        zones: ["lobby", "café", "mail room", "WC stack", "stair core"],
        sequence: "In from Third Ave, past reception, either to the café or up the NW shaft.",
        adjacency: "Reception faces the entrance across the lobby; the café takes the south windows; mail is tucked SE off the route.",
        negativeSpace: "The lobby floor between the entrance and the shaft stays completely clear.",
      },
      shellOpenings: [
        { kind: "door", width: DOUBLE, near: { x: 1480, y: 340 } }, // main entrance from Third Ave
        { kind: "door", width: DOOR, near: { x: 1780, y: 540 } }, // side exit to Main St
        glazing(1480, 190), glazing(1480, 250), glazing(1480, 440), glazing(1480, 496),
        glazing(1620, 120), glazing(1680, 120), glazing(1900, 120),
        glazing(1550, 540), glazing(1630, 540), glazing(1710, 540), glazing(1950, 540), glazing(2010, 540),
        glazing(2040, 180), glazing(2040, 240), glazing(2040, 320), glazing(2040, 400), glazing(2040, 480),
      ],
      walls: [
        coreA(UP_DOOR),
        ...wcBlock(),
        {
          // Mail room SE: north wall, then down its west face to the shell.
          id: "civic-mail",
          thickness: INT,
          path: [{ x: 2028, y: 404 }, { x: 1884, y: 404 }, { x: 1884, y: 528 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1884, y: 464 } }],
        },
      ],
      objects: [
        ...wcFixtures("g"),
        // Lobby: reception faces the entrance; lounge seat along the west
        // windows with a round side table.
        /**
         * Sixteen units south, and it opens the floor.
         *
         * The desk's north end and the WC block's south-west corner left a 32-unit
         * aperture — the only way between the west half of the lobby and the east half
         * — so Civic's public floor was two disconnected buildings. You came in the main
         * entrance from Third Ave and could reach the lounge and the NW shaft; the cafe,
         * the WC stack, the mail room and the NE shaft were reachable only from the side
         * exit on Main St. To get from one to the other you went back out to the street.
         *
         * The audit had been reporting it for as long as it has existed — 57,024 square
         * units of "open-looking floor disconnected from its arrival route" — and it was
         * carried in `FLOOR_QUALITY_BUDGET` as debt rather than read as the bug it was.
         * Moving the desk takes the stranded region from 936 grid cells to one.
         *
         * The desk still faces the entrance across the lobby, which is what the floor's
         * brief asks of it.
         */
        { id: "civic-reception", kind: "receptionDesk", x: 1640, y: 316, w: 28, h: 120, facing: "W", scannable: true },
        { id: "civic-lobby-couch", kind: "couch", x: 1504, y: 388, w: 36, h: 92, facing: "E", scannable: true },
        { id: "civic-lobby-table", kind: "table", x: 1556, y: 428, w: 40, h: 40 },
        /**
         * Moved off the west windows to the east wall, because at 1500,320 it stood in
         * the front door.
         *
         * The main entrance is the double at 1480,340, so its clear width is y 296–384
         * and the plant sat inside it, eight units off the jamb — which is also exactly
         * the space this floor's own brief reserves: "the lobby floor between the
         * entrance and the shaft stays completely clear." A ghost could stand there; a
         * collider cannot, and promoting `plant` is what made the difference visible.
         *
         * It also freed the lounge couch, whose blueprint had nowhere to go: south is
         * 14 units off the shell, east is under the side table, west is outside the
         * footprint, and this plant was 14 units from the north point.
         */
        { id: "civic-lobby-plant-n", kind: "plant", x: 2008, y: 300, w: 20, h: 20 },
        /**
         * There is no second plant in this lobby, and that is the finding.
         *
         * It has been moved three times. At 1500,320 it stood in the front door. At 1500,500
         * it sat in the 24-unit strip behind the lounge couch, where no bot can go. Beside the
         * reception desk at 1640,444 it narrowed the lobby-to-cafe route to 44 units and
         * stranded the cafe counter and its machine instead. Each move traded one defect for
         * another because the south side of this lobby is circulation — the floor's own brief
         * says "the lobby floor between the entrance and the shaft stays completely clear."
         *
         * A pot that has nowhere to stand is telling you the room is full. `civic-lobby-plant-n`
         * remains, in the north-east corner, where there is room for it.
         */
        // Café along the south wall: espresso machine ON the counter, fridge
        // closing its east end, one café table clear of the side exit.
        { id: "civic-cafe-counter", kind: "counter", x: 1560, y: 494, w: 110, h: 24 },
        { id: "civic-cafe-machine", kind: "coffeeStation", x: 1572, y: 496, w: 40, h: 20 },
        { id: "civic-cafe-fridge", kind: "fridge", x: 1674, y: 484, w: 34, h: 34, facing: "N", scannable: true },

        // Pushed in against the table, so neither is a fixture parked six units off one.
        /**
         * The cafe is a counter, not table service, and the side exit is why.
         *
         * A table with a chair either side stood at x 1720–1808, directly in front of the Main
         * St door at 1780 — the chair's east edge and the door's east jamb were the same line.
         * So the vestibule inside that exit was a pocket: standable, and joined to the rest of
         * the floor only by going back out to the street and round. The same shape as the
         * temple's front door, and invisible for the same reason — GROUND shares the outdoor
         * plane, so a route always "exists".
         *
         * Three things want this corner: the lounge, the cafe and an exit. A lobby cafe is a
         * service counter far more often than it is a dining room, so the counter, its machine
         * and the fridge keep the south windows west of the door and the seating goes.
         */
        // Mail room SE: lockers along the east wall, sorting counter.
        { id: "civic-mail-locker-a", kind: "locker", x: 1994, y: 416, w: 26, h: 38, scannable: true },
        { id: "civic-mail-locker-b", kind: "locker", x: 1994, y: 458, w: 26, h: 38 },
        // Four units east, off the mail room's own door threshold (reaches x=1898) and
        // still clear of the lockers at 1994.
        { id: "civic-mail-counter", kind: "counter", x: 1900, y: 484, w: 80, h: 22 },
        // Flush to the north wall's inner face (y=408), not floating 12 units off it.
        // At y=420 it left a 44-unit slot between itself and the sorting counter —
        // narrower than a bot — so the moment `utilityBox` became solid the mail room
        // sealed itself and nothing could reach the lockers. Against the wall the slot
        // is 56, which is a bot plus clearance.
        { id: "civic-mail-power", kind: "utilityBox", x: 1900, y: 408, w: 26, h: 20 },
        { id: "civic-mail-plant", kind: "plant", x: 1852, y: 330, w: 20, h: 20 },
      ],
      dots: [
        // East of the cafe chairs rather than inside the east one. A Dot on a chair was
        // invisible while chairs were walk-through; a bot cannot stand there now.
        { id: "civic-dot-cafe", item: { kind: "powerup", type: "incognito" }, x: 1852, y: 452 },
        // In the lobby, which is where its name says it is. At 1950,448 it sat in
        // the mail room 16 units off a locker bank — close enough to a blueprint
        // spawn that the two were one pickup.
        // Clear of the cafe fridge, which it was standing 14 units inside of.
        { id: "civic-dot-lobby", item: { kind: "powerup", type: "radar" }, x: 1620, y: 462 },
      ],
    },
    {
      label: "F1",
      brief: {
        purpose: "Open-plan office with one enclosed meeting room.",
        zones: ["desk rows", "meeting room", "break corner", "WC stack"],
        sequence: "Off the NW shaft, along the core corridor, into the desk field; the NE shaft continues up.",
        adjacency: "The meeting room takes the SE corner so it never blocks a window run.",
        negativeSpace: "A lane along the west windows and one past the meeting room stay open.",
      },
      shellOpenings: upperGlazing(),
      walls: [
        coreA(DOWN_DOOR),
        coreB(UP_DOOR),
        ...wcBlock(),
        {
          id: "civic-meeting",
          thickness: INT,
          path: [{ x: 2028, y: 404 }, { x: 1856, y: 404 }, { x: 1856, y: 528 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1856, y: 468 } }],
        },
      ],
      objects: [
        ...wcFixtures("f1"),
        // Two facing desk rows south of the core corridor, with clear lanes
        // along the west window wall and past the meeting room.
        /**
         * Two desk pods, each a back-to-back pair, 64 units apart.
         *
         * They used to be four desks in a loose 2 x 2 with 34 units between the north and
         * south rows and 44 between the columns — both inside the false-aisle band, which is
         * the audit's way of saying a gap that looks like a route and is not one. It is also
         * not how desks go together: an office puts them back to back so two people share a
         * spine and a cable run, and the aisles go round the pod rather than through it.
         * Joined at y=432 the pod is one 96 x 92 island; between the pods there is now a real
         * 64-unit lane, and 52 either side to the west windows and the meeting room.
         */
        { id: "civic-f1-desk-nw", kind: "desk", x: 1544, y: 340, w: 96, h: 46, facing: "N", scannable: true },
        { id: "civic-f1-desk-sw", kind: "desk", x: 1544, y: 386, w: 96, h: 46, facing: "S" },
        { id: "civic-f1-desk-ne", kind: "desk", x: 1704, y: 340, w: 96, h: 46, facing: "N" },
        { id: "civic-f1-desk-se", kind: "desk", x: 1704, y: 386, w: 96, h: 46, facing: "S" },
        { id: "civic-f1-filing-a", kind: "filingCabinet", x: 1996, y: 320, w: 30, h: 48, scannable: true },
        { id: "civic-f1-filing-b", kind: "filingCabinet", x: 1996, y: 372, w: 30, h: 48 },
        // Meeting room SE.
        { id: "civic-f1-table", kind: "conferenceTable", x: 1924, y: 420, w: 96, h: 56, scannable: true },
        // Break corner SW.
        // Clear of the desk's west edge at 1540 rather than clipping it by four
        // units — invisible while a coffee station was walk-through.
        { id: "civic-f1-coffee", kind: "coffeeStation", x: 1494, y: 504, w: 44, h: 22 },
        { id: "civic-f1-break-table", kind: "table", x: 1548, y: 504, w: 44, h: 24 },
        // Flush under the desk's south edge and against the break table, rather than
        // tucked 8 units beneath the desk: once a chair collides, an overlap is two
        // solids claiming the same floor.
        { id: "civic-f1-break-chair", kind: "chair", x: 1602, y: 506, w: 20, h: 20, facing: "N" },
        { id: "civic-f1-plant", kind: "plant", x: 1810, y: 504, w: 20, h: 20 },
      ],
      dots: [
        // In the 64-unit lane between the two pods. At 1760,344 it was inside the east pod's
        // north desk once the desks were rearranged — a Dot follows its furniture.
        { id: "civic-dot-f1-desks", item: { kind: "powerup", type: "incognito" }, x: 1672, y: 386 },
        { id: "civic-dot-f1-meeting", item: { kind: "powerup", type: "health" }, x: 1890, y: 492 },
      ],
    },
    {
      label: "F2",
      brief: {
        purpose: "Data floor: a secured server room, with open files at the windows and the archive behind them.",
        zones: ["server room", "records", "archive", "circulation", "WC stack"],
        sequence: "Off the NE shaft, around the server room, into the archive off the NW shaft's landing.",
        adjacency: "The server room sits in the centre bay so it can be walked all the way round; open records take the east windows, and the archive takes the west strip, back-to-back with the server room's blind wall.",
        negativeSpace: "The ring of floor around the server room is the only route across, and the archive aisle runs down its west windows.",
      },
      shellOpenings: upperGlazing(),
      walls: [
        /**
         * The NW shaft gets a second door, on its south face, into the west strip.
         *
         * Without it that strip — 78 by 172, bigger than either ground-floor office —
         * was floor nobody could enter. It is boxed in by this shaft's south wall and
         * the server room's west wall, and the only aperture between those two is 24
         * units wide for a 48-unit bot. No fixture was involved, so no fixture could
         * fix it; the audit had been carrying 13,504 square units of it as debt.
         *
         * A stair landing with a door into the floor's side space is ordinary planning,
         * and it costs one opening rather than moving the server room and the generator
         * with it.
         *
         * Worth knowing if this ever regresses: the door alone does nothing. The channel
         * it opens is one grid cell wide, and `civic-f2-plant` used to stand on the
         * landing directly inside it — 20 units from the only line through, so the strip
         * stayed sealed and the door looked like it had failed. It took moving the plant
         * as well. See its own comment below.
         */
        {
          ...coreA(UP_DOOR),
          openings: [
            ...(coreA(UP_DOOR).openings ?? []),
            { kind: "door", width: DOOR, near: { x: 1538, y: 296 } },
          ],
        },
        coreB(DOWN_DOOR),
        ...wcBlock(),
        {
          // The server room, as one closed enclosure with a single door.
          id: "civic-server-room",
          thickness: INT,
          closed: true,
          path: [{ x: 1616, y: 324 }, { x: 1872, y: 324 }, { x: 1872, y: 504 }, { x: 1616, y: 504 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1780, y: 324 } }],
        },
      ],
      objects: [
        ...wcFixtures("f2"),
        // Server room: rack row against the south wall, power plant west.
        /**
         * The rack row moves to the south wall and the machines take the north, so the
         * service aisle between them is 50 units of real floor.
         *
         * Before this, rack A and the power box were both fixtures nobody could stand beside.
         * The row sat 6 units off the south wall with the power box 8 units above it and the
         * generator 8 above that, which stacked four objects across a 172-deep room and left
         * no band anywhere wide enough to hold a body. A server room whose racks cannot be
         * approached is a cupboard with a door.
         */
        { id: "civic-rack-a", kind: "serverRack", x: 1640, y: 430, w: 36, h: 70, facing: "N", scannable: true },
        { id: "civic-rack-b", kind: "serverRack", x: 1690, y: 430, w: 36, h: 70, facing: "N" },
        { id: "civic-rack-c", kind: "serverRack", x: 1740, y: 430, w: 36, h: 70, facing: "N" },
        /**
         * Not scannable, and the archive is what showed why.
         *
         * A blueprint spawn goes on its object's most open side, and this generator has no
         * open side: 12 units to the room's north wall, 10 to its west wall, 8 to the power
         * box below, and its one clear face east is inside the separation radius of the
         * Dot already in that lane. So `mostOpenSide` had been walking its expansion ring
         * WEST — straight through the server room's wall — and landing the spawn in the
         * west strip, on the wrong side of a wall from the machine it describes.
         *
         * That only ever "worked" because the strip was empty floor. Furnishing it as the
         * archive filled the space the ring was escaping into, and the placer threw, which
         * is exactly what the fatal check is for.
         *
         * Civic still yields a generator blueprint: `seen` is per building, so the F7 plant
         * deck's generator takes over — and that one stands in a machine row with walking
         * room on two sides, which is what a scannable object is supposed to have. The rack
         * row remains this room's scannable, so the server room still holds one.
         */
        // x stays at 1630. Nudging it to 1626 closed the gap to the archive stacks from 18
        // units to 14, which turns a false aisle into an attached seam — and that gap is the
        // negative control in "does not call a gap an aisle when a wall crosses it". A
        // cosmetic four units would have quietly deleted the evidence for a rule.
        { id: "civic-f2-generator", kind: "generator", x: 1630, y: 332, w: 70, h: 48 },
        { id: "civic-f2-hvac", kind: "hvac", x: 1796, y: 430, w: 64, h: 46 },
        // Beside the generator on the north wall, not under it. Wedged between the generator
        // and rack A it was 8 units from each and reachable from neither.
        { id: "civic-f2-power", kind: "utilityBox", x: 1702, y: 332, w: 26, h: 48 },
        // Records: filing along the east wall outside the room.
        { id: "civic-f2-filing-a", kind: "filingCabinet", x: 1996, y: 330, w: 30, h: 48 },
        { id: "civic-f2-filing-b", kind: "filingCabinet", x: 1996, y: 382, w: 30, h: 48 },
        { id: "civic-f2-crate", kind: "crateStack", x: 1992, y: 460, w: 34, h: 34 },
        /**
         * Down the strip, off the new shaft door's landing.
         *
         * At 1500,320 it stood 20 units from the single line through that door — the
         * whole reason the door read as not working. A pot plant was holding 13,504
         * square units of floor closed, which is the ghost-hides-a-bug pattern one more
         * time: it was walk-through until `plant` was promoted earlier today.
         */
        /**
         * Now in the south-west corner, flush to both walls.
         *
         * At 1500,440 it was clear of the door channel, which was all it had to be while
         * the strip was empty. Furnishing gave it a second constraint it failed: it stood
         * 46 units north-south from the withdrawals cabinet with their footprints
         * overlapping in x, which is a gap too narrow to walk and too wide to read as one
         * piece of furniture — a false aisle, the fault this pass cleared seven of.
         *
         * The corner has neither problem. It is flush west and south so there is no slot
         * behind it, it clears the south window at x 1528, and the stacks are 70 units east.
         */
        { id: "civic-f2-plant", kind: "plant", x: 1492, y: 508, w: 20, h: 20 },
        /**
         * The archive: the west strip, furnished at last.
         *
         * It was proved reachable and left holding one pot plant, which the contract calls
         * a decorated void — 120 by 228 of floor with nothing in it to want.
         *
         * The shelving goes on the EAST side, against the server room's west face, because
         * that is the only blind wall the strip has. Its own west wall carries three
         * windows (y 340, 420, 480) and the south wall carries one at x 1550, so any bank
         * put there would board up the glazing that lights the room. Back-to-back with the
         * server room is also how this gets planned in a real building: the deep stacks
         * take the internal wall and the aisle takes the daylight.
         *
         * One continuous run rather than three spaced units. A 4-unit gap between shelves
         * is not an aisle and not a bank — it audits as a false aisle, which is precisely
         * the fault this pass spent its time clearing elsewhere.
         *
         * The aisle west of the bank is 86 units, comfortably over the 64 a bot needs, and
         * the run stops at y 508 where the server room's wall does, so it never reaches
         * across the mouth of the strip's southern opening.
         */
        { id: "civic-f2-archive-a", kind: "shelf", x: 1582, y: 330, w: 30, h: 60, facing: "W" },
        { id: "civic-f2-archive-b", kind: "shelf", x: 1582, y: 390, w: 30, h: 60, facing: "W" },
        { id: "civic-f2-archive-c", kind: "shelf", x: 1582, y: 450, w: 30, h: 58, facing: "W" },
        /**
         * A withdrawals cabinet against the west wall, in the blind slot between windows.
         *
         * It went on the north wall first, west of the new shaft door, and the doorway
         * audit caught it at once: the door at x 1538 is 56 wide, so it spans 1510 to 1566
         * and there are only 18 units of wall west of it. Nothing 30 units long fits beside
         * that door, which is worth knowing rather than working around — the landing has to
         * stay clear, and the whole reason this strip is reachable is that door.
         *
         * The west wall is glazed at y 340, 420 and 480, so it is not one blind face but
         * four short ones. This takes the segment between the first two windows (y 362 to
         * 398), turned so its 30-unit length runs with the wall. The aisle to the stacks is
         * then 66 units, still over the 64 a bot needs.
         */
        { id: "civic-f2-archive-cabinet", kind: "filingCabinet", x: 1492, y: 364, w: 24, h: 30 },
      ],
      dots: [
        /**
         * In the archive aisle, between the window wall and the stacks.
         *
         * A room nobody has a reason to enter is scenery, and the whole point of opening
         * this strip was that it is real floor. North of the plant rather than beside it:
         * at 1535,430 it sat 36 units from the pot, which clears a bot but puts loot in
         * the one spot in an empty room where you have to squeeze.
         */
        { id: "civic-dot-f2-archive", item: { kind: "powerup", type: "dashOvercharge" }, x: 1545, y: 352 },
        /**
         * In the lane between the north units and the rack row.
         *
         * That lane is only 36 units deep, so there is very little room to be
         * wrong here: at 1720,400 the dot was 23.3 from an air handler and at
         * 1740,415 it was 9 from a rack. Both put a Dot where no bot could reach
         * it, which makes it scenery rather than loot.
         */
        // Follows the racks. The lane it sits in went from 36 units deep to 50 when the
        // machine bank moved to the north wall, and at 1728 the dot ended up 19 units from
        // the relocated power box — a Dot is only loot if a bot can stand on it.
        { id: "civic-dot-f2-server", item: { kind: "powerup", type: "radar" }, x: 1760, y: 404 },
        { id: "civic-dot-f2-records", item: { kind: "powerup", type: "health" }, x: 1960, y: 460 },
      ],
    },
    {
      label: "F3",
      brief: {
        purpose: "Executive floor: two offices, a boardroom and the lounge between them.",
        zones: ["office north", "office south", "boardroom", "lounge", "WC stack"],
        sequence: "Off the NW shaft, along the corridor, through the lounge to the boardroom.",
        adjacency: "Offices take the west windows; the boardroom takes the east; the lounge is the shared middle.",
        negativeSpace: "A full-width corridor at the room fronts clears the core band.",
      },
      shellOpenings: upperGlazing(),
      walls: [
        coreA(DOWN_DOOR),
        coreB(UP_DOOR),
        ...wcBlock(),
        {
          id: "civic-boardroom",
          thickness: INT,
          path: [{ x: 2028, y: 320 }, { x: 1856, y: 320 }, { x: 1856, y: 528 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1856, y: 418 } }],
        },
        {
          id: "civic-office-north",
          thickness: INT,
          path: [{ x: 1492, y: 320 }, { x: 1656, y: 320 }, { x: 1656, y: 428 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1656, y: 364 } }],
        },
        {
          id: "civic-office-south",
          thickness: INT,
          path: [{ x: 1492, y: 432 }, { x: 1656, y: 432 }, { x: 1656, y: 528 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1656, y: 478 } }],
        },
      ],
      objects: [
        ...wcFixtures("f3"),
        // Boardroom.
        { id: "civic-board-table", kind: "conferenceTable", x: 1896, y: 336, w: 110, h: 60, scannable: true },
        { id: "civic-board-cabinet", kind: "cabinet", x: 1950, y: 490, w: 70, h: 24 },
        { id: "civic-board-plant", kind: "plant", x: 1866, y: 496, w: 20, h: 20 },
        // Office 1 (north).
        { id: "civic-office-n-desk", kind: "desk", x: 1504, y: 332, w: 80, h: 52, facing: "S", scannable: true },
        { id: "civic-office-n-couch", kind: "couch", x: 1504, y: 388, w: 70, h: 34, facing: "N" },
        // Office 2 (south).
        { id: "civic-office-s-desk", kind: "desk", x: 1504, y: 452, w: 80, h: 52, facing: "S" },
        /**
         * Flush to the desk's south face, in the dead strip behind it.
         *
         * At 1626,504 it clipped its own office threshold at 1656,478 by eight units
         * — legal for a ghost, a doorstop for a collider. And parking it two units off
         * the desk instead of against it just traded that for a `wedged-fixture`: a
         * 2-unit slot reads as a gap and is not one. Touching, it is one piece of
         * furniture.
         */
        /**
         * Office 2 loses its plant, for the same reason the lobby loses its second one.
         *
         * The strip east of the desk is 68 wide, so after a body's standoff from the desk and
         * the office's east wall the walkable band through it is 20 units. A 20-unit pot fills
         * it exactly. Three earlier positions each dodged one rule and landed in dead floor;
         * this one sealed a pocket of it. The office keeps its desk, and office 1 keeps the
         * couch that makes the pair read as two rooms rather than one repeated.
         */
        // Lounge centre, kept east of the office doors.
        { id: "civic-f3-rug", kind: "rug", x: 1700, y: 350, w: 150, h: 130 },
        { id: "civic-f3-couch", kind: "couch", x: 1710, y: 360, w: 90, h: 38, facing: "S" },
        { id: "civic-f3-table", kind: "table", x: 1724, y: 416, w: 44, h: 44 },
        { id: "civic-f3-plant", kind: "plant", x: 1810, y: 330, w: 20, h: 20 },
      ],
      dots: [
        { id: "civic-dot-f3-board", item: { kind: "powerup", type: "incognito" }, x: 1940, y: 420 },
        { id: "civic-dot-f3-lounge", item: { kind: "powerup", type: "dashOvercharge" }, x: 1730, y: 490 },
      ],
    },
    {
      label: "F4",
      brief: {
        purpose: "Operations: one incident table the whole floor works around.",
        zones: ["incident table", "dispatch desks", "equipment wall", "WC stack"],
        sequence: "Off the NE shaft, past the incident table to the dispatch desks, out through the NW shaft.",
        adjacency: "Kit and racks line the east wall, within reach of the desks but off the walking line.",
        negativeSpace: "The table is approachable from all four sides — that is the point of the floor.",
      },
      shellOpenings: upperGlazing(),
      walls: [coreA(UP_DOOR), coreB(DOWN_DOOR), ...wcBlock()],
      objects: [
        ...wcFixtures("f4"),
        /**
         * 68 units between the table and the dispatch desks, not 50.
         *
         * The floor brief says the incident table is "approachable from all four sides — that
         * is the point of the floor", and its south side was a 50-unit slot against a 96-unit
         * desk run: passable by a unit either side, which is not approachable. The table goes
         * north to sit under the core instead, and the two desks open to 64 apart so the lane
         * between them is a lane.
         */
        { id: "civic-incident-table", kind: "conferenceTable", x: 1640, y: 332, w: 170, h: 70, scannable: true },
        { id: "civic-f4-desk-w", kind: "desk", x: 1540, y: 470, w: 96, h: 46, facing: "N" },
        // Back at 1680. Opening the lane to 64 by sliding this desk east put its corner 17
        // units from the bot spawn at 1810,460, which wedges that bot for the whole match.
        // The 44-unit gap was never reported — two 46-deep desks do not overlap by a bot's
        // diameter, so it is not a false aisle — and the incident table's south side was the
        // real complaint.
        { id: "civic-f4-desk-e", kind: "desk", x: 1680, y: 470, w: 96, h: 46, facing: "N" },
        { id: "civic-f4-rack-a", kind: "serverRack", x: 1996, y: 320, w: 26, h: 56 },
        { id: "civic-f4-rack-b", kind: "serverRack", x: 1996, y: 384, w: 26, h: 56 },
        { id: "civic-f4-locker-a", kind: "locker", x: 1860, y: 488, w: 26, h: 38 },
        { id: "civic-f4-locker-b", kind: "locker", x: 1890, y: 488, w: 26, h: 38 },
        { id: "civic-f4-locker-c", kind: "locker", x: 1920, y: 488, w: 26, h: 38 },
        { id: "civic-f4-crate", kind: "crateStack", x: 1992, y: 460, w: 34, h: 34 },
        { id: "civic-f4-plant", kind: "plant", x: 1500, y: 320, w: 20, h: 20 },
      ],
      dots: [
        { id: "civic-dot-f4-desks", item: { kind: "powerup", type: "health" }, x: 1600, y: 420 },
        { id: "civic-dot-f4-kit", item: { kind: "powerup", type: "radar" }, x: 1900, y: 360 },
      ],
    },
    {
      label: "F5",
      brief: {
        purpose: "Studio floor: worktable pairs with a materials wall.",
        zones: ["north benches", "south benches", "materials wall", "WC stack"],
        sequence: "Off the NW shaft, down the central aisle between the bench pairs.",
        adjacency: "Stock sits on the east wall, one reach from either bench row.",
        negativeSpace: "The aisle between the two bench rows runs the full width.",
      },
      shellOpenings: upperGlazing(),
      walls: [coreA(DOWN_DOOR), coreB(UP_DOOR), ...wcBlock()],
      objects: [
        ...wcFixtures("f5"),
        { id: "civic-f5-bench-nw", kind: "workbench", x: 1560, y: 340, w: 150, h: 32, facing: "S", scannable: true },
        { id: "civic-f5-bench-ne", kind: "workbench", x: 1780, y: 340, w: 150, h: 32, facing: "S" },
        { id: "civic-f5-bench-sw", kind: "workbench", x: 1560, y: 450, w: 150, h: 32, facing: "N" },
        { id: "civic-f5-bench-se", kind: "workbench", x: 1780, y: 450, w: 150, h: 32, facing: "N" },
        /**
         * Pushed in against the bench they belong to, not parked 16 units off it.
         *
         * That 16-unit slot did two things wrong at once once a stool collided: it is
         * exactly the `wedged-fixture` case — too narrow to enter, too wide to read as
         * joined — and it left only 42 units between the stool row and the south bench,
         * six short of a bot, which cut the floor's west end off from its stair. Flush,
         * the aisle is 58.
         */
        { id: "civic-f5-stool-a", kind: "chair", x: 1600, y: 372, w: 20, h: 20, facing: "N" },
        { id: "civic-f5-stool-b", kind: "chair", x: 1660, y: 372, w: 20, h: 20, facing: "N" },
        { id: "civic-f5-stool-c", kind: "chair", x: 1820, y: 372, w: 20, h: 20, facing: "N" },
        { id: "civic-f5-stool-d", kind: "chair", x: 1880, y: 372, w: 20, h: 20, facing: "N" },
        { id: "civic-f5-stock", kind: "shelf", x: 1996, y: 330, w: 26, h: 140 },
        // 492, not 500: at 500 a 34-unit stack ran to 534 against a south inner face of 528,
        // so six units of it stood inside the wall.
        { id: "civic-f5-crate", kind: "crateStack", x: 1520, y: 492, w: 34, h: 34 },
        // Into the corner, which closes a 2-cell standable pocket that had been sealed
        // between the stock shelf, this pot and the two walls.
        { id: "civic-f5-plant", kind: "plant", x: 1996, y: 500, w: 20, h: 20 },
      ],
      dots: [
        { id: "civic-dot-f5-aisle", item: { kind: "powerup", type: "dashOvercharge" }, x: 1700, y: 420 },
        { id: "civic-dot-f5-west", item: { kind: "powerup", type: "incognito" }, x: 1520, y: 420 },
      ],
    },
    {
      label: "F6",
      brief: {
        purpose: "Commons: the floor the building comes to sit on.",
        zones: ["lounge group", "library wall", "coffee bar", "WC stack"],
        sequence: "Off the NE shaft, past the coffee bar, into the lounge; the library wall runs along the south.",
        adjacency: "Books back onto the south windows; the bar takes the NW corner by the shaft.",
        negativeSpace: "The rug marks the lounge; the floor around it stays walkable on all sides.",
      },
      shellOpenings: upperGlazing(),
      walls: [coreA(UP_DOOR), coreB(DOWN_DOOR), ...wcBlock()],
      objects: [
        ...wcFixtures("f6"),
        { id: "civic-f6-rug", kind: "rug", x: 1600, y: 350, w: 240, h: 160 },
        /**
         * Sixteen units east, which is the difference between a squeeze and a way in.
         *
         * The gap between the bar counter's east end and this couch was 50 units for a
         * 48-unit bot: passable with half a unit either side, which is not a route. It was
         * the only way into the lounge's west strip, so the audit reported 11,136 square
         * units disconnected — and `civic-f6-couch-w` sat inside it, a couch nobody could
         * reach. At 66 the opening is a walkable one.
         */
        { id: "civic-f6-couch-n", kind: "couch", x: 1656, y: 360, w: 110, h: 40, facing: "S", scannable: true },
        { id: "civic-f6-couch-w", kind: "couch", x: 1610, y: 420, w: 40, h: 90, facing: "E" },
        /**
         * Against the west couch, not 70 units off it.
         *
         * That slot was open floor at its centre and sealed at both ends — the couch to
         * the west, the table to the east, the north couch across the top — so it read as
         * floor and was not. It is the space inside a seating arrangement, where legs go;
         * it should never have been a route. A coffee table touching the couch it serves
         * says that, and takes the lounge to no disconnected floor at all.
         */
        { id: "civic-f6-table", kind: "table", x: 1650, y: 410, w: 56, h: 56 },
        // West to 1660, so the library run meets the lounge couch with a seam instead of
        // leaving a two-cell pocket of standable floor between them that nothing can reach.
        { id: "civic-f6-shelf-w", kind: "shelf", x: 1660, y: 498, w: 130, h: 26 },
        { id: "civic-f6-shelf-e", kind: "shelf", x: 1850, y: 498, w: 130, h: 26 },
        { id: "civic-f6-bar", kind: "counter", x: 1500, y: 320, w: 90, h: 24 },
        // At the bar's east end. At 1520,296 it was standing in the NW shaft's south wall,
        // which spans y 292..300 — the machine was inside the masonry.
        // Under the bar's west end. Parking it at the bar's EAST end put it in the one
        // opening into the lounge's west strip, which resealed 11,392 square units that an
        // earlier round had opened — the same pocket, closed by a different object.
        { id: "civic-f6-coffee", kind: "coffeeStation", x: 1500, y: 348, w: 44, h: 22 },
        // The whole cafe group shifts 16 west: the east chair reached x=2032 against an east
        // inner face of 2028, so a quarter of it was in the wall.
        { id: "civic-f6-cafe-chair-w", kind: "chair", x: 1884, y: 352, w: 20, h: 20, facing: "E" },
        { id: "civic-f6-cafe-table", kind: "table", x: 1904, y: 340, w: 48, h: 48 },
        { id: "civic-f6-cafe-chair-e", kind: "chair", x: 1956, y: 352, w: 20, h: 20, facing: "W" },
        // South-east corner, 43 units off the library Dot. At 1996,440 it sat 17
        // units from it, which is inside a bot radius — the Dot was somewhere you
        // could see and not stand.
        { id: "civic-f6-plant", kind: "plant", x: 2004, y: 470, w: 20, h: 20 },
      ],
      dots: [
        { id: "civic-dot-f6-lounge", item: { kind: "powerup", type: "health" }, x: 1900, y: 420 },
        { id: "civic-dot-f6-library", item: { kind: "powerup", type: "incognito" }, x: 1980, y: 434 },
      ],
    },
    {
      label: "F7",
      brief: {
        purpose: "Mechanical penthouse: plant, comms and spares for the whole tower.",
        zones: ["plant floor", "comms wall", "maintenance bench", "janitor store"],
        sequence: "Off the NW shaft, between the air handlers, along the bench to the racks.",
        adjacency: "Comms racks take the east wall beside the roof stair; the bench sits under the south windows.",
        negativeSpace: "A service lane runs between the plant and the bench, wide enough to move a unit.",
      },
      shellOpenings: upperGlazing(),
      walls: [coreA(DOWN_DOOR), coreB(UP_DOOR), ...wcBlock()],
      objects: [
        // The WC stack becomes janitor space up here.
        /**
         * Three drums as one bank in the corner, sink on the far wall.
         *
         * Scattered at 1720, 1750 and 1800 they did two things wrong once a drum
         * became solid: the middle one stood directly north of the store's door at
         * 1752,256 and blocked it, and the outer two left a 62-unit slot between
         * them — wide enough to look like a way through and too narrow to be one,
         * which is exactly what `false-aisle` exists to reject. Stacked flush they
         * are a bank. Along the north wall rather than the east one because the
         * store has *two* doors, at 1752 and 1832: a stack against the east wall
         * cleared the first and blocked the second. With their bottom edge at 164
         * both approaches have 44 units of clear run.
         */
        /**
         * All three drums inside ONE of the two store rooms, wall to wall.
         *
         * The comment this replaces was right about the doors and wrong about the geometry:
         * starting the bank at 1770 put drum A across the partition at x=1784, so the "bank"
         * spanned two rooms and its first drum stood inside the dividing wall. Nothing
         * reported it, because `solid-overlap` only compares object to object. Three 24-unit
         * drums are exactly the east store's 72-unit width, which is what a store room full
         * of drums looks like from above, and the sink keeps the west one.
         */
        { id: "civic-f7-drum-a", kind: "drum", x: 1788, y: 140, w: 24, h: 24 },
        { id: "civic-f7-drum-b", kind: "drum", x: 1812, y: 140, w: 24, h: 24 },
        { id: "civic-f7-drum-c", kind: "drum", x: 1836, y: 140, w: 24, h: 24 },
        { id: "civic-f7-janitor-sink", kind: "sink", x: 1712, y: 142, w: 22, h: 32 },
        // Plant floor.
        // Joined into one plant bank. A 20-unit slot between two air handlers is not a
        // service gap, it is the false-aisle band; plant units are craned in as a row.
        { id: "civic-f7-hvac-a", kind: "hvac", x: 1590, y: 340, w: 70, h: 50 },
        { id: "civic-f7-hvac-b", kind: "hvac", x: 1670, y: 340, w: 70, h: 50 },
        { id: "civic-f7-generator", kind: "generator", x: 1840, y: 340, w: 74, h: 52, scannable: true },
        { id: "civic-f7-rack-a", kind: "serverRack", x: 1996, y: 320, w: 26, h: 50 },
        { id: "civic-f7-rack-b", kind: "serverRack", x: 1996, y: 378, w: 26, h: 50 },
        { id: "civic-f7-rack-c", kind: "serverRack", x: 1996, y: 436, w: 26, h: 50 },
        { id: "civic-f7-bench", kind: "workbench", x: 1600, y: 470, w: 120, h: 30, facing: "N", scannable: true },
        { id: "civic-f7-tools", kind: "toolCabinet", x: 1740, y: 474, w: 44, h: 26 },
        { id: "civic-f7-drum-d", kind: "drum", x: 1530, y: 478, w: 24, h: 24 },
        { id: "civic-f7-drum-e", kind: "drum", x: 1558, y: 478, w: 24, h: 24 },
        { id: "civic-f7-vent-a", kind: "vent", x: 1520, y: 320, w: 22, h: 22 },
        { id: "civic-f7-vent-b", kind: "vent", x: 1950, y: 504, w: 22, h: 22 },
        /**
         * Flush against the east HVAC unit, so the plant row is one bank with one
         * aisle.
         *
         * Free-standing at 1770 it sat in the middle of the 90-unit gap between the
         * HVAC pair and the generator, and splitting that into 20 and 44 turned the
         * machine row into a wall the moment `utilityBox` became solid: the whole south
         * half of the floor — bench, tool cabinet, both Dots — was cut off from the
         * stair cores. Against the unit it powers, the aisle is a single 64.
         */
        { id: "civic-f7-power", kind: "utilityBox", x: 1750, y: 344, w: 26, h: 20 },
      ],
      dots: [
        { id: "civic-dot-f7-plant", item: { kind: "powerup", type: "dashOvercharge" }, x: 1750, y: 420 },
        { id: "civic-dot-f7-comms", item: { kind: "powerup", type: "incognito" }, x: 1880, y: 440 },
      ],
    },
    {
      label: "ROOF",
      brief: {
        purpose: "The tower's plant deck, with one corner given over to a terrace.",
        zones: ["machine room", "HVAC field", "skylights", "terrace corner"],
        sequence: "Out of the NE shaft, across the deck between the units, to the terrace SE.",
        adjacency: "Plant clusters north over the service core; the terrace takes the far corner from it.",
        negativeSpace: "The strip between the HVAC field and the skylights stays clear for access.",
      },
      walls: [
        coreB(DOWN_DOOR),
        // Shaft A continues up as a closed machine-room bulkhead.
        { ...coreA(UP_DOOR), id: "civic-machine-room" },
      ],
      objects: [
        // Machine room inside the A bulkhead.
        /**
         * The bulkhead is 88 wide, so its whole width minus a body is 40 units — which is to
         * say almost nothing. A 64-wide generator at y=160 with the power box below it left no
         * band anywhere in the room that a bot could stand in AND reach the generator from.
         * Generator flat against the north wall, power box on the west, and the room's south
         * half becomes the standing room. Machine rooms are mostly access.
         */
        { id: "civic-roof-generator", kind: "generator", x: 1500, y: 140, w: 64, h: 46 },
        { id: "civic-roof-power", kind: "utilityBox", x: 1496, y: 200, w: 26, h: 20 },
        // HVAC field.
        // One L-shaped bank rather than three units with 18 and 28 unit slots between them.
        // The brief reserves "the strip between the HVAC field and the skylights" for access,
        // which is the aisle that matters; the gaps inside the field were never routes.
        { id: "civic-roof-hvac-a", kind: "hvac", x: 1650, y: 180, w: 72, h: 52 },
        { id: "civic-roof-hvac-b", kind: "hvac", x: 1734, y: 180, w: 72, h: 52 },
        { id: "civic-roof-hvac-c", kind: "hvac", x: 1650, y: 244, w: 72, h: 52 },
        { id: "civic-roof-vent-a", kind: "vent", x: 1840, y: 190, w: 22, h: 22 },
        { id: "civic-roof-vent-b", kind: "vent", x: 1840, y: 240, w: 22, h: 22 },
        { id: "civic-roof-utility", kind: "utilityBox", x: 1880, y: 190, w: 26, h: 20 },
        // Skylights over the south floor plate.
        { id: "civic-roof-skylight-w", kind: "skylight", x: 1600, y: 400, w: 110, h: 70 },
        { id: "civic-roof-skylight-e", kind: "skylight", x: 1760, y: 400, w: 110, h: 70 },
        /**
         * Terrace corner SE, laid out inside the parapet.
         *
         * The first version hung off the building: the planter ran to y 560 against
         * a 540 south elevation and the east chair to x 2048 against 2040, so both
         * appeared to be sliding off the roof. Shuffling them in one at a time does
         * not work — the table had to move west before the chair beside it had
         * anywhere to go — so the whole cluster is set out afresh within the
         * 1492..2028 x 132..528 inner face. `object-off-floor` now fails the map if
         * anything reaches past an elevation again.
         */
        /**
         * Solid, like every other planter. It carried `solid: false` with no reason
         * recorded, which is the ghost pattern #45 and #46 cleared everywhere else: a
         * 30x90 concrete box that a bot walked through while casting a shadow onto the
         * deck. The renderer's passable check found it — nothing on the map had.
         */
        { id: "civic-roof-planter", kind: "planter", x: 1994, y: 400, w: 30, h: 90 },
        { id: "civic-roof-table", kind: "table", x: 1900, y: 380, w: 48, h: 48 },
        { id: "civic-roof-chair-w", kind: "chair", x: 1876, y: 392, w: 20, h: 20, facing: "E" },
        { id: "civic-roof-chair-e", kind: "chair", x: 1952, y: 392, w: 20, h: 20, facing: "W" },
        // 68 clear between the table and the bench: at 28 it was a slot you could
        // see across and not walk through, which `false-aisle` rejects.
        { id: "civic-roof-bench", kind: "bench", x: 1900, y: 496, w: 90, h: 22, facing: "N" },
      ],
      dots: [{ id: "civic-dot-roof", item: { kind: "powerup", type: "incognito" }, x: 1800, y: 330 }],
    },
  ],
};

export const civicTower = compileBuilding(CIVIC_SOURCE);
