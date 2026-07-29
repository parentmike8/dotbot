import { compileBuilding, type SourceBuilding } from "../mapSource";

/**
 * THE GREAT TEMPLE — four levels, two of them below ground, and the way into the
 * tunnel system that runs under this whole quarter of the world.
 *
 * It was a 520 x 520 pyramid with two rooms in it. The direction was blunt: "the temple
 * needs to be much much larger and have a fascinating interior, with multiple levels +
 * act as the entrance to a massive underground tunnel system that goes beneath that
 * section of the map." All three of those are structural, so all three are here:
 *
 *   ROOF     the summit platform and the shrine cell — the region's one commanding view
 *   GROUND   the substructure: entrance hall, the grand stair, the tomb chamber
 *   B1       the crypt: a nave with burial cells down both aisles
 *   B2       the UNDERCROFT: the tunnels, and they run out well past the pyramid
 *
 * WHY IT IS ONE BUILDING AND NOT TWO. A stair links two floors OF THE SAME BUILDING —
 * `compileStairPair` throws otherwise — so anything a player can walk down to from the
 * entrance hall has to be a floor of the temple. The tunnels are therefore temple floors,
 * and B2 carries its own `outline` (see `SourceFloor.outline`, added for this) because a
 * level below ground is not bound by the mass standing on it. The building's own
 * `outline` and `footprint` stay the pyramid, which is right: everything about street
 * presence reads those, and none of it is true of a tunnel.
 *
 * WHAT CARRIES OVER FROM THE OLD DRAFT, because they were paid for the hard way:
 *
 *  - A pyramid is SQUARE. The 460 x 400 first attempt read as a lopsided wedding cake.
 *  - A stair may not be longer than its climb, or it lies across the summit like a ladder.
 *  - No floor may be left with a piece of itself walled off from everything. The first
 *    interior stranded 100k units² either side of the flight — room inside a solid mass
 *    that a bot could stand in and never reach.
 *  - Two braziers and a stele stacked down a flank will seal a room. Each flank gets ONE
 *    thing in it, or a bank flush against the next thing, never a row with slots in it.
 */

/** The base, square, addressing the plaza to its south. 660 from 520. */
export const PYRAMID = { x: 2980, y: 1820, w: 660, h: 660 };
const CX = PYRAMID.x + PYRAMID.w / 2; // 3310

/** A terrace wall is enormously thick. 40 is the mass reading as mass. */
const SHELL = 40;

/** Inside the terrace wall. Every coordinate on the pyramid's own floors is checked here. */
const IN = {
  w: PYRAMID.x + SHELL, // 3020
  e: PYRAMID.x + PYRAMID.w - SHELL, // 3600
  n: PYRAMID.y + SHELL, // 1860
  s: PYRAMID.y + PYRAMID.h - SHELL, // 2440
};

/**
 * The grand stair: 150 wide, rising the hall's full depth.
 *
 * Wider than Downtown's 88 on purpose. A ceremonial stair is the widest thing in a
 * complex — it takes a procession, not a fitter — and the contract only forbids
 * NARROWING a flight below the proven figure, never widening one. 215 units of open hall
 * either side, so a bot at either end can leave sideways instead of being committed.
 */
const GRAND = { x: CX - 75, y: 2200, w: 150, h: IN.s - 2200 };
/** The cross wall, abutting the stair's head exactly so no slot opens between them. */
const CROSS_Y = GRAND.y - 13;

/**
 * The descent to the crypt, in the tomb chamber's north-west corner.
 *
 * FLUSH with both the west and north shells, and that is not tidiness. Set 40 off the
 * north wall it left a 100 x 40 sliver behind it belonging to nothing — the exact defect
 * that stranded floor either side of the grand stair in the first draft, at a twentieth
 * of the size and just as unreachable.
 *
 * `bottom: "N"` so the flight descends northward and is therefore ENTERED from the south,
 * facing the chamber it serves. Entered from the north its mouth would have been 40 units
 * off the shell, which is less than a bot's diameter — you could only have reached it
 * sideways.
 */
const DESCENT = { x: IN.w, y: IN.n, w: 88, h: 160 };
/** The descent's open flank. Its other side is the shell. */
const DESCENT_GUARD_X = DESCENT.x + DESCENT.w + 6;

/**
 * THE UNDERCROFT's plan: two galleries crossing, and four arms that go somewhere.
 *
 * A cross rather than a warren, and the reason is navigation as much as drawing. A
 * branching maze authored as one closed outline self-intersects the moment it forks
 * twice, and every arm of it is a long journey — which is the thing that actually costs
 * A* (see `replanInterval` in simulation.ts: area is free, journey length is not).
 * Four arms give the level four destinations and one junction to fight over.
 *
 *   NORTH  up under the pyramid, and the shaft from the crypt lands at its head
 *   WEST   out under the ball court
 *   EAST   out under the observatory
 *   SOUTH  the cistern, which is where the water went
 *
 * 240 WIDE, and the arithmetic is worth spelling out because 200 was wrong twice over.
 * The shell centreline is inset by half its thickness and then thickened again, so a
 * gallery loses the FULL shell to each side, not half of it: 200 - 40 - 40 = 120 of
 * corridor, which a 48-wide bot fits down and cannot pass anything in. 240 gives 160.
 */
const ARM = 240;
const CROSS = { x: CX - ARM / 2, y: 2560 }; // the east-west gallery's north edge
const UNDERCROFT: Array<{ x: number; y: number }> = [
  { x: CROSS.x, y: 2100 },
  { x: CROSS.x + ARM, y: 2100 },
  { x: CROSS.x + ARM, y: CROSS.y },
  { x: 3880, y: CROSS.y },
  { x: 3880, y: CROSS.y + ARM },
  { x: CROSS.x + ARM, y: CROSS.y + ARM },
  { x: CROSS.x + ARM, y: 3050 },
  { x: CROSS.x, y: 3050 },
  { x: CROSS.x, y: CROSS.y + ARM },
  { x: 2620, y: CROSS.y + ARM },
  { x: 2620, y: CROSS.y },
  { x: CROSS.x, y: CROSS.y },
];

/**
 * The shaft from the crypt to the undercroft, at the head of the north arm.
 *
 * AT THE ARM'S TERMINUS, not partway along it, and that is the whole reason it works.
 * The arm is 160 of walkable width and the shaft is 88, which leaves 36 either side —
 * less than a bot. Anywhere along the arm the shaft would therefore SEVER it, because
 * the only way past would be across a flight, and crossing a flight changes floor. At the
 * head there is nothing beyond it to cut off.
 */
const SHAFT = { x: CX - 44, y: 2148, w: 88, h: 150 };

/**
 * The crypt's two aisle walls, and their spacing is a lane count rather than a look.
 *
 * They started 140 and 120 off the shells, which made each cell exactly as wide as the
 * sarcophagi in it — a 108-wide corridor with 108-wide tombs plugging it at two points.
 * A cell you cannot walk past the furniture in is a cupboard. 160 from each shell, tombs
 * at 90, so every cell keeps a 58-unit lane and the nave still holds 236.
 */
const AISLE_W = IN.w + 160; // 3180
const AISLE_E = IN.e - 160; // 3440

export const GREAT_TEMPLE_SOURCE: SourceBuilding = {
  id: "temple",
  kind: "monument",
  name: "GREAT TEMPLE",
  shellThickness: SHELL,
  outline: { shape: "rect", ...PYRAMID },
  stairs: [
    {
      id: "temple-grand-stair",
      rect: GRAND,
      from: "GROUND",
      to: "ROOF",
      bottom: "S",
      /**
       * Freestanding: the flight stands in the middle of the hall with 215 units of floor
       * either side, so the dashed half gets balustrades and a far-end cap while the entry
       * half stays open at its foot and along both flanks.
       */
      access: "openEnd",
    },
    {
      id: "temple-descent",
      rect: DESCENT,
      from: "GROUND",
      to: "B1",
      bottom: "N",
      // No `access`. Derived guards wall the exit half on BOTH long sides plus its far
      // cap, and this flight has the shell hard against one side already — the
      // observatory proved what that does twice over, sealing the flight and stranding
      // 17,216 then 10,560 units of floor. One authored wall down the open flank instead,
      // on both floors, which is what every stair in the city actually is.
    },
    {
      id: "temple-shaft",
      rect: SHAFT,
      from: "B1",
      to: "B2",
      bottom: "S",
      // Same reasoning, and here the undercroft's own gallery walls are the guards: 36
      // units of rock either side is closer than any rail. Only the crypt end needs
      // authored flanks, because up there the shaft stands in an open nave.
    },
  ],
  floors: [
    {
      label: "ROOF",
      brief: {
        purpose: "The summit: the shrine cell, and the one commanding position over the whole precinct.",
        zones: ["the stair head", "the shrine cell", "the platform ring"],
        sequence: "Off the flight onto the platform, north to the cell door, in.",
        adjacency: "The cell stands clear of the parapet on all four sides so the platform is a ring you can circle — which is what makes holding the summit a matter of position rather than of standing on a spot.",
        negativeSpace: "The platform ring itself. It is the region's whole sightline and there is exactly one way down.",
      },
      walls: [
        {
          /**
           * The shrine cell: a closed box with its door facing the stair head.
           *
           * Its walls are the reason a summit is worth reaching — the only cover up here.
           * The door is 60 units north of the flight's own end rather than on it, so
           * arriving and entering are two decisions instead of one.
           */
          id: "temple-shrine",
          thickness: 22,
          closed: true,
          path: [
            { x: 3180, y: 1940 },
            { x: 3440, y: 1940 },
            { x: 3440, y: 2140 },
            { x: 3180, y: 2140 },
          ],
          openings: [{ kind: "door", width: 76, near: { x: CX, y: 2140 } }],
        },
      ],
      objects: [
        { id: "temple-high-altar", kind: "altar", x: 3250, y: 1990, w: 120, h: 60 },
        /**
         * The summit braziers, FLUSH with the parapet.
         *
         * At 30 units off it they left a slot nothing could use and 163 to the flight; at
         * the old pyramid's scale they were 33 off the flight, which the audit called
         * `blocked-stair-side` and was right to — a bot leaving a stair head sideways
         * needs 48, and the summit is the one place on the map where being unable to step
         * off a flight is fatal.
         */
        { id: "temple-high-brazier-w", kind: "brazier", x: IN.w, y: 2280, w: 52, h: 52 },
        { id: "temple-high-brazier-e", kind: "brazier", x: IN.e - 52, y: 2280, w: 52, h: 52 },
      ],
      dots: [
        { id: "temple-dot-roof", item: { kind: "powerup", type: "dashOvercharge" }, x: CX, y: 2360 },
        // Inside the cell, 39 units off its west wall. At x 3210 it was 19 off — a Dot in
        // a wall, because a 22-thick wall centred on 3180 has its inner face at 3191 and a
        // bot needs 24.
        { id: "temple-dot-shrine", item: { kind: "powerup", type: "health" }, x: 3230, y: 2095 },
      ],
    },
    {
      label: "GROUND",
      brief: {
        purpose: "The substructure: the hall at the stair's foot, the tomb chamber behind it, and the way down.",
        zones: ["the entrance hall", "the stair's foot", "the tomb chamber", "the north arch", "the descent"],
        sequence: "In off the plaza through the south arch into the hall, then a choice — straight up the flight to the shrine, or through one of the cross-wall doors into the chamber, and from there either out the north arch onto the blind face or down into the crypt.",
        adjacency: "The chamber sits behind the hall with TWO doors between them rather than one. One door made the whole chamber holdable by a single bot standing in it, which is a good room and a bad route: everything below ground is behind this floor, so it cannot have a single point of failure.",
        negativeSpace: "The stair's foot and the full width of the hall in front of it. It is the one place inside the mass that everything on the summit can see down onto.",
      },
      shellOpenings: [
        // The stair's own mouth, on the plaza face.
        { kind: "archway", width: 152, near: { x: CX, y: PYRAMID.y + PYRAMID.h } },
        /**
         * The way out of the chamber, on the blind north face.
         *
         * Near the axis rather than west of it, because west of centre puts it against the
         * descent: at x CX - 170 the arch's west jamb opened straight onto the stair well,
         * so 16 units of a 96-wide opening were a flight of stairs.
         */
        { kind: "archway", width: 96, near: { x: CX - 60, y: PYRAMID.y } },
      ],
      walls: [
        {
          /**
           * The cross wall, hall to chamber, the full width of the base with TWO doors.
           *
           * It stops exactly where the stair's head begins, so there is no 13-unit slot
           * between the two for a bot to wedge in and no pocket of floor belonging to
           * neither.
           */
          id: "temple-cross",
          thickness: 26,
          path: [{ x: IN.w, y: CROSS_Y }, { x: IN.e, y: CROSS_Y }],
          openings: [
            { kind: "door", width: 84, near: { x: 3110, y: CROSS_Y } },
            { kind: "door", width: 84, near: { x: 3500, y: CROSS_Y } },
          ],
        },
        {
          // The descent's open flank, so you cannot step onto the flight sideways out of
          // the chamber. The shell closes its other side. See the note on the stair.
          id: "temple-descent-guard",
          thickness: 12,
          path: [{ x: DESCENT_GUARD_X, y: DESCENT.y }, { x: DESCENT_GUARD_X, y: DESCENT.y + DESCENT.h }],
        },
      ],
      objects: [
        /**
         * ONE object in each flank of the hall, hard against the terrace wall.
         *
         * A stele and a brazier stacked down each flank looked better and sealed the
         * chamber: they left 40 units to the shell and 61 to the flight against a 48-wide
         * bot, so the cross-wall door opened onto a slot nobody could walk out of, and the
         * whole chamber came back unreachable.
         */
        { id: "temple-hall-brazier-w", kind: "brazier", x: 3070, y: 2300, w: 48, h: 48 },
        { id: "temple-hall-brazier-e", kind: "brazier", x: 3482, y: 2300, w: 48, h: 48 },

        /**
         * The chamber's one bank: the sarcophagus with a carved panel FLUSH at each end.
         *
         * Flush rather than spaced, which is the rule the whole map is now authored to —
         * "the aisle rule wants a real one or none." A panel 11 units off the tomb is a
         * gap nothing can use; 44 units off it is an aisle a bot half fits down. Together
         * they are one 258-wide mass with 61 units of lane west of it and 111 east.
         */
        { id: "temple-panel-w", kind: "stele", x: 3181, y: 1986, w: 44, h: 72 },
        { id: "temple-tomb", kind: "altar", x: 3225, y: 1980, w: 170, h: 84 },
        { id: "temple-panel-e", kind: "stele", x: 3395, y: 1986, w: 44, h: 72 },
        // The cold braziers, flush with the east shell so the lane past the bank holds.
        { id: "temple-brazier-n", kind: "brazier", x: IN.e - 50, y: 1900, w: 50, h: 50 },
        { id: "temple-brazier-s", kind: "brazier", x: IN.e - 50, y: 2060, w: 50, h: 50 },
      ],
      dots: [
        { id: "temple-dot-hall", item: { kind: "powerup", type: "incognito" }, x: CX, y: 2380 },
        { id: "temple-dot-tomb", item: { kind: "powerup", type: "radar" }, x: 3300, y: 1900 },
      ],
    },
    {
      label: "B1",
      brief: {
        purpose: "The crypt: a nave down the middle with burial cells behind a door in each aisle.",
        zones: ["the nave", "the west cell", "the east cell", "the shaft head", "the descent's foot"],
        sequence: "Down from the tomb chamber into the north-west corner, east into the nave, and from there a door into either aisle or the shaft down into the undercroft.",
        adjacency: "Both cells are behind ONE door each and neither is on the route down. That is the point of a crypt: everything of value is off the path, and taking it means turning your back on the only way out.",
        negativeSpace: "The nave. It runs the full depth of the pyramid with the shaft in the middle of it, and it is the only ground on this level with more than one way off it.",
      },
      walls: [
        {
          /**
           * The west aisle wall, starting 100 units clear of the descent's foot.
           *
           * It began at y 2060, which is 40 below the flight's own end — and 40 is less
           * than a bot's 48 diameter, so the only route off the stairs was a gap nothing
           * fitted through. The audit put it plainly: 10,048 square units of the crypt
           * disconnected from its own arrival route, and the flight itself unreachable
           * from the floor it serves.
           */
          id: "temple-crypt-aisle-w",
          thickness: 24,
          path: [{ x: AISLE_W, y: 2120 }, { x: AISLE_W, y: IN.s }],
          openings: [{ kind: "door", width: 84, near: { x: AISLE_W, y: 2200 } }],
        },
        {
          id: "temple-crypt-aisle-e",
          thickness: 24,
          path: [{ x: AISLE_E, y: 1900 }, { x: AISLE_E, y: IN.s }],
          openings: [{ kind: "door", width: 84, near: { x: AISLE_E, y: 2150 } }],
        },
        // The shaft's two flanks. Both, because up here it stands in open nave — 102 units
        // of floor on one side and 114 on the other, which is walk-on width.
        {
          id: "temple-shaft-guard-w",
          thickness: 12,
          path: [{ x: SHAFT.x - 6, y: SHAFT.y }, { x: SHAFT.x - 6, y: SHAFT.y + SHAFT.h }],
        },
        {
          id: "temple-shaft-guard-e",
          thickness: 12,
          path: [{ x: SHAFT.x + SHAFT.w + 6, y: SHAFT.y }, { x: SHAFT.x + SHAFT.w + 6, y: SHAFT.y + SHAFT.h }],
        },
        {
          // The descent's flank again, one floor down. A guard that exists on one floor
          // only is a flight you can step onto sideways at the bottom.
          id: "temple-descent-guard-b1",
          thickness: 12,
          path: [{ x: DESCENT_GUARD_X, y: DESCENT.y }, { x: DESCENT_GUARD_X, y: DESCENT.y + DESCENT.h }],
        },
      ],
      objects: [
        /**
         * The west cell: two sarcophagi flush with the shell, and the shelf of urns flush
         * under the second of them.
         *
         * FLUSH, and 90 wide rather than the cell's full 148, so a bot can walk the length
         * of the cell past both. The shelf is joined to the tomb rather than set 26 below
         * it, which the audit calls a `false-aisle` and is right to: 26 units is a gap that
         * looks like a way through and is not.
         */
        { id: "temple-crypt-tomb-w1", kind: "altar", x: IN.w, y: 2120, w: 90, h: 54 },
        { id: "temple-crypt-tomb-w2", kind: "altar", x: IN.w, y: 2300, w: 90, h: 54 },
        { id: "temple-crypt-shelf-w", kind: "shelf", x: IN.w, y: 2354, w: 90, h: 28 },
        // The east cell, the same rule mirrored.
        { id: "temple-crypt-tomb-e1", kind: "altar", x: IN.e - 90, y: 1960, w: 90, h: 54 },
        { id: "temple-crypt-tomb-e2", kind: "altar", x: IN.e - 90, y: 2280, w: 90, h: 54 },
        { id: "temple-crypt-shelf-e", kind: "shelf", x: IN.e - 28, y: 2060, w: 28, h: 120 },
        // The nave: one mark at each end of the shaft's axis, both well clear of the lanes
        // past the flight. The stele is the crypt's scannable — a blueprint down here is
        // worth the walk back up.
        { id: "temple-crypt-brazier-n", kind: "brazier", x: 3200, y: 1880, w: 48, h: 48 },
        { id: "temple-crypt-brazier-s", kind: "brazier", x: 3370, y: 2360, w: 48, h: 48 },
        { id: "temple-crypt-stele", kind: "stele", x: 3340, y: 1880, w: 44, h: 74, scannable: true },
      ],
      dots: [
        { id: "temple-dot-crypt-w", item: { kind: "powerup", type: "health" }, x: 3100, y: 2230 },
        { id: "temple-dot-crypt-e", item: { kind: "powerup", type: "dashOvercharge" }, x: 3500, y: 2150 },
      ],
    },
    {
      label: "B2",
      /**
       * The undercroft carries its own outline — the cross of galleries, which runs out
       * from under the pyramid, under the plaza, and past both ends of the precinct.
       */
      outline: { shape: "polygon", points: UNDERCROFT },
      brief: {
        purpose: "The undercroft: two galleries crossing under the precinct, and the four places they go.",
        zones: ["the junction", "the north arm to the shaft", "the west arm under the ball court", "the east arm under the observatory", "the cistern south"],
        sequence: "Down the shaft into the head of the north arm, south to the junction, and then it is a choice of three. Nothing down here is a loop — every arm is a commitment.",
        adjacency: "The junction is the only ground with four ways off it, so it is the only place worth holding and the only place you cannot be cornered. Everything else is a corridor 160 wide.",
        negativeSpace: "The junction itself, and the length of the galleries. 1260 units of straight gallery is the longest sightline in the world after the plaza — and unlike the plaza there is nowhere at all to step aside.",
      },
      objects: [
        /**
         * FALLEN ROCK, on the arms rather than at the junction.
         *
         * A boulder in a 160-wide gallery leaves 60 to 80 units of lane, which is a squeeze
         * a bot fits through and cannot fight through — that is the point of putting them
         * on the arms and not in the one room with four exits.
         *
         * They are `boulder` and `thicket`'s own kind of collider, an inscribed stadium, so
         * what stops you is exactly the mass drawn. That was reported from play the other
         * way round at this very region: "despite being only my core, I cannot pass through
         * this gap." The gap was two corners of undergrowth with nothing drawn in them.
         */
        /**
         * THE ARITHMETIC EVERY ONE OF THESE IS PLACED BY, because getting it wrong sealed
         * the level twice and the mistake is not obvious.
         *
         * The galleries are 160 of clear corridor — 2600..2760 across, 3230..3390 up and
         * down. What matters is not whether an obstacle FITS but how much room is left for
         * a bot's CENTRE, and that costs the bot's whole diameter, not its radius:
         *
         *     centre freedom = 160 − (the obstacle) − 48
         *
         * So a 70-wide rock flush with a wall leaves 42, which is fine, and two obstacles
         * that overlap even diagonally do not add up — they multiply. A rock at y 2400 and
         * a brazier at 2480 each left a comfortable lane and TOGETHER left 12 units, which
         * severed the whole level from its own stair: 124,288 square units of gallery
         * reachable only by walking through stone.
         *
         * Hence the rules here. Everything is flush with a wall, alternate walls down the
         * gallery, and never two things within a bot's diameter of the same station.
         */
        { id: "temple-under-shelf-w", kind: "shelf", x: 2680, y: 2600, w: 120, h: 28 },
        { id: "temple-under-rock-w1", kind: "boulder", x: 2900, y: 2682, w: 88, h: 78 },
        { id: "temple-under-rock-w2", kind: "boulder", x: 3060, y: 2600, w: 74, h: 66 },
        { id: "temple-under-altar-e", kind: "altar", x: 3560, y: 2600, w: 108, h: 54 },
        { id: "temple-under-shelf-e", kind: "shelf", x: 3560, y: 2732, w: 108, h: 28 },
        { id: "temple-under-rock-e1", kind: "boulder", x: 3720, y: 2688, w: 82, h: 72 },
        // The north arm: 160 units of clear y between these two, which is what the first
        // pass did not leave.
        { id: "temple-under-rock-n", kind: "boulder", x: 3230, y: 2320, w: 70, h: 64 },
        { id: "temple-under-brazier-j", kind: "brazier", x: 3330, y: 2480, w: 48, h: 48 },

        /**
         * The cistern, and it is the one thing down here allowed to plug a gallery.
         *
         * Standing water in a stone tank at the very end of the south arm — the one object
         * that says what the tunnels were FOR. A `waterTank` is a ROUND kind, so its
         * collider is a disc of its short side, and a 96 disc flush against one wall of a
         * 160 gallery leaves 16 units of centre freedom past it. That is a plug.
         *
         * Which is fine HERE and nowhere else, because it is flush with the arm's end wall:
         * there is nothing on the far side of it to cut off. Set 54 units short of the end
         * it stranded a 54 x 160 pocket behind itself.
         */
        { id: "temple-cistern", kind: "waterTank", x: 3230, y: 2914, w: 96, h: 96 },
      ],
      dots: [
        { id: "temple-dot-under-w", item: { kind: "powerup", type: "radar" }, x: 2700, y: 2680 },
        { id: "temple-dot-under-e", item: { kind: "powerup", type: "incognito" }, x: 3560, y: 2680 },
        { id: "temple-dot-under-s", item: { kind: "powerup", type: "health" }, x: CX, y: 2820 },
      ],
    },
  ],
};

export const greatTemple = compileBuilding(GREAT_TEMPLE_SOURCE);
