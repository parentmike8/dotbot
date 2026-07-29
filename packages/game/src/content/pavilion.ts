import { compileBuilding, type SourceBuilding } from "../mapSource";
import { radial } from "./regionKit";

/**
 * The Grand Pavilion — the fairground's dance hall, and the one building on the site.
 *
 * Octagonal, because that is what a pleasure pavilion is: a round room under a
 * single-span roof, entered from whichever side the crowd came from. Eight sides give
 * it four entrances on the cardinals and four blind faces between them, which is a
 * genuinely different tactical shape from anything in Downtown — there is no back of
 * this building, so there is no safe approach to it either.
 *
 * Two floors. The hall below is one big room, which is the point of a hall; the
 * gallery above is a ring of small rooms round the void, which is the point of a
 * gallery. A player who takes the stair is above everyone in the hall and can be
 * reached from four directions at once.
 */

/**
 * The hall's centre, on the fair's drive so the building addresses the way in.
 *
 * It is on the drive rather than out along the midway for a reason the city audit
 * states as a rule: every road carries frontage, and a drive that arrives at nothing is
 * a road to nowhere. The pavilion IS what the drive arrives at — you come off Third Ave
 * and the hall is straight ahead — and the midway then runs west from it, so the whole
 * fair is entered THROUGH its one building.
 */
export const HALL = { x: 1760, y: 1990 };
const RADIUS = 300;

/** The eight corners of the plan, flat-topped so the entrances land on the cardinals. */
const CORNERS = Array.from({ length: 8 }, (_, i) => radial(HALL, (Math.PI * 2 * i) / 8 + Math.PI / 8, RADIUS));

export const PAVILION_SOURCE: SourceBuilding = {
  id: "pavilion",
  kind: "retail",
  name: "GRAND PAVILION",
  shellThickness: 18,
  outline: { shape: "polygon", points: CORNERS },
  stairs: [{
    /**
     * The stair up to the gallery, against the south-east wall.
     *
     * Off-centre deliberately. A stair in the middle of a hall would split the one
     * thing the hall is for — the floor — and the audit rule that catches furniture
     * doing that (`wedged-fixture`) is describing the same mistake.
     *
     * But not as far off-centre as the first attempt, which put its south-east corner at
     * r 296 on a plan whose corner radius is 282 — the flight stuck out through the wall,
     * and what the audit reported was a stair you could not walk onto. In a polygon the
     * only safe check is the radius at each of the rect's four corners.
     */
    id: "pavilion-stair",
    rect: { x: HALL.x + 20, y: HALL.y + 70, w: 88, h: 160 },
    from: "GROUND",
    to: "F1",
    bottom: "N",
  }],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "The dance floor: one room, entered from four sides, with the bar and the band at the ends of it.",
        zones: ["the floor", "the bandstand north", "the bar west", "the stair corner south-east"],
        sequence: "In off the midway at any cardinal, across the floor, out the far side. Nobody stops in the middle.",
        adjacency: "Bar backs a blind wall so its whole length is servable; the bandstand faces the floor and blocks nothing.",
        negativeSpace: "The centre of the floor is left completely open — it is the room's purpose, and with four doors on it, it is the most exposed ground in the region.",
      },
      shellOpenings: [
        // Four entrances on the cardinals: the crowd came from every direction.
        { kind: "archway", width: 110, near: { x: HALL.x, y: HALL.y - RADIUS } },
        { kind: "archway", width: 110, near: { x: HALL.x, y: HALL.y + RADIUS } },
        { kind: "archway", width: 110, near: { x: HALL.x - RADIUS, y: HALL.y } },
        { kind: "archway", width: 110, near: { x: HALL.x + RADIUS, y: HALL.y } },
        // Glazing on the blind faces between them, which is where a pavilion's
        // clerestory really goes.
        { kind: "window", width: 96, near: radial(HALL, Math.PI * 1.25, RADIUS) },
        { kind: "window", width: 96, near: radial(HALL, Math.PI * 1.75, RADIUS) },
      ],
      /**
       * EVERY COORDINATE IN HERE IS CHECKED AGAINST THE OCTAGON, NOT AGAINST A BOX.
       *
       * The usable floor is the eight-sided plan inset by the shell: 259 units to an edge
       * midpoint, 282 to a corner. Placing furniture against `footprint.x` — the bounding
       * box — puts it 20 units outside the wall on every diagonal face, which is what the
       * first pass did to the bar, the shelf and the fridge all at once.
       */
      objects: [
        // The bandstand: a raised deck against the north face, facing the floor. 180 wide,
        // not 220: at 220 its west end left a 50-unit slot to the north-west facet, which
        // sealed that corner of the hall off from the rest of the floor.
        { id: "pav-stage", kind: "planningTable", x: HALL.x - 90, y: HALL.y - 234, w: 180, h: 60, facing: "S", scannable: true },
        /**
         * The bar down the west facet: back-bar, counter and cooler as ONE continuous bank.
         *
         * Every gap in this run is 0 or 16, on purpose. A shelf 8 units behind a counter is
         * `parallel-banks` — two fixture faces with no work aisle between them — and a
         * cooler 6 units off the end of a bench is `wedged-fixture`, which is the same
         * mistake at the other end of the run. Touching, they are one fitting.
         */
        { id: "pav-bar", kind: "counter", x: HALL.x - 216, y: HALL.y - 90, w: 40, h: 180, facing: "E" },
        { id: "pav-shelf", kind: "shelf", x: HALL.x - 240, y: HALL.y - 60, w: 24, h: 120 },
        { id: "pav-fridge", kind: "fridge", x: HALL.x - 216, y: HALL.y + 90, w: 44, h: 44, facing: "E" },
        /**
         * ONE long bench down the east facet, not two with a seam.
         *
         * Two 120-unit benches 12 apart still cut the 63-unit strip behind them into pockets
         * a bot could see and not reach: the seam was too narrow to walk through and each
         * end was the only way round. A single 220 bench has two open ends and no seam.
         */
        { id: "pav-bench-a", kind: "bench", x: HALL.x + 140, y: HALL.y - 110, w: 26, h: 220, facing: "W" },
        { id: "pav-bench-c", kind: "bench", x: HALL.x - 60, y: HALL.y + 190, w: 130, h: 26, facing: "N" },
        /**
         * FIVE fixtures, all of them against a wall, and no table in the middle.
         *
         * Ten were authored first. Two overlapped each other, one stood in the stair, and
         * the loose table in the floor forced the east bench out to within 63 units of the
         * facet behind it — which tapers, so the strip behind the bench closed. The brief
         * says the centre of the floor is the room's purpose. Five fixtures is what a hall
         * cleared for dancing has in it, and it is what the plan can hold.
         */
      ],
      dots: [
        { id: "pav-dot-a", item: { kind: "powerup", type: "health" }, x: HALL.x - 110, y: HALL.y + 60 },
        { id: "pav-dot-b", item: { kind: "powerup", type: "dashOvercharge" }, x: HALL.x - 60, y: HALL.y - 130 },
      ],
    },
    {
      label: "F1",
      brief: {
        purpose: "The gallery ring: private boxes overlooking the floor, and the projection room.",
        zones: ["the box ring", "the projection room north", "the stair head south-east"],
        sequence: "Up the stair, round the ring past the boxes, into the projection room.",
        adjacency: "The projection room sits over the bandstand so its window looks down the hall's long axis.",
        negativeSpace: "The ring itself is the circulation and it is narrow on purpose — a fight up here has nowhere to spread out.",
      },
      walls: [
        {
          /**
           * ONE wall across the ring, separating the projection room from the gallery.
           *
           * Four radial spurs off the shell were tried first — one per box — and they were
           * the wrong primitive for an octagon. A spur reaching 280 units from the centre
           * lands past the shell on a facet and short of it at a corner, so two ended up
           * buried in the wall, one ran through a couch, and the nook behind the north-west
           * spur became floor nobody could reach. A chord runs wall to wall and has a door
           * in it, which is what a partition is.
           *
           * Its ends run INTO the shell rather than stopping near it: a wall that stops 26
           * short leaves a slot too narrow to walk and too wide to read as closed.
           */
          id: "pav-gallery-screen",
          thickness: 12,
          path: [{ x: HALL.x - 240, y: HALL.y - 130 }, { x: HALL.x + 240, y: HALL.y - 130 }],
          openings: [{ kind: "door", width: 76, near: { x: HALL.x, y: HALL.y - 130 } }],
        },
      ],
      objects: [
        // The projection room, north of the screen and looking down the hall's long axis.
        // The desk is attached to the projector's west end, because a 22-unit slot between
        // two fixtures is neither a seam nor an aisle.
        /**
         * Projector and desk as one bank against the north facet, EAST of centre.
         *
         * Three positions and two lessons. West of the projector, the desk left 22 units to
         * the north-west facet and cut that corner off — a projection room narrows to
         * nothing at a corner, so nothing may stand near one. Then, further south, the pair
         * left a 46-unit strip between themselves and the gallery screen, which is 2 short
         * of a bot, and the room's whole west half went unreachable. They sit hard against
         * the north wall now, with 62 units of floor along the screen.
         *
         * The reel shelf that used to complete the bank is gone: at the only x where it did
         * not pinch that strip it was 2 units outside the north-east facet.
         */
        { id: "pav-projector", kind: "listeningPost", x: HALL.x - 46, y: HALL.y - 250, w: 92, h: 52, facing: "S", scannable: true },
        { id: "pav-proj-desk", kind: "desk", x: HALL.x + 46, y: HALL.y - 250, w: 92, h: 44, facing: "S" },
        // The gallery: a couch against each facet that faces one end of the hall below.
        { id: "pav-couch-w", kind: "couch", x: HALL.x - 240, y: HALL.y - 60, w: 40, h: 120, facing: "E" },
        { id: "pav-couch-e", kind: "couch", x: HALL.x + 200, y: HALL.y - 60, w: 40, h: 120, facing: "W" },
        { id: "pav-locker", kind: "locker", x: HALL.x - 170, y: HALL.y + 110, w: 30, h: 40, facing: "E" },
        { id: "pav-chair-a", kind: "chair", x: HALL.x - 100, y: HALL.y + 186, w: 32, h: 30, facing: "N" },
      ],
      /**
       * Out in the ring, NOT tucked into the box seating.
       *
       * Both of these were authored inside a couch, and the consequence was worse than a
       * Dot nobody could reach: `addBlueprintSpawns` floods a floor from its first Dot, so
       * a seed inside a solid made the ENTIRE gallery unreachable and every blueprint on it
       * failed to place. A Dot in a collider can take a floor's whole validation down.
       */
      dots: [
        { id: "pav-dot-c", item: { kind: "powerup", type: "incognito" }, x: HALL.x - 100, y: HALL.y + 10 },
        { id: "pav-dot-d", item: { kind: "powerup", type: "radar" }, x: HALL.x + 110, y: HALL.y + 10 },
      ],
    },
  ],
};

export const pavilion = compileBuilding(PAVILION_SOURCE);
