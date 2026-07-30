// `geometry` imports only `math` and `types`, so this cannot close a cycle.
import { polygonContains } from "./geometry";
import { OUTDOOR_FLOOR_ID } from "./types";
import type {
  Building,
  DoorEntity,
  Doorway,
  FloorLabel,
  FloorPlan,
  MapDocument,
  MapObject,
  ObjectKind,
  Rect,
  StairLink,
  Vec2,
  WallSegment,
} from "./types";

export const DOOR_COLLISION_DEPTH = 16;

export function doorRuntimeId(floorId: string, doorwayId: string): string {
  return `${floorId}:${doorwayId}`;
}

/** The moving leaf occupies the wall gap only while the authoritative door
 * state says it is blocking. Visual frames and prediction reuse this shape. */
export function doorwayCollisionRect(doorway: Pick<Doorway, "x" | "y" | "width" | "dir">): Rect {
  return doorway.dir === "h"
    ? { x: doorway.x - doorway.width / 2, y: doorway.y - DOOR_COLLISION_DEPTH / 2, w: doorway.width, h: DOOR_COLLISION_DEPTH }
    : { x: doorway.x - DOOR_COLLISION_DEPTH / 2, y: doorway.y - doorway.width / 2, w: DOOR_COLLISION_DEPTH, h: doorway.width };
}

export function doorEntityCollisionRect(door: DoorEntity): Rect {
  return doorwayCollisionRect({ x: door.position.x, y: door.position.y, width: door.width, dir: door.dir });
}

/**
 * Object kinds that get physics colliders unless the object overrides `solid`.
 *
 * The rule is the contract's: silhouette == footprint == collider, with
 * `FLAT_KINDS` as the only sanctioned exception. If a kind is drawn as a volume
 * with a cast shadow it belongs here, because walking through it is the map lying
 * to the player about what is cover.
 *
 * Street furniture used to be missing from this list, and closing that gap was a
 * map pass rather than a list edit: the streets and rooms had been composed around
 * these being ghosts. It took seven repairs, and the pattern in all seven is worth
 * remembering — every one was an object standing in a doorway, an entrance
 * approach, or the only route through a room. Those are the places a collider
 * matters and a decoration does not, so those are the places a ghost hides a bug.
 */
const SOLID_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "bed",
  "cot",
  "cabinet",
  "medicalCabinet",
  "desk",
  "table",
  "conferenceTable",
  "counter",
  "receptionDesk",
  "serverRack",
  "shelf",
  "produceDisplay",
  "filingCabinet",
  "locker",
  "crateStack",
  "workbench",
  "toolCabinet",
  "generator",
  "vending",
  "fridge",
  "couch",
  "kiosk",
  "car",
  "hvac",
  "planter",
  "stove",
  "column",
  "fabricator",
  "bayConsole",
  "planningTable",
  "draftingTable",
  "repairBench",
  "listeningPost",
  "signalMast",
  /**
   * The contract's rule is silhouette == footprint == collider, and `FLAT_KINDS`
   * is its only sanctioned exception. Each of these is drawn as a volume with a
   * cast shadow, so leaving it passable is the map lying to the player about what
   * is cover — the single most common complaint about the exterior.
   *
   * Landing the promotion took seven repairs, every one a real authoring bug the
   * ghosts had been hiding. They are commented at each site; the pattern worth
   * remembering is that all seven were objects standing in a doorway, an entrance
   * approach, or the only route through a room — the places a collider matters and
   * a decoration does not.
   */
  "tree",
  "bench",
  "bikeRack",
  "drum",
  "dumpster",
  "hydrant",
  "lampPost",
  /**
   * The interior half of the same promotion, and the same reasoning: you do not walk
   * through a chair.
   *
   * The earlier plan was the other way round — redraw these in a "passable"
   * vocabulary so a lighter outline would tell the player they could walk through.
   * Rejected on the evidence of looking at it: at play zoom a fainter outline is not
   * legible, and the objects it was describing are ones nobody expects to pass
   * through anyway. Passability is now RARE and loud rather than common and subtle —
   * `FLAT_KINDS` is the whole of it, those are floor coverings, and they are drawn
   * flat with no lift and no shadow precisely so you can see the floor through them.
   *
   * A cast shadow is the promise. Every kind here was drawn as a lifted volume
   * throwing a shadow onto the slab while a bot walked straight through it, which is
   * the map lying about what is cover.
   */
  // A post in the ground, so it stops a body like any other post.
  "sign",
  "sink",
  "toilet",
  "coffeeStation",
  "washer",
  "medicalCart",
  "ivStand",
  /**
   * A steel cabinet bolted to a wall, and a pot plant. Six repairs between them, and
   * every one was a decoration holding a route open:
   *
   * - Civic's mail room sat its power box 12 units off the north wall, leaving a
   *   44-unit slot to the sorting counter — narrower than a bot — so the moment the
   *   box became solid the room sealed itself away from its own lockers.
   * - Civic's F7 plant deck had its power box free-standing in the 90-unit gap
   *   between the HVAC pair and the generator; splitting that into 20 and 44 turned
   *   the machine row into a wall across the floor, cutting the bench, the tool
   *   cabinet and both Dots off from the stair cores.
   * - A lobby plant stood inside the tower's own front door, in the very space that
   *   floor's brief reserves — "the lobby floor between the entrance and the shaft
   *   stays completely clear" — and left the lounge couch with no side to put a
   *   blueprint on.
   * - An office plant clipped its own office threshold; a clinic plant stood in the
   *   staff entrance; an F6 plant sat 17 units from a Dot, which is inside a bot
   *   radius, so the Dot was somewhere you could see and not stand.
   *
   * Which is the street-furniture pattern again, exactly: a ghost is invisible
   * precisely where a collider would have mattered.
   */
  "utilityBox",
  "plant",
  /**
   * The last one, and the one everybody assumed would be worst. Six repairs, and
   * four of them were a chair tucked *into* the furniture it belongs to — an overlap
   * the instant it collides. Nudged flush instead: touching reads as pushed in, and
   * two solids sharing an edge is one piece of furniture rather than a contradiction.
   *
   * The two that were not overlaps were rooms a stool quietly sealed. Both clinic
   * exam rooms left 42 units between bed and stool, six short of a bot, so the north
   * half of each room — including the bed a blueprint had to go beside — was cut off
   * from its own door. Civic's workshop was the same shape one floor up: stools 16
   * units off their benches left a 42-unit aisle to the bench opposite, which both
   * sealed the floor's west end and tripped `wedged-fixture`, the rule written for
   * exactly that gap. Every one of the six is a stool put where nobody would leave a
   * stool, and it took a collider to notice.
   *
   * A note on chairs and rugs, because it looks alarming and is not: six chairs sit
   * on rugs, which is what chairs do. `rug` is in `FLAT_KINDS`, so it has no collider
   * to overlap.
   */
  "chair",
  /**
   * Landmarks, and the default is the same as everywhere else: what looks solid is
   * solid. Each of these is drawn as a mass with a cast shadow, so each collides.
   *
   * The two exceptions are in `FLAT_KINDS` and both are ground you walk on — track
   * and a turntable deck. Nothing else is excepted, and in particular no attraction
   * is: a ride you can walk through the middle of is the same lie as a ghost tree.
   * Where a glyph does not fill its box the fix is a collider that matches the
   * glyph — see `ROUND_KINDS` and `STADIUM_KINDS` — never a pass through the mass.
   */
  "boulder",
  "thicket",
  "log",
  "wagon",
  "bufferStop",
  "waterTank",
  "coalingTower",
  "carousel",
  "swingRide",
  "waltzer",
  "helterSkelter",
  "bigTop",
  "stele",
  "altar",
  "serpentHead",
  "brazier",
]);

/**
 * Two Dots closer than this are one pickup, not two decisions.
 *
 * A Dot is radius 10 and a bot radius 24, so anything inside a bot diameter gets
 * collected in the same step and the second one might as well not be there. 64 is
 * the same figure as `MIN_COMFORTABLE_AISLE`: far enough apart that walking to one
 * rather than the other is a choice.
 */
export const MIN_DOT_SEPARATION = 64;

/** Floor coverings: drawn flat, never collide, never drawn over furniture. */
export const FLAT_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "parkingStall", "pallet", "rug", "skylight", "vent",
  /**
   * Rail. Both are ground: you walk along track and you walk across a turntable
   * deck, and a rail standing 8mm out of the ballast is not cover for anybody.
   *
   * Track is also the one kind here that is genuinely *long* — a siding runs the
   * width of a region — which is the other reason it has to be flat. As a collider
   * it would fence the yard into strips.
   */
  "track", "turntable",
]);

/**
 * The flat kinds that are SURFACE rather than fixture — paint and floor covering.
 *
 * This is a drawing distinction, not a physics one, and it earns its place by being on
 * a different axis from everything above. Whether a bot can walk through something is
 * `isSolidObject`, and the renderer's see-through-and-washed treatment is derived from
 * that predicate alone so the two can never disagree again. But paint on tarmac and a
 * rug on a slab cannot be MISTAKEN for cover in the first place, so washing them out
 * would only bleach a deliberate accent and fade lines that are already just lines.
 *
 * So: everything non-solid is marked, except the things drawn as the ground itself.
 */
export const SURFACE_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "parkingStall", "rug",
  // Drawn as the ground itself, so washing them out would fade the ballast rather
  // than warn anyone about anything.
  "track", "turntable",
]);

export function isSolidObject(object: MapObject): boolean {
  return object.solid ?? SOLID_KINDS.has(object.kind);
}

/** Visible contracts-table surface; its chairs are intentionally walk-through. */
export function planningTableSurfaceRect(object: Pick<MapObject, "x" | "y" | "w" | "h">): Rect {
  const chair = Math.min(30, Math.max(26, Math.min(object.h * 0.4, object.w * 0.26)));
  return {
    x: object.x + chair * 0.52,
    y: object.y + chair * 0.48,
    w: object.w - chair * 1.04,
    h: object.h - chair * 0.96,
  };
}

/**
 * Kinds drawn as a stadium inscribed in their own bounds — a shape with round ends
 * and straight sides — so their collider is that stadium and not the box.
 *
 * Two families, drawn from opposite ends of the kit and identical in plan:
 *
 *  - organic masses (boulder, thicket) at rx = w/2, ry = h/2. Reported from play at
 *    the temple, squeezing a bare core through a gap: "I cannot pass through this
 *    gap." The gap was between a boulder and a thicket, open on the screen and shut
 *    in the physics by two corners of undergrowth that nothing was drawn in.
 *  - a two-pole tent (bigTop), whose canvas is a semicircle round each mast with
 *    straight runs between them. That is not an approximation of a big top's plan;
 *    it is a big top's plan.
 */
export const STADIUM_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "boulder",
  "thicket",
  "bigTop",
]);

/**
 * The stadium inscribed in an object's bounds: a segment and a radius.
 *
 * Exported because the collider and the GLYPH both need it and must not each work
 * it out. `objectSolids` builds a capsule from this; the renderer draws the tent's
 * canvas along the same segment. One function, one answer — which is the only way
 * "the barrier matches its own edges" survives someone editing one of the two.
 */
export function stadiumAxis(object: Rect): { ax: number; ay: number; bx: number; by: number; r: number } {
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;
  const r = Math.min(object.w, object.h) / 2;
  const reach = Math.max(object.w, object.h) / 2 - r;
  const across = object.w >= object.h;
  return {
    ax: across ? cx - reach : cx,
    ay: across ? cy : cy - reach,
    bx: across ? cx + reach : cx,
    by: across ? cy : cy + reach,
    r,
  };
}

/**
 * Kinds drawn as a disc inscribed in their own bounds, so their collider must be
 * a disc too.
 *
 * The contract's rule is silhouette == collider, and a round glyph in a square
 * collider breaks it by the worst margin available: at a corner, 29% of the
 * radius is solid ground the player can see straight through. Reported from play
 * on the fairground carousel — "this circular building still has the square
 * around it, I cannot get to the top left edge of the circle."
 *
 * A kind, not an instance. Every one of these computes its radius as
 * `Math.min(w, h) / 2` in its glyph, which is the definition being honoured here.
 */
export const ROUND_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "carousel",
  "swingRide",
  "waltzer",
  "helterSkelter",
  "turntable",
  "waterTank",
  "brazier",
  "drum",
]);

/**
 * A tree collides at its TRUNK, not at its canopy.
 *
 * The glyph has drawn a trunk from the beginning — `treeGlyph` lays a `cylinder` at the
 * centre with the comment "A crown with no trunk floats" — and the collider was the whole
 * 104 x 104 bounding square. So the art said "a tree, which you walk under" and physics said
 * "a solid box, larger than the leaves you can see". Reported from play twice in one message:
 * "I actually can't go left anymore, despite the fact that I'm not even against the edge",
 * and "if it's a tree, we would actually assume that there's a trunk in the middle of that,
 * and I should be able to pass underneath the leaves."
 *
 * It also silently sealed a shrine. `tmp-dot-2` sat between two altars and two braziers with
 * a 65-unit way in, and a tree's square corner closed the diagonal — the Dot was unreachable
 * from the player spawn and no clearance check saw it, because every solid around it was
 * individually fine.
 *
 * EXPORTED AND SHARED WITH THE GLYPH ON PURPOSE. The trunk is the one piece of a tree that
 * both the drawing and the collider have to agree about, so there is exactly one number for
 * it. A separate constant in the renderer is how the canopy and the box drifted apart in the
 * first place.
 *
 * `thicket` is deliberately NOT this. A thicket is a mass of undergrowth rather than a canopy
 * on a stem — it is solid all the way down, keeps its stadium collider, and is what the map
 * should use where foliage is meant to stop somebody.
 */
export function treeTrunkRadius(object: Pick<MapObject, "w" | "h">): number {
  return Math.max(5, (Math.min(object.w, object.h) / 2) * 0.16);
}

/**
 * Physics rectangles for a map object. Most objects occupy their authored
 * bounds. Compound plan shapes can declare local collision parts, while the
 * contracts table collides only at its visible tabletop so a bot is never
 * stopped by the transparent chair gutter around it.
 *
 * Round kinds are their bounding box HERE, and a real disc in `objectSolids`.
 * This is the rect-only view, and its callers are authoring audits: over-stating
 * a round object by its corners makes them stricter, never wrong.
 */
export function objectCollisionRects(object: MapObject): Rect[] {
  return objectLayoutRects(object);
}

/**
 * An object's rects for reasoning about LAYOUT rather than physics.
 *
 * The difference is only round kinds, and it matters. A disc's eight-band
 * decomposition is a physics detail: to the composition audit, which asks whether
 * a fixture sits flush against a run or leaves an unusable slot beside it, those
 * bands look like eight fixtures of different widths, and a drum pushed hard
 * against a switchgear cabinet reported as "parked 6 units off its face" — the 6
 * units being the drum's own curvature. Flush is a rectilinear idea and a circle
 * does not have it.
 *
 * Connectivity keeps reading `objectCollisionRects`, because a bot really can walk
 * the corner a disc leaves free and treating it as solid would wall off real floor.
 */
export function objectLayoutRects(object: MapObject): Rect[] {
  if (!isSolidObject(object)) return [];
  if (object.collisionParts?.length) {
    return object.collisionParts.map((part) => ({
      x: object.x + part.x,
      y: object.y + part.y,
      w: part.w,
      h: part.h,
    }));
  }
  return object.kind === "planningTable" ? [planningTableSurfaceRect(object)] : [object];
}

export function rectContains(rect: Rect, point: Vec2, inset = 0): boolean {
  return (
    point.x >= rect.x + inset &&
    point.x <= rect.x + rect.w - inset &&
    point.y >= rect.y + inset &&
    point.y <= rect.y + rect.h - inset
  );
}

/**
 * Which building a point is inside — against the building's PLAN, not its bounding box.
 *
 * The bounding box was the last consumer in the codebase still treating a box as a plan,
 * and it was the loudest of them. Everything about being indoors keys on this: which floor
 * the renderer shows, whether a roof is lifted, which arena you share, what the floor rail
 * says. So for a round or fanned building, every corner of its bounding box read as INSIDE
 * — and the observatory's drum has four of them.
 *
 * Reported from play with a screenshot of the whole observatory interior on show while the
 * player stood outside on the plaza, touching the shell: "I shouldn't be able to see inside
 * of buildings just because I touch their wall. I noticed this in the train yard too."
 * The yard is the roundhouse, whose fan of engine bays sits in a 922 x 406 box it occupies
 * about a third of — so its dead corners are enormous, and standing in one put you inside a
 * shed you were nowhere near.
 *
 * Four other places had already been fixed for exactly this: `modelFloor` clips its slab to
 * the outline, `offFloorIssues` measures furniture against it, `connectivityIssues` floods
 * it, and `world.audit`'s trespass check tests it. Each of those was a drawing or an audit.
 * This one is the game.
 *
 * The box stays as a PREFILTER, because it is a rejection test and a cheap one: this runs
 * per bot per tick through `contextKey`, and only the one or two buildings whose box a point
 * falls in ever pay for the polygon.
 */
export function buildingContaining(map: MapDocument, point: Vec2): Building | null {
  for (const building of map.buildings) {
    if (!rectContains(building.footprint, point, 6)) continue;
    const plan = building.outline;
    if (plan && plan.length >= 3 && !polygonContains(plan, point)) continue;
    return building;
  }

  return null;
}

export function floorPlanById(map: MapDocument, floorId: string): FloorPlan | null {
  for (const building of map.buildings) {
    for (const floor of building.floors) {
      if (floor.id === floorId) {
        return floor;
      }
    }
  }

  return null;
}

export function buildingOfFloor(map: MapDocument, floorId: string): Building | null {
  for (const building of map.buildings) {
    if (building.floors.some((floor) => floor.id === floorId)) {
      return building;
    }
  }

  return null;
}

export function isGroundFloor(floor: FloorPlan): boolean {
  return floor.label === "GROUND";
}

/**
 * The physics floor a bot occupies. GROUND floors resolve to the outdoor layer
 * because they share the street plane (you walk in through the door gap).
 *
 * There is no cap on how many of these a map may have. There used to be: a
 * `collisionLayers` numbering that threw above 16, inherited from Rapier's
 * collision-filter bit budget. Rapier is gone — every solid now lives in a
 * `Map<string, SolidIndex>` keyed by the id this function returns, and nothing
 * anywhere assigns a floor a number. The guard outlived its constraint and
 * survived only because no map had ever been big enough to trip it. The Reach
 * tripped it at nine buildings, which is a tenth of the intended world.
 */
export function physicsFloorId(map: MapDocument, floorId: string): string {
  if (floorId === OUTDOOR_FLOOR_ID) {
    return OUTDOOR_FLOOR_ID;
  }

  const plan = floorPlanById(map, floorId);
  return plan && isGroundFloor(plan) ? OUTDOOR_FLOOR_ID : floorId;
}

/**
 * Two entities share an arena when this key matches: interior floors are their
 * own arenas; the outdoor plane splits into street vs. each building's ground
 * floor (physically connected, visually and tactically separate).
 */
export function contextKey(map: MapDocument, floorId: string, position: Vec2): string {
  if (floorId !== OUTDOOR_FLOOR_ID) {
    return floorId;
  }

  const building = buildingContaining(map, position);
  return building ? `outdoor:${building.id}` : "outdoor:street";
}

/**
 * Whether an opening is a vehicle door — a roll-up a truck drives through.
 *
 * The authored `opening` kind is authoritative. Only fall back to the width
 * heuristic for openings that predate the field, and treat that fallback as a
 * migration aid rather than a rule: a 120-unit archway between two rooms is not a
 * loading dock, and inferring otherwise gave the player base a truck apron and a
 * polished traffic lane running the depth of its workshop.
 *
 * This lives here, once, because the renderer had grown two versions of the
 * question that disagreed — the door itself checked `opening`, while the floor
 * paint and the wear pattern went straight to the width. Same map, two answers.
 */
export function isVehicleDoor(doorway: Doorway): boolean {
  if (doorway.opening) return doorway.opening === "rollup";
  return doorway.open === true && doorway.width >= 96;
}

/**
 * The wall band a rect-authored doorway was cut from, so a curtain can sit in the
 * wall's thickness and nowhere else.
 *
 * Three conditions, and all three earn their place. The wall has to **run along**
 * the opening, it has to **cross** the opening's line, and its run has to **reach**
 * the opening. Matching on the cross axis alone was the bug: a doorway is the
 * *absence* between two jambs, so no wall contains its centre, and any wall that
 * merely passed through the door's line qualified. The player base's 120-unit
 * archway matched the 616-unit west wall and drew a curtain the full depth of the
 * workshop.
 *
 * Thinnest match wins. The band is the wall's *thickness*, so a thin partition
 * beats a thick shell that happens to run nearby.
 */
export function bandFromWall(door: Doorway, walls: WallSegment[]): Rect | null {
  const horizontal = door.dir === "h";
  const half = door.width / 2;
  const centre = horizontal ? door.x : door.y;
  const TOL = 3;

  const thickness = (w: WallSegment) => (horizontal ? w.h : w.w);
  const jambs = walls.filter((w) => {
    if (horizontal ? w.w < w.h : w.h < w.w) return false;
    const crosses = horizontal
      ? door.y >= w.y - TOL && door.y <= w.y + w.h + TOL
      : door.x >= w.x - TOL && door.x <= w.x + w.w + TOL;
    if (!crosses) return false;
    const lo = horizontal ? w.x : w.y;
    const hi = lo + (horizontal ? w.w : w.h);
    return hi >= centre - half - TOL && lo <= centre + half + TOL;
  });

  const wall = jambs.sort((a, b) => thickness(a) - thickness(b))[0];
  if (!wall) return null;
  return horizontal
    ? { x: door.x - half, y: wall.y, w: door.width, h: wall.h }
    : { x: wall.x, y: door.y - half, w: wall.w, h: door.width };
}

export type StairHalves = {
  /** Half of the run you walk in from on this floor. */
  entry: Rect;
  /** Half beyond the break line — the flight continuing to the other floor. */
  exit: Rect;
  /** Run direction: true when the flight runs along the y axis. */
  vertical: boolean;
};

/** Physical width of a code-drawn freestanding stair rail/end barrier. */
export const STAIR_GUARD_THICKNESS = 8;

/**
 * Split a stair run at its midline (the architectural break line). Walking
 * from the entry half into the exit half moves the bot to the linked floor.
 */
export function stairHalves(stair: StairLink): StairHalves {
  const { x, y, w, h } = stair.rect;
  const vertical = h >= w;
  const bottomLow = stair.bottom === "N" || stair.bottom === "W";
  const entryLow = (stair.direction === "up") === bottomLow;

  const low: Rect = vertical ? { x, y, w, h: h / 2 } : { x, y, w: w / 2, h };
  const high: Rect = vertical ? { x, y: y + h / 2, w, h: h / 2 } : { x: x + w / 2, y, w: w / 2, h };

  return {
    entry: entryLow ? low : high,
    exit: entryLow ? high : low,
    vertical,
  };
}

/**
 * Collision pieces for a freestanding stair flight. The dashed exit half has
 * side rails and a far-end cap so it cannot be entered from the wrong side.
 * The active entry half stays open on both sides and at its outer end.
 * Authored stair cores return no pieces because their walls/doors own access.
 */
export function stairGuardRects(stair: StairLink): Rect[] {
  if (stair.access !== "openEnd") return [];

  const { x, y, w, h } = stair.rect;
  const { exit, vertical } = stairHalves(stair);
  const t = Math.min(STAIR_GUARD_THICKNESS, Math.min(w, h) / 4);

  if (vertical) {
    const exitAtNorth = exit.y === y;
    return [
      { x, y: exit.y, w: t, h: exit.h },
      { x: x + w - t, y: exit.y, w: t, h: exit.h },
      { x, y: exitAtNorth ? y : y + h - t, w, h: t },
    ];
  }

  const exitAtWest = exit.x === x;
  return [
    { x: exit.x, y, w: exit.w, h: t },
    { x: exit.x, y: y + h - t, w: exit.w, h: t },
    { x: exitAtWest ? x : x + w - t, y, w: t, h },
  ];
}

/** Where a bot arriving via this stair ends up: the center of its exit half. */
export function stairExitPoint(stair: StairLink): Vec2 {
  const { exit } = stairHalves(stair);
  return { x: exit.x + exit.w / 2, y: exit.y + exit.h / 2 };
}

const FLOOR_HEIGHTS: Record<FloorLabel, number> = {
  B3: -3,
  B2: -2,
  B1: -1,
  GROUND: 0,
  F1: 1,
  F2: 2,
  F3: 3,
  F4: 4,
  F5: 5,
  F6: 6,
  F7: 7,
  ROOF: 8,
};

export function floorHeight(label: FloorLabel): number {
  return FLOOR_HEIGHTS[label];
}

export type PlanRef = {
  buildingId: string;
  planId: string;
  label: FloorLabel;
};

/**
 * The floor plan an entity occupies, resolving the shared outdoor physics
 * plane into a building's GROUND plan by position. Null means open street.
 */
export function resolvePlan(map: MapDocument, floorId: string, position: Vec2): PlanRef | null {
  if (floorId !== OUTDOOR_FLOOR_ID) {
    const building = buildingOfFloor(map, floorId);
    const plan = floorPlanById(map, floorId);
    return building && plan ? { buildingId: building.id, planId: plan.id, label: plan.label } : null;
  }

  const building = buildingContaining(map, position);
  const ground = building?.floors.find(isGroundFloor);
  return building && ground ? { buildingId: building.id, planId: ground.id, label: ground.label } : null;
}

const stairConnectionCache = new WeakMap<MapDocument, Map<string, Set<string>>>();

/** Which floor plans are directly connected by a stair, in either direction. */
export function stairConnections(map: MapDocument): Map<string, Set<string>> {
  const cached = stairConnectionCache.get(map);

  if (cached) {
    return cached;
  }

  const connections = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    connections.set(a, (connections.get(a) ?? new Set()).add(b));
    connections.set(b, (connections.get(b) ?? new Set()).add(a));
  };

  for (const building of map.buildings) {
    const ground = building.floors.find(isGroundFloor);

    for (const floor of building.floors) {
      for (const stair of floor.stairs) {
        const target = stair.toFloorId === OUTDOOR_FLOOR_ID ? ground?.id : stair.toFloorId;

        if (target) {
          link(floor.id, target);
        }
      }
    }
  }

  stairConnectionCache.set(map, connections);
  return connections;
}

const LOUD_THRESHOLD = 0.6;

export type NoisePresentation = {
  /** Muffled = heard through walls or floors; rendered as a dashed ring. */
  muffled: boolean;
  /** -1 below the listener, 1 above, 0 same level. */
  vertical: -1 | 0 | 1;
};

/**
 * Whether (and how) a listener perceives a noise:
 * - same plan / both on the street → clear ring, always;
 * - loud noise through a wall on the same level → muffled ring;
 * - loud noise one stair-connected floor away → muffled ring + vertical chevron;
 * - anything else → inaudible.
 */
export function classifyNoise(
  map: MapDocument,
  listenerFloorId: string,
  listenerPosition: Vec2,
  noiseFloorId: string,
  noisePosition: Vec2,
  loudness: number,
): NoisePresentation | null {
  const listener = resolvePlan(map, listenerFloorId, listenerPosition);
  const noise = resolvePlan(map, noiseFloorId, noisePosition);

  if (listener?.planId === noise?.planId) {
    return { muffled: false, vertical: 0 };
  }

  if (loudness < LOUD_THRESHOLD) {
    return null;
  }

  // Same physical level, different room context: through exterior walls.
  if (listenerFloorId === noiseFloorId) {
    return { muffled: true, vertical: 0 };
  }

  if (listener && noise && listener.buildingId === noise.buildingId) {
    if (stairConnections(map).get(listener.planId)?.has(noise.planId)) {
      const delta = floorHeight(noise.label) - floorHeight(listener.label);
      return { muffled: true, vertical: delta > 0 ? 1 : -1 };
    }
  }

  return null;
}

export function locationLabel(map: MapDocument, floorId: string, position: Vec2): string {
  if (floorId !== OUTDOOR_FLOOR_ID) {
    const building = buildingOfFloor(map, floorId);
    const plan = floorPlanById(map, floorId);

    if (building && plan) {
      return `${building.name} / ${plan.label}`;
    }
  }

  const building = buildingContaining(map, position);

  if (building) {
    return `${building.name} / GROUND`;
  }

  return map.name.toUpperCase();
}
