import {
  arcLengthNearest,
  circlePoints,
  filletCorners,
  insetPolygon,
  pathLength,
  pointAtArcLength,
  splitPathByGaps,
  thickenPath,
} from "./geometry";
import { isSolidObject } from "./mapModel";
import { OUTDOOR_FLOOR_ID } from "./types";
import type {
  Barrier,
  Building,
  BuildingKind,
  Doorway,
  Facing,
  FloorPlan,
  Item,
  MapObject,
  ObjectKind,
  Rect,
  Solid,
  StairLink,
  Vec2,
  WindowBand,
} from "./types";

/**
 * Authored map source: the format a person, an LLM and the editor all edit.
 *
 * Two problems shaped this. The old pipeline generated wall *segments* from
 * TypeScript helpers, so the editor only ever saw the output — moving a door meant
 * re-splitting fragments by hand, and code-authored maps could not be saved at
 * all. And everything was an axis-aligned rectangle, which quietly decided that
 * every building was a box and no wall could turn.
 *
 * So the generative step moves out of authoring and into the compiler, and the
 * geometry is general from the start:
 *
 *  - A wall is a **path** with a thickness. Any angle, any number of corners, and
 *    a corner may carry a radius, which the kernel tessellates into a real curve.
 *    You never author a wall fragment.
 *  - An outline is a **polygon**, a circle, or a rectangle shorthand. An L-plan, a
 *    chamfered corner, a round tower and a ship's hull are all first-class.
 *  - An opening is placed by `near` — roughly where it is — and the compiler snaps
 *    it onto the wall. Nobody computes arc length by hand.
 *  - The **shell** belongs to the building, not each floor, so a nine-storey tower
 *    does not restate its perimeter nine times.
 *  - **Stairs belong to the building** and compile into the coordinate-identical
 *    reverse pair. A mismatched pair is unrepresentable.
 *  - Every floor carries a **brief** (contract §4), so an author states the floor's
 *    purpose before a reviewer has to guess it.
 *  - Ids derive from position in the source, so inserting an object never
 *    renumbers its neighbours.
 */

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

/** A path vertex. `r` rounds the corner into a tangent curve. */
export type SourcePoint = { x: number; y: number; r?: number };

/** Doors, roll-ups and archways cut the wall. Windows glaze it without cutting. */
export type OpeningKind = "door" | "rollup" | "archway" | "window";

export type SourceOpening = {
  kind: OpeningKind;
  width: number;
  /** Anchor: the opening lands at the point on the wall nearest here. */
  near?: Vec2;
  /** Distance along the wall to the opening's centre. Used when `near` is absent. */
  at?: number;
  /** Only meaningful for a door whose mechanism is authoritative in the sim. */
  mechanism?: "automatic";
};

export type SourceWall = {
  id: string;
  path: SourcePoint[];
  thickness: number;
  closed?: boolean;
  openings?: SourceOpening[];
};

/**
 * A building's plan outline — its **outer** edge, as you would measure it on site.
 * The compiler insets by half the shell thickness to get the wall centreline.
 * `rect` is shorthand for the four-point polygon.
 */
export type SourceOutline =
  | { shape: "rect"; x: number; y: number; w: number; h: number; corner?: number }
  | { shape: "polygon"; points: SourcePoint[] }
  | { shape: "circle"; x: number; y: number; r: number; steps?: number };

export type SourceStair = {
  id: string;
  rect: Rect;
  /** Floor labels. The compiler emits both halves of the pair. */
  from: string;
  to: string;
  /** Which side of the rect is the bottom of the flight. */
  bottom: Facing;
  access?: "openEnd";
};

export type SourceObject = {
  id: string;
  kind: ObjectKind;
  x: number;
  y: number;
  w: number;
  h: number;
  facing?: Facing;
  solid?: boolean;
  scannable?: boolean;
  collisionParts?: Rect[];
  /** Radians about the object's centre. Passable kinds only; `compileObject` throws otherwise. */
  angle?: number;
};

export type SourceDot = { id: string; item: Item; x: number; y: number; radius?: number };

/** Contract §4 as data, so the brief exists before the coordinates do. */
export type FloorBrief = {
  purpose: string;
  zones: string[];
  sequence: string;
  adjacency: string;
  negativeSpace: string;
};

export type SourceFloor = {
  label: string;
  brief?: FloorBrief;
  /**
   * This floor's own outline, when it is not the building's.
   *
   * The reason it exists is below ground: a cellar, a crypt or a tunnel system is not
   * bound by the footprint of the mass standing on it. The temple's undercroft runs out
   * from under the pyramid and beneath the plaza, and that is one building with two
   * different plans at two different elevations rather than two buildings — because a
   * stair links floors of ONE building, so anything reachable from the entrance hall has
   * to be a floor of the temple.
   *
   * The building's `outline` and `footprint` stay the SURFACE shape whatever this says.
   * Everything about street presence reads those — which building you are standing in,
   * where its frontage is, what blocks line of sight along a road — and none of that is
   * true of something underground.
   */
  outline?: SourceOutline;
  /** Openings cut into the shared exterior shell. */
  shellOpenings?: SourceOpening[];
  /** Interior partitions, at any angle. */
  walls?: SourceWall[];
  objects?: SourceObject[];
  dots?: SourceDot[];
};

export type SourceBuilding = {
  id: string;
  kind: BuildingKind;
  name: string;
  outline: SourceOutline;
  /** Exterior wall thickness, shared by every floor. */
  shellThickness: number;
  stairs?: SourceStair[];
  floors: SourceFloor[];
};

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const CUTS: ReadonlySet<OpeningKind> = new Set<OpeningKind>(["door", "rollup", "archway"]);

/** Storey height from a floor label. The labels already encode elevation. */
export function floorElevation(label: string): number {
  if (label === "ROOF") return 99;
  if (label === "GROUND") return 0;
  const basement = /^B(\d+)$/.exec(label);
  if (basement) return -Number(basement[1]);
  const upper = /^F(\d+)$/.exec(label);
  if (upper) return Number(upper[1]);
  throw new Error(`Unknown floor label ${label}`);
}

/** Resolve a source outline into a closed polygon, curves tessellated. */
export function outlinePoints(outline: SourceOutline): Vec2[] {
  if (outline.shape === "circle") {
    return circlePoints({ x: outline.x, y: outline.y }, outline.r, outline.steps ?? 28);
  }
  if (outline.shape === "rect") {
    const { x, y, w, h } = outline;
    const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    return outline.corner ? filletCorners(corners, outline.corner, true, 5) : corners;
  }
  return resolvePath(outline.points, true);
}

/**
 * Turn source vertices into a polyline, replacing any vertex carrying `r` with a
 * tangent curve. Fillets are applied per-vertex so one corner can be rounded and
 * the rest left sharp.
 */
export function resolvePath(points: SourcePoint[], closed = false): Vec2[] {
  const plain = points.map((point) => ({ x: point.x, y: point.y }));
  if (!points.some((point) => point.r && point.r > 0)) return plain;

  // Fillet one corner at a time so radii can differ along a single path.
  let result = plain;
  points.forEach((point, index) => {
    if (!point.r || point.r <= 0) return;
    const target = result.findIndex((candidate) => candidate.x === point.x && candidate.y === point.y);
    if (target < 0) return;
    const before = result.slice(0, Math.max(0, target - 1));
    const window = result.slice(Math.max(0, target - 1), target + 2);
    const after = result.slice(target + 2);
    if (window.length < 3) return;
    const rounded = filletCorners(window, point.r, false, 6);
    result = [...before, ...rounded, ...after];
  });
  void closed;
  return result;
}

function openingArc(path: Vec2[], opening: SourceOpening, closed: boolean): number {
  if (opening.near) return arcLengthNearest(path, opening.near, closed);
  return opening.at ?? 0;
}

type CompiledWall = { barrier: Barrier | null; doorways: Doorway[]; windows: WindowBand[] };

/**
 * One wall: solid stretches become capsules, cut openings become genuine gaps in
 * collision, and glazing becomes a window band that does not cut anything.
 */
function compileWall(wall: SourceWall): CompiledWall {
  const path = resolvePath(wall.path, wall.closed);
  const closed = wall.closed ?? false;
  const openings = wall.openings ?? [];
  const total = pathLength(path, closed);

  const spans = openings.map((opening) => {
    const centre = Math.max(0, Math.min(total, openingArc(path, opening, closed)));
    return { opening, from: centre - opening.width / 2, to: centre + opening.width / 2, centre };
  });

  const cuts = spans.filter((span) => CUTS.has(span.opening.kind));

  /**
   * The wall survives between the openings, pulled back from each jamb by a cap
   * radius so the clear width is exactly the width that was authored.
   */
  const runs = splitPathByGaps(path, cuts, closed, wall.thickness / 2);

  const solids: Solid[] = runs.flatMap((run) => thickenPath(run, wall.thickness));

  const doorways: Doorway[] = cuts.map((span, index) => {
    const start = pointAtArcLength(path, span.from, closed).at;
    const end = pointAtArcLength(path, span.to, closed).at;
    const middle = pointAtArcLength(path, span.centre, closed);
    const horizontal = Math.abs(middle.dir.x) >= Math.abs(middle.dir.y);
    return {
      id: `${wall.id}-d${index}`,
      x: middle.at.x,
      y: middle.at.y,
      width: span.opening.width,
      // `dir` describes the run the opening sits in, kept for the axis-aligned
      // fast path; `span` carries the truth for a wall at any angle.
      dir: horizontal ? "h" : "v",
      span: { ax: start.x, ay: start.y, bx: end.x, by: end.y },
      // The reveal is as deep as the wall, so door furniture never has to go
      // looking for the wall it was cut from.
      thickness: wall.thickness,
      opening: span.opening.kind as "door" | "rollup" | "archway",
      ...(span.opening.kind === "rollup" || span.opening.kind === "archway" ? { open: true } : {}),
      ...(span.opening.mechanism ? { mechanism: span.opening.mechanism } : {}),
    };
  });

  const windows: WindowBand[] = spans
    .filter((span) => span.opening.kind === "window")
    .map((span, index) => {
      const start = pointAtArcLength(path, span.from, closed).at;
      const end = pointAtArcLength(path, span.to, closed).at;
      const middle = pointAtArcLength(path, span.centre, closed);
      const horizontal = Math.abs(middle.dir.x) >= Math.abs(middle.dir.y);
      return {
        id: `${wall.id}-g${index}`,
        x: middle.at.x,
        y: middle.at.y,
        length: span.opening.width,
        dir: horizontal ? ("h" as const) : ("v" as const),
        span: { ax: start.x, ay: start.y, bx: end.x, by: end.y },
      };
    });

  return {
    barrier: solids.length ? { id: wall.id, solids } : null,
    doorways,
    windows,
  };
}

/**
 * The centreline of the shell wall: the authored outline pulled in by half the
 * wall thickness, so the wall's outer face lands exactly on the authored outline.
 */
export function shellCentreline(source: SourceBuilding): Vec2[] {
  return insetPolygon(outlinePoints(source.outline), source.shellThickness / 2);
}

/** The outline a floor is shelled from: its own, or the building's. */
function floorOutline(source: SourceBuilding, floor: SourceFloor): SourceOutline {
  return floor.outline ?? source.outline;
}

/**
 * A floor's exterior shell, as one closed wall.
 *
 * Usually the building's own outline, and a floor may override it — see
 * `SourceFloor.outline`. That is what lets one building hold a pyramid and the tunnel
 * system underneath it: a level below ground is not bound by the mass standing on it.
 */
function shellWall(source: SourceBuilding, floor: SourceFloor): SourceWall {
  return {
    id: `${floor.label}-shell`,
    path: insetPolygon(outlinePoints(floorOutline(source, floor)), source.shellThickness / 2),
    thickness: source.shellThickness,
    closed: true,
    openings: floor.shellOpenings ?? [],
  };
}

function compileObject(object: SourceObject): MapObject {
  const { id, kind, x, y, w, h, facing, solid, scannable, collisionParts, angle } = object;
  const compiled: MapObject = {
    id,
    kind,
    x,
    y,
    w,
    h,
    ...(facing ? { facing } : {}),
    ...(solid === undefined ? {} : { solid }),
    ...(scannable ? { scannable } : {}),
    ...(collisionParts ? { collisionParts } : {}),
    ...(angle ? { angle } : {}),
  };

  /**
   * The format refuses a rotated SOLID, rather than shipping a drawing that lies.
   *
   * A solid object's collider is its rect, or a capsule inscribed in that rect. Rotating the
   * glyph and leaving the collider square to the world produces exactly the fault the whole
   * contract is built to prevent: a wall the player can see is not there, and an opening they
   * can see that will not let them through. `false-aisle` and `wedged-fixture` also both
   * reason in rectangles, and a rotated rect has no honest one, so the layout audits would go
   * quiet on the very objects most likely to be wrong.
   *
   * Refused here rather than documented, because a rule an author can write down anyway is a
   * rule that gets written down anyway. Lifting this means poly colliders and poly-aware
   * layout audits, and until then a turned object has to be one nothing can collide with.
   */
  if (angle && isSolidObject(compiled)) {
    throw new Error(
      `${id}: angle is only supported on passable objects, and ${kind} is solid. `
      + "A rotated glyph over an axis-aligned collider is an invisible wall. "
      + "Rotating solids needs poly colliders and poly-aware layout audits.",
    );
  }
  return compiled;
}

/**
 * Both halves of one flight.
 *
 * A ground floor shares the outdoor physics plane, so a flight arriving there
 * targets the outdoor floor rather than the plan's own id — a rule that used to be
 * restated by hand at every stair.
 */
function compileStairPair(source: SourceBuilding, stair: SourceStair): Array<{ label: string; link: StairLink }> {
  const floorId = (label: string): string => (label === "GROUND" ? OUTDOOR_FLOOR_ID : `${source.id}:${label}`);
  const known = new Set(source.floors.map((floor) => floor.label));
  if (!known.has(stair.from) || !known.has(stair.to)) {
    throw new Error(`${source.id} stair ${stair.id} links unknown floors ${stair.from} -> ${stair.to}`);
  }
  /**
   * Direction comes from the labels, not array order.
   *
   * Inferring it from position in the `floors` array is wrong in both directions:
   * `[GROUND, F1]` is authored upward while `[GROUND, B1]` is authored downward, so
   * the same index comparison gives opposite answers for the same intent.
   */
  const goingDown = floorElevation(stair.to) < floorElevation(stair.from);
  const half = (label: string, direction: "up" | "down", target: string): { label: string; link: StairLink } => ({
    label,
    link: {
      id: `${stair.id}-${direction}`,
      rect: stair.rect,
      direction,
      toFloorId: target,
      bottom: stair.bottom,
      ...(stair.access ? { access: stair.access } : {}),
    },
  });

  return goingDown
    ? [half(stair.from, "down", floorId(stair.to)), half(stair.to, "up", floorId(stair.from))]
    : [half(stair.from, "up", floorId(stair.to)), half(stair.to, "down", floorId(stair.from))];
}

export function compileBuilding(source: SourceBuilding): Building {
  const stairsByFloor = new Map<string, StairLink[]>();
  for (const stair of source.stairs ?? []) {
    for (const half of compileStairPair(source, stair)) {
      stairsByFloor.set(half.label, [...(stairsByFloor.get(half.label) ?? []), half.link]);
    }
  }

  const outline = outlinePoints(source.outline);

  const floors: FloorPlan[] = source.floors.map((floor) => {
    /**
     * The shell is on every floor, roof included. A walkable roof's perimeter is
     * its parapet, and a parapet is solid — leave it off and a bot walks over the
     * edge into open sky.
     */
    const walls: SourceWall[] = [shellWall(source, floor), ...(floor.walls ?? [])];
    const compiled = walls.map(compileWall);
    const plan = outlinePoints(floorOutline(source, floor));

    const barriers = compiled.map((item) => item.barrier).filter((item): item is Barrier => item !== null);
    const windows = compiled.flatMap((item) => item.windows);

    return {
      id: `${source.id}:${floor.label}`,
      label: floor.label as FloorPlan["label"],
      // This floor's own plan and extent. Equal to the building's unless the floor
      // overrode the outline, which is how the interior systems stop asking the mass
      // above how far a cellar reaches.
      outline: plan,
      bounds: outlineBounds(plan),
      // Every wall in this format is a path, so nothing lands in the
      // rect-only `walls` array; the runtime reads geometry from `barriers`.
      walls: [],
      barriers,
      doorways: compiled.flatMap((item) => item.doorways),
      ...(windows.length ? { windows } : {}),
      objects: (floor.objects ?? []).map(compileObject),
      stairs: stairsByFloor.get(floor.label) ?? [],
      dotSpawns: (floor.dots ?? []).map((dot) => ({
        id: dot.id,
        item: dot.item,
        position: { x: dot.x, y: dot.y },
        ...(dot.radius === undefined ? {} : { radius: dot.radius }),
      })),
    };
  });

  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    // The runtime still wants an axis-aligned box for cameras, fog bounds and
    // "which building am I in" tests. It is derived, never authored.
    footprint: outlineBounds(outline),
    outline,
    floors,
  };
}

function outlineBounds(points: Vec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
