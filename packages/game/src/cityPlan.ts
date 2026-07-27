import type { Rect, Road, Surface, SurfaceKind, Vec2 } from "./types";

/**
 * The city between the buildings, authored street-first.
 *
 * Downtown's first draft was authored the other way round: four buildings placed
 * on an empty sheet, then two roads drawn near them afterwards. That order is why
 * it read as boxes on a car park — a road that arrives after the buildings has
 * nothing to organise, so the ground between them never becomes anything, and
 * every object on it ends up at an arbitrary distance from everything else.
 *
 * So the order here is fixed, and the format enforces it: **street, then block,
 * then frontage, then building.** A street is a centreline with a carriageway and
 * its footways, and the footways are *derived* — an author cannot draw a pavement
 * in the wrong place relative to its road, because they do not draw it at all.
 *
 * What is left over after the streets is block, and every part of a block has to
 * be given a use (`PatchSpec`). That is the whole point: `auditCity` treats ground
 * with no named use as unfinished, so "this corner of the map is empty" stops
 * being a matter of taste and becomes a failing check.
 */

export type Side = "n" | "s" | "e" | "w";

/**
 * A footway narrower than this is decoration rather than pavement: two bots
 * cannot pass on it, so nobody would ever walk down it by choice.
 */
export const MIN_FOOTWAY = 96;
/** An approach narrower than this is a gap between things, not a path. */
export const MIN_APPROACH = 64;

export type StreetSpec = {
  id: string;
  /** Centreline. Axis-aligned; a diagonal street needs the kernel's polyline work. */
  from: Vec2;
  to: Vec2;
  /** Carriageway width, centred on the line. */
  width: number;
  /**
   * Footway depth beside the carriageway. A bare number applies to both flanking
   * sides; name the sides to differ. Use `0` where there is genuinely none — a
   * service lane nobody walks down, or a street running along the sheet edge.
   */
  footway?: number | Partial<Record<Side, number>>;
};

/** Ground with a use. Footways are excluded: only a street may produce one. */
export type PatchSpec = Rect & {
  id: string;
  kind: Exclude<SurfaceKind, "footway">;
};

/**
 * The bit of paving that joins a door to the public network.
 *
 * Authored as a line from the doorway to whatever it feeds into, because that is
 * the relationship worth stating. A door with no approach is the single most
 * common way an otherwise fine building fails to join the street.
 */
export type ApproachSpec = {
  id: string;
  /** On the building's face, at the doorway. */
  from: Vec2;
  /** Where it meets the footway, yard or plaza it feeds into. */
  to: Vec2;
  /** Defaults to `MIN_APPROACH`. */
  width?: number;
};

export type CityPlan = {
  streets: StreetSpec[];
  patches?: PatchSpec[];
  approaches?: ApproachSpec[];
};

export class CityPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CityPlanError";
  }
}

function axis(from: Vec2, to: Vec2, what: string): "h" | "v" {
  const horizontal = from.y === to.y;
  const vertical = from.x === to.x;
  if (horizontal && vertical) throw new CityPlanError(`${what} has zero length`);
  if (!horizontal && !vertical) {
    throw new CityPlanError(`${what} is not axis-aligned (${from.x},${from.y} to ${to.x},${to.y})`);
  }
  return horizontal ? "h" : "v";
}

function footwayDepth(street: StreetSpec, side: Side): number {
  const spec = street.footway;
  if (spec === undefined) return 0;
  if (typeof spec === "number") return spec;
  return spec[side] ?? 0;
}

/** The band of pavement on one side of a carriageway. */
function footwayRect(road: Rect, side: Side, depth: number): Rect {
  switch (side) {
    case "n": return { x: road.x, y: road.y - depth, w: road.w, h: depth };
    case "s": return { x: road.x, y: road.y + road.h, w: road.w, h: depth };
    case "w": return { x: road.x - depth, y: road.y, w: depth, h: road.h };
    case "e": return { x: road.x + road.w, y: road.y, w: depth, h: road.h };
  }
}

function compileStreet(street: StreetSpec): { road: Road; footways: Surface[] } {
  const orientation = axis(street.from, street.to, `street ${street.id}`);
  if (street.width <= 0) throw new CityPlanError(`street ${street.id} has width ${street.width}`);

  const half = street.width / 2;
  const road: Road = orientation === "h"
    ? {
      id: street.id,
      x: Math.min(street.from.x, street.to.x),
      y: street.from.y - half,
      w: Math.abs(street.to.x - street.from.x),
      h: street.width,
    }
    : {
      id: street.id,
      x: street.from.x - half,
      y: Math.min(street.from.y, street.to.y),
      w: street.width,
      h: Math.abs(street.to.y - street.from.y),
    };

  const sides: Side[] = orientation === "h" ? ["n", "s"] : ["w", "e"];
  const footways: Surface[] = [];
  for (const side of sides) {
    const depth = footwayDepth(street, side);
    if (depth === 0) continue;
    if (depth < MIN_FOOTWAY) {
      throw new CityPlanError(
        `street ${street.id} has a ${depth}-unit footway on its ${side} side; `
        + `below ${MIN_FOOTWAY} two bots cannot pass, so use 0 and call it a service lane`,
      );
    }
    footways.push({ id: `${street.id}-footway-${side}`, kind: "footway", ...footwayRect(road, side, depth) });
  }

  // Naming a side that does not flank this street is a typo worth catching: a
  // footway silently dropped from a plan is exactly the defect this file exists
  // to prevent.
  if (street.footway && typeof street.footway !== "number") {
    for (const named of Object.keys(street.footway) as Side[]) {
      if (!sides.includes(named)) {
        throw new CityPlanError(
          `street ${street.id} runs ${orientation === "h" ? "east-west" : "north-south"}, `
          + `so it has no ${named} side — name ${sides.join(" or ")}`,
        );
      }
    }
  }

  return { road, footways };
}

function compileApproach(approach: ApproachSpec): Surface {
  const orientation = axis(approach.from, approach.to, `approach ${approach.id}`);
  const width = approach.width ?? MIN_APPROACH;
  if (width < MIN_APPROACH) {
    throw new CityPlanError(
      `approach ${approach.id} is ${width} units wide; below ${MIN_APPROACH} it is a gap, not a path`,
    );
  }
  const half = width / 2;
  const rect: Rect = orientation === "h"
    ? {
      x: Math.min(approach.from.x, approach.to.x),
      y: approach.from.y - half,
      w: Math.abs(approach.to.x - approach.from.x),
      h: width,
    }
    : {
      x: approach.from.x - half,
      y: Math.min(approach.from.y, approach.to.y),
      w: width,
      h: Math.abs(approach.to.y - approach.from.y),
    };
  return { id: approach.id, kind: "forecourt", ...rect };
}

export function compileCityPlan(plan: CityPlan): { roads: Road[]; surfaces: Surface[] } {
  const roads: Road[] = [];
  const surfaces: Surface[] = [];

  for (const street of plan.streets) {
    const { road, footways } = compileStreet(street);
    roads.push(road);
    surfaces.push(...footways);
  }

  for (const patch of plan.patches ?? []) {
    if (patch.w <= 0 || patch.h <= 0) {
      throw new CityPlanError(`patch ${patch.id} is ${patch.w} x ${patch.h}`);
    }
    surfaces.push({ id: patch.id, kind: patch.kind, x: patch.x, y: patch.y, w: patch.w, h: patch.h });
  }

  for (const approach of plan.approaches ?? []) surfaces.push(compileApproach(approach));

  const seen = new Set<string>();
  for (const id of [...roads.map((road) => road.id), ...surfaces.map((surface) => surface.id)]) {
    if (seen.has(id)) throw new CityPlanError(`duplicate id ${id} in the city plan`);
    seen.add(id);
  }

  return { roads, surfaces };
}

/** Ground a bot can route over on the way somewhere. Verges are not routes. */
export const ROUTE_KINDS: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>([
  "footway",
  "forecourt",
  "plaza",
  "yard",
]);
