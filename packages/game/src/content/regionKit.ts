import { arcPoints } from "../geometry";
import type {
  Barrier,
  BotSpawn,
  Building,
  DotSpawn,
  ExtractionPoint,
  GroundRegion,
  InsertionPoint,
  MapObject,
  ObjectKind,
  ParkArea,
  PatrolRoute,
  PowerupType,
  Road,
  Surface,
  Vec2,
  WallSegment,
} from "../types";

/** Production patrol authoring: ordered points plus the responsibility they express. */
export function patrol(id: string, purpose: string, waypoints: Vec2[]): PatrolRoute {
  return {
    id,
    purpose,
    waypoints: waypoints.map((position) => ({ position })),
  };
}

/**
 * Authoring helpers shared by every region, and the reason regions exist at all.
 *
 * Downtown is one 2400 x 1600 sheet authored as a single file. That worked for one
 * place and stops working at four: the objects, the ground, the spawns and the
 * buildings of a rail yard have nothing to do with those of a temple, and a single
 * file holding all of them is where a world stops being editable.
 *
 * So a region is a *part* — everything one place contributes to the world — and
 * `world.ts` assembles them. Nothing here enumerates the regions; the assembler
 * takes a list. That is the same rule the rest of the map obeys: no hardcoded set of
 * places, because the world is meant to reach a hundred buildings.
 */

export type RegionParts = {
  id: string;
  name: string;
  roads?: Road[];
  surfaces?: Surface[];
  regions?: GroundRegion[];
  parks?: ParkArea[];
  walls?: WallSegment[];
  barriers?: Barrier[];
  objects?: MapObject[];
  dotSpawns?: DotSpawn[];
  buildings?: Building[];
  extractionPoints?: ExtractionPoint[];
  insertionPoints?: InsertionPoint[];
  botSpawns?: BotSpawn[];
};

/**
 * An object factory scoped to one region.
 *
 * Ids carry the region's prefix and a running count, so two regions can never
 * collide and an id says where the thing is without looking it up. Downtown uses a
 * bare `o0`, `o1` sequence, which was fine while there was one place.
 */
export function objects(prefix: string) {
  let seq = 0;
  return function obj(
    kind: ObjectKind,
    x: number,
    y: number,
    w: number,
    h: number,
    extra: Partial<MapObject> = {},
  ): MapObject {
    return { id: `${prefix}-o${seq++}`, kind, x, y, w, h, ...extra };
  };
}

/** A Dot factory scoped to one region. */
export function dots(prefix: string) {
  let seq = 0;
  return function dot(type: PowerupType, x: number, y: number): DotSpawn {
    return { id: `${prefix}-dot-${seq++}`, item: { kind: "powerup", type }, position: { x, y } };
  };
}

/**
 * Positions at a steady interval, with named stretches punched out.
 *
 * Lifted verbatim from Downtown's exterior, because the rule it encodes is not about
 * streets: a rhythm with gaps is what makes any repetition read as designed rather
 * than scattered, whether it is street trees, stelae along a plaza or wagons in a rake.
 */
export function rhythm(from: number, to: number, step: number, clear: Array<[number, number]> = []): number[] {
  const out: number[] = [];
  for (let at = from; at <= to; at += step) {
    if (clear.some(([start, end]) => at >= start && at <= end)) continue;
    out.push(at);
  }
  return out;
}

/** A rectangle as a region polygon, for the parts of a region that really are square. */
export function boxPoly(x: number, y: number, w: number, h: number): Vec2[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/**
 * Deterministic 0..1 from a string and a salt.
 *
 * The renderer has `jitter` in `tone.ts` and the map cannot import it — a map that
 * depends on the renderer is a map that cannot be validated headlessly. Same hash,
 * separately owned, and the duplication is load-bearing rather than accidental.
 */
export function wobbleAt(id: string, salt = 0): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 15;
  return ((hash >>> 0) % 100000) / 100000;
}

/**
 * An irregular closed ring: a clearing, a pool, a patch of weeds.
 *
 * The single most useful shape in a non-city region, and the reason `GroundRegion`
 * exists. A clearing drawn as a rectangle is a room with no walls.
 */
export function blobPoly(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  id: string,
  wobble = 0.3,
  count = 15,
): Vec2[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    const k = 1 - wobble / 2 + wobbleAt(id, i) * wobble;
    return { x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k };
  });
}

/**
 * A band of ground following a line: a trail, a creek, a track apron.
 *
 * Width is sampled along the run rather than fixed, because a constant-width band is
 * a road however it curves — and the whole point of a trail is that it narrows where
 * the growth closes in.
 */
export function ribbonPoly(spine: Vec2[], widthAt: (t: number) => number): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < spine.length; i += 1) {
    const before = spine[Math.max(0, i - 1)];
    const after = spine[Math.min(spine.length - 1, i + 1)];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const len = Math.hypot(dx, dy) || 1;
    const half = widthAt(i / Math.max(1, spine.length - 1)) / 2;
    const nx = -dy / len;
    const ny = dx / len;
    left.push({ x: spine[i].x + nx * half, y: spine[i].y + ny * half });
    right.push({ x: spine[i].x - nx * half, y: spine[i].y - ny * half });
  }
  return [...left, ...right.reverse()];
}

/**
 * An annular sector: the plan of a roundhouse, a terrace, a curved colonnade.
 *
 * Wound outer-arc-then-inner-arc-reversed so the result is a single closed ring the
 * geometry kernel can inset. This is the shape that made the format worth extending:
 * a fan of engine bays round a turntable is the strongest single image a rail yard
 * has, and it cannot be said in rectangles at all.
 */
export function sectorPoly(
  centre: Vec2,
  inner: number,
  outer: number,
  fromRadians: number,
  toRadians: number,
  steps = 14,
): Vec2[] {
  return [
    ...arcPoints(centre, outer, fromRadians, toRadians, steps),
    ...arcPoints(centre, inner, toRadians, fromRadians, steps),
  ];
}

/** A point at a bearing and distance from a centre. Radial layout reads best overhead. */
export function radial(centre: Vec2, radians: number, distance: number): Vec2 {
  return { x: centre.x + Math.cos(radians) * distance, y: centre.y + Math.sin(radians) * distance };
}

/**
 * A wall run with named gaps in it.
 *
 * The world's internal boundaries are walls with gates rather than open carpet, and
 * that is a design decision worth stating: four regions blending seamlessly into one
 * another read as one big field, while a fence with two ways through makes each one a
 * *place* you enter and leave. It is also what keeps `auditCity` honest, since a wall
 * counts as built ground rather than as ground nobody named.
 */
export function fenceRun(
  id: string,
  axis: "h" | "v",
  along: number,
  from: number,
  to: number,
  thickness: number,
  gaps: Array<[number, number]> = [],
): WallSegment[] {
  const out: WallSegment[] = [];
  let cursor = from;
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  let seq = 0;
  const push = (start: number, end: number): void => {
    if (end - start <= 0) return;
    out.push(axis === "h"
      ? { id: `${id}-${seq++}`, x: start, y: along, w: end - start, h: thickness }
      : { id: `${id}-${seq++}`, x: along, y: start, w: thickness, h: end - start });
  };
  for (const [start, end] of sorted) {
    push(cursor, Math.min(start, to));
    cursor = Math.max(cursor, end);
  }
  push(cursor, to);
  return out;
}
