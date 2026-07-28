import { defaultGameConfig } from "./config";
import { pointToSolidDistanceSquared, rectSolid, solidBounds } from "./geometry";
import { isGroundFloor, MIN_DOT_SEPARATION, objectCollisionRects, physicsFloorId, stairGuardRects, stairHalves } from "./mapModel";
import { collectSolids } from "./collision";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Building, DotSpawn, FloorPlan, MapDocument, Rect, Solid, Vec2 } from "./types";

/** Fixtures this close read as one deliberately joined bank. */
export const MAX_ATTACHED_SEAM = 16;
/** A visible route must be wider than the 48-unit bot, with steering tolerance. */
export const MIN_COMFORTABLE_AISLE = 64;
const CONNECTIVITY_CELL = 8;
const MIN_DISCONNECTED_AREA = 1_536;

/** Whether `outer` fully encloses `inner`, so the two colliders union to `outer`. */
function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h;
}

/** Edges this close count as flush, so a seam reads as one continuous bank. */
const FLUSH_TOLERANCE = 4;

export type FloorQualityIssue = {
  floorId: string;
  kind:
    | "solid-overlap"
    | "false-aisle"
    | "parallel-banks"
    | "wedged-fixture"
    | "disconnected-area"
    | "blocked-stair-approach"
    | "blocked-stair-side"
    | "stair-unreachable"
    | "stair-target-missing"
    | "object-off-floor"
    | "dot-unreachable"
    | "dot-crowded";
  message: string;
};

type OwnedRect = {
  ownerId: string;
  ownerKind: "object" | "wall" | "stair";
  rect: Rect;
};

function positiveOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function axisGap(a0: number, a1: number, b0: number, b1: number): number {
  if (a1 <= b0) return b0 - a1;
  if (b1 <= a0) return a0 - b1;
  return 0;
}

/** How much longer a run must be than a fixture for "parked beside it" to apply. */
const PARKED_LENGTH_RATIO = 2.5;

/**
 * True when a fixture's own ends lie on `axis`, so a gap on that axis meets its
 * end rather than its face.
 *
 * This is the discriminator the contract implies with "the attached-seam
 * allowance is only for modules that visibly extend one bank". A workbench whose
 * end stops 16 units short of a locker block *is* extending a perimeter run. A
 * crate parked 6 units off the long face of a rack run extends nothing — it just
 * leaves a slot a player can see and never enter.
 */
function runsAlong(rect: Rect, axis: "x" | "y"): boolean {
  return axis === "x" ? rect.w > rect.h : rect.h > rect.w;
}

/** True when `span` sits clear of both ends of `run`, i.e. against its face. */
function offsetFromBothEnds(span0: number, span1: number, run0: number, run1: number): boolean {
  return Math.abs(span0 - run0) > FLUSH_TOLERANCE && Math.abs(span1 - run1) > FLUSH_TOLERANCE;
}

function circleClearsSolids(center: Vec2, radius: number, solids: Solid[]): boolean {
  return solids.every((solid) => pointToSolidDistanceSquared(center, solid) >= radius * radius);
}

/**
 * An axis-aligned wall as an exact rectangle, so the pairwise fixture rules keep
 * working once a floor's walls are capsules rather than rects.
 *
 * A capsule's bounds equal its rect for any axis-aligned run, give or take the
 * rounded caps — which over-claim, the safe direction for an audit. A wall at an
 * angle has no honest rectangle, so it is left out of the pairwise pass entirely
 * and taken into account by the connectivity flood fill, which reads the true
 * solid.
 */
function axisAlignedWallRect(solid: Solid): Rect | null {
  if (solid.kind === "rect") return { x: solid.x, y: solid.y, w: solid.w, h: solid.h };
  if (solid.kind !== "capsule") return null;
  if (solid.ax !== solid.bx && solid.ay !== solid.by) return null;
  return solidBounds(solid);
}

function ownedSolids(floor: FloorPlan): OwnedRect[] {
  return [
    ...floor.walls.map((rect) => ({ ownerId: rect.id, ownerKind: "wall" as const, rect })),
    ...(floor.barriers ?? []).flatMap((barrier) =>
      barrier.solids
        .map(axisAlignedWallRect)
        .filter((rect): rect is Rect => rect !== null)
        .map((rect) => ({ ownerId: barrier.id, ownerKind: "wall" as const, rect }))),
    ...floor.objects.flatMap((object) => objectCollisionRects(object).map((rect) => ({
      ownerId: object.id,
      ownerKind: "object" as const,
      rect,
    }))),
    ...floor.stairs.flatMap((stair) => stairGuardRects(stair).map((rect) => ({
      ownerId: stair.id,
      ownerKind: "stair" as const,
      rect,
    }))),
  ];
}

function floorSeeds(map: MapDocument, building: Building, floor: FloorPlan): Vec2[] {
  const humanSpawns = map.botSpawns
    .filter((spawn) => spawn.controller === "human" && spawn.floorId === floor.id)
    .map((spawn) => spawn.position);
  if (humanSpawns.length > 0) return humanSpawns;

  const down = floor.stairs.find((stair) => stair.direction === "down") ?? floor.stairs[0];
  if (down) {
    const { entry } = stairHalves(down);
    return [{ x: entry.x + entry.w / 2, y: entry.y + entry.h / 2 }];
  }

  return [{
    x: building.footprint.x + building.footprint.w / 2,
    y: building.footprint.y + building.footprint.h / 2,
  }];
}

/**
 * Everything the floor's connectivity flood fill can tell us.
 *
 * Two rules come out of one fill. Stranded *area* catches a room nobody can get
 * into. Stranded *stairs* catch something the area rule structurally cannot: the
 * standable space inside a stair shaft is only about 40 x 112 once the bot radius
 * and the flight's guard rects are taken out, so a sealed shaft always falls under
 * `MIN_DISCONNECTED_AREA` and was silently dropped. A small unreachable region is
 * still a floor the player cannot leave, and a stair is the case where that
 * matters most.
 */
function connectivityIssues(
  map: MapDocument,
  building: Building,
  floor: FloorPlan,
  solids: Solid[],
  radius: number,
): FloorQualityIssue[] {
  const { footprint } = building;
  const cols = Math.ceil(footprint.w / CONNECTIVITY_CELL);
  const rows = Math.ceil(footprint.h / CONNECTIVITY_CELL);
  const center = (index: number): Vec2 => ({
    x: footprint.x + (index % cols) * CONNECTIVITY_CELL + CONNECTIVITY_CELL / 2,
    y: footprint.y + Math.floor(index / cols) * CONNECTIVITY_CELL + CONNECTIVITY_CELL / 2,
  });
  const open = new Set<number>();

  for (let index = 0; index < cols * rows; index += 1) {
    const point = center(index);
    if (
      point.x >= footprint.x + radius &&
      point.x <= footprint.x + footprint.w - radius &&
      point.y >= footprint.y + radius &&
      point.y <= footprint.y + footprint.h - radius &&
      circleClearsSolids(point, radius - 1, solids)
    ) {
      open.add(index);
    }
  }

  const nearestOpen = (point: Vec2): number | null => {
    let nearest: number | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const index of open) {
      const candidate = center(index);
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    }
    return best <= radius ? nearest : null;
  };

  const reachable = new Set<number>();
  const queue = floorSeeds(map, building, floor)
    .map(nearestOpen)
    .filter((index): index is number => index !== null);
  for (const index of queue) reachable.add(index);

  while (queue.length > 0) {
    const index = queue.shift()!;
    const col = index % cols;
    for (const next of [
      index - cols,
      index + cols,
      col > 0 ? index - 1 : -1,
      col < cols - 1 ? index + 1 : -1,
    ]) {
      if (open.has(next) && !reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const stranded = new Set([...open].filter((index) => !reachable.has(index)));
  let largest = 0;
  let largestBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  while (stranded.size > 0) {
    const start = stranded.values().next().value as number;
    const component = [start];
    stranded.delete(start);
    let size = 0;
    let bounds = { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: 0, maxY: 0 };
    while (component.length > 0) {
      const index = component.pop()!;
      size += 1;
      const point = center(index);
      bounds = {
        minX: Math.min(bounds.minX, point.x),
        minY: Math.min(bounds.minY, point.y),
        maxX: Math.max(bounds.maxX, point.x),
        maxY: Math.max(bounds.maxY, point.y),
      };
      const col = index % cols;
      for (const next of [
        index - cols,
        index + cols,
        col > 0 ? index - 1 : -1,
        col < cols - 1 ? index + 1 : -1,
      ]) {
        if (stranded.delete(next)) component.push(next);
      }
    }
    if (size > largest) {
      largest = size;
      largestBounds = bounds;
    }
  }

  const issues: FloorQualityIssue[] = [];

  const area = largest * CONNECTIVITY_CELL * CONNECTIVITY_CELL;
  if (area >= MIN_DISCONNECTED_AREA) {
    issues.push({
      floorId: floor.id,
      kind: "disconnected-area",
      message: `${floor.id} has about ${area} square units of open-looking floor disconnected from its arrival route near ${largestBounds!.minX},${largestBounds!.minY}–${largestBounds!.maxX},${largestBounds!.maxY}`,
    });
  }

  /**
   * Can a bot actually get to each flight from the rest of the floor?
   *
   * `blocked-stair-approach` samples points inside the entry half, so it only
   * sees an obstruction standing on the flight itself. It cannot see one standing
   * *outside* the shaft beside the door into it — which is how a shelf 16 units
   * off Beacon House's east core sealed the roof stair while every check passed.
   */
  for (const stair of floor.stairs) {
    const { entry } = stairHalves(stair);
    const target = { x: entry.x + entry.w / 2, y: entry.y + entry.h / 2 };
    const landing = nearestOpen(target);
    if (landing !== null && reachable.has(landing)) continue;
    // A seed stair is trivially its own component; nothing to say about it.
    if (floorSeeds(map, building, floor).some((seed) =>
      Math.hypot(seed.x - target.x, seed.y - target.y) <= radius)) continue;
    issues.push({
      floorId: floor.id,
      kind: "stair-unreachable",
      message: `${floor.id}: ${stair.id} cannot be reached from the rest of the floor — `
        + `something outside the shaft blocks the way in`,
    });
  }

  return issues;
}

/**
 * Nothing may hang off the edge of the floor it stands on.
 *
 * The contract's rule is silhouette == footprint == collider, and an object
 * reaching past its building's footprint breaks all three at once: it draws over
 * ground that belongs to the street, it implies a collider outside the building,
 * and on a roof it simply floats. Civic Tower's roof planter ran 20 units past
 * the south elevation and a terrace chair 8 past the east, which read exactly as
 * what it was — furniture sliding off the roof.
 *
 * Checked against the authored outline where there is one, so an L-plan is not
 * judged by its bounding box.
 */
function offFloorIssues(building: Building, floor: FloorPlan): FloorQualityIssue[] {
  const fp = building.footprint;
  const issues: FloorQualityIssue[] = [];
  for (const object of floor.objects) {
    const over = [
      object.x < fp.x ? `${fp.x - object.x} west` : null,
      object.y < fp.y ? `${fp.y - object.y} north` : null,
      object.x + object.w > fp.x + fp.w ? `${object.x + object.w - (fp.x + fp.w)} east` : null,
      object.y + object.h > fp.y + fp.h ? `${object.y + object.h - (fp.y + fp.h)} south` : null,
    ].filter(Boolean);
    if (!over.length) continue;
    issues.push({
      floorId: floor.id,
      kind: "object-off-floor",
      message: `${floor.id}: ${object.id} hangs ${over.join(" and ")} of the footprint`,
    });
  }
  return issues;
}

/**
 * A stair whose destination does not exist.
 *
 * Traversal resolves `toFloorId` at the moment a bot crosses the break line, so
 * a typo here is invisible until someone walks it — and then the bot changes
 * floor to nowhere. Cheap to check statically, so it is checked statically.
 */
function stairTargetIssues(map: MapDocument, building: Building, floor: FloorPlan): FloorQualityIssue[] {
  const known = new Set<string>([OUTDOOR_FLOOR_ID, ...building.floors.map((plan) => plan.id)]);
  // A stair may also lead into another building's floor, so check the whole map.
  for (const other of map.buildings) for (const plan of other.floors) known.add(plan.id);

  return floor.stairs
    .filter((stair) => !known.has(stair.toFloorId))
    .map((stair) => ({
      floorId: floor.id,
      kind: "stair-target-missing" as const,
      message: `${floor.id}: ${stair.id} leads to ${stair.toFloorId}, which is not a floor on this map`,
    }));
}

/**
 * Rejects common authoring failures before visual review. This is deliberately
 * map-generic: flagship buildings must pass it on every floor, not just at a
 * small list of named destinations.
 */
export function auditBuildingFloorQuality(
  map: MapDocument,
  buildingId: string,
  radius = defaultGameConfig.botRadius,
): FloorQualityIssue[] {
  const building = map.buildings.find((candidate) => candidate.id === buildingId);
  if (!building) {
    throw new Error(`Unknown building ${buildingId}`);
  }

  const issues: FloorQualityIssue[] = [];
  for (const floor of building.floors) {
    const solids = ownedSolids(floor);

    for (let leftIndex = 0; leftIndex < solids.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < solids.length; rightIndex += 1) {
        const left = solids[leftIndex];
        const right = solids[rightIndex];
        if (left.ownerId === right.ownerId || (left.ownerKind === "wall" && right.ownerKind === "wall")) continue;

        const overlapX = positiveOverlap(left.rect.x, left.rect.x + left.rect.w, right.rect.x, right.rect.x + right.rect.w);
        const overlapY = positiveOverlap(left.rect.y, left.rect.y + left.rect.h, right.rect.y, right.rect.y + right.rect.h);

        if (overlapX > 0 && overlapY > 0) {
          /**
           * A fixture set INTO a bigger one is an inset, not a collision.
           *
           * A sink in a worktop, a coffee machine standing on a counter: one physical
           * thing, and the host already blocks that space, so the union of the two
           * colliders is exactly the host. Nothing about navigation can depend on it,
           * which is the test — a contained rect cannot open or close a route.
           *
           * Only visible once fixtures became colliders, and flagging it would have
           * meant sliding sinks out of counters to satisfy a checker.
           */
          if (contains(left.rect, right.rect) || contains(right.rect, left.rect)) continue;
          if (left.ownerKind === "object" && right.ownerKind === "object") {
            issues.push({
              floorId: floor.id,
              kind: "solid-overlap",
              message: `${floor.id}: ${left.ownerId} overlaps ${right.ownerId}`,
            });
          }
          continue;
        }

        const gapX = axisGap(left.rect.x, left.rect.x + left.rect.w, right.rect.x, right.rect.x + right.rect.w);
        const gapY = axisGap(left.rect.y, left.rect.y + left.rect.h, right.rect.y, right.rect.y + right.rect.h);
        // A fixture near a perimeter wall is often a readable wall-backed
        // installation, not an invitation to walk behind it. The false-aisle
        // rule governs gaps between fixtures and stair guards; connectivity
        // separately rejects genuinely stranded floor pockets.
        const compareAsFixtures = left.ownerKind !== "wall" && right.ownerKind !== "wall";
        const horizontalFalseAisle = compareAsFixtures && overlapY >= radius * 2 && gapX > MAX_ATTACHED_SEAM && gapX < MIN_COMFORTABLE_AISLE;
        const verticalFalseAisle = compareAsFixtures && overlapX >= radius * 2 && gapY > MAX_ATTACHED_SEAM && gapY < MIN_COMFORTABLE_AISLE;
        const gapIsFilled = solids.some((middle, middleIndex) => {
          if (middleIndex === leftIndex || middleIndex === rightIndex || middle.ownerId === left.ownerId || middle.ownerId === right.ownerId) return false;
          if (horizontalFalseAisle) {
            const start = Math.min(left.rect.x + left.rect.w, right.rect.x + right.rect.w);
            const end = Math.max(left.rect.x, right.rect.x);
            return middle.rect.x <= start && middle.rect.x + middle.rect.w >= end &&
              positiveOverlap(left.rect.y, left.rect.y + left.rect.h, middle.rect.y, middle.rect.y + middle.rect.h) >= radius * 2;
          }
          if (verticalFalseAisle) {
            const start = Math.min(left.rect.y + left.rect.h, right.rect.y + right.rect.h);
            const end = Math.max(left.rect.y, right.rect.y);
            return middle.rect.y <= start && middle.rect.y + middle.rect.h >= end &&
              positiveOverlap(left.rect.x, left.rect.x + left.rect.w, middle.rect.x, middle.rect.x + middle.rect.w) >= radius * 2;
          }
          return false;
        });

        /**
         * A wall standing in the gap means there is no aisle to be false about.
         *
         * `gapIsFilled` asks whether something spans the gap end to end, which is the
         * right question for a fixture bridging two others and the wrong one for a wall:
         * a partition is thin, so it never spans a gap it divides, and what is left on
         * either side of it is two slivers rather than one route.
         *
         * Civic F2 is the case that found this. The archive stacks sit against the server
         * room's west face and the room's generator sits ten units inside it — 18 units
         * apart with a wall between them, reported as a false aisle nobody could walk
         * either half of. Under the old rule no fixture could be placed anywhere along
         * that wall, because everything inside the room is within 64 units of it, so a
         * 120-unit-wide strip was unfurnishable for a reason that was not about the strip.
         *
         * Same shape as the inset rule above: the audit is learning which pairs are not
         * pairs. A wall has to cross the whole shared band to count, so a fixture in a
         * doorway still cannot hide behind the jamb beside it.
         */
        const wallCrossesGap = (solids as { ownerKind: string; ownerId: string; rect: Rect }[]).some((middle) => {
          if (middle.ownerKind !== "wall") return false;
          if (middle.ownerId === left.ownerId || middle.ownerId === right.ownerId) return false;
          if (horizontalFalseAisle) {
            const start = Math.min(left.rect.x + left.rect.w, right.rect.x + right.rect.w);
            const end = Math.max(left.rect.x, right.rect.x);
            const inGap = middle.rect.x < end && middle.rect.x + middle.rect.w > start;
            const spansBand = middle.rect.y <= Math.max(left.rect.y, right.rect.y)
              && middle.rect.y + middle.rect.h >= Math.min(left.rect.y + left.rect.h, right.rect.y + right.rect.h);
            return inGap && spansBand;
          }
          if (verticalFalseAisle) {
            const start = Math.min(left.rect.y + left.rect.h, right.rect.y + right.rect.h);
            const end = Math.max(left.rect.y, right.rect.y);
            const inGap = middle.rect.y < end && middle.rect.y + middle.rect.h > start;
            const spansBand = middle.rect.x <= Math.max(left.rect.x, right.rect.x)
              && middle.rect.x + middle.rect.w >= Math.min(left.rect.x + left.rect.w, right.rect.x + right.rect.w);
            return inGap && spansBand;
          }
          return false;
        });

        // A small seam can join modules end-to-end, but it cannot justify two
        // long fixture faces compressed front-to-back. That creates repeated
        // counter bands with no usable work zone between them.
        const bothHorizontal = left.rect.w >= left.rect.h && right.rect.w >= right.rect.h;
        const bothVertical = left.rect.h > left.rect.w && right.rect.h > right.rect.w;
        const parallelHorizontalBanks = compareAsFixtures && bothHorizontal && overlapX >= radius * 5 && gapY > 0 && gapY < MIN_COMFORTABLE_AISLE;
        const parallelVerticalBanks = compareAsFixtures && bothVertical && overlapY >= radius * 5 && gapX > 0 && gapX < MIN_COMFORTABLE_AISLE;

        if (parallelHorizontalBanks || parallelVerticalBanks) {
          const gap = parallelHorizontalBanks ? gapY : gapX;
          issues.push({
            floorId: floor.id,
            kind: "parallel-banks",
            message: `${floor.id}: ${left.ownerId} and ${right.ownerId} form redundant parallel fixture banks only ${gap} units apart`,
          });
          continue;
        }

        if ((horizontalFalseAisle || verticalFalseAisle) && !gapIsFilled && !wallCrossesGap) {
          const gap = horizontalFalseAisle ? gapX : gapY;
          issues.push({
            floorId: floor.id,
            kind: "false-aisle",
            message: `${floor.id}: ${left.ownerId} and ${right.ownerId} leave a ${gap}-unit false aisle; join them within ${MAX_ATTACHED_SEAM} or open at least ${MIN_COMFORTABLE_AISLE}`,
          });
          continue;
        }

        /**
         * A small fixture parked against the long face of a much longer run,
         * clear of both its ends. Lot 6 shipped crates 6 units off a 220-unit
         * rack run: too narrow to enter, too deep to read as joined, and missed
         * by the false-aisle rule because a 34-unit crate never reaches the
         * 48-unit corridor threshold.
         *
         * Deliberately narrow. A gap at either fixture's *end* is exempt, because
         * that is the attached seam the contract allows, and comparable-length
         * fixtures are exempt because neither is "parked beside" the other.
         */
        if (compareAsFixtures) {
          const wedged = (["x", "y"] as const).find((axis) => {
            const gap = axis === "x" ? gapX : gapY;
            if (gap <= 0 || gap > MAX_ATTACHED_SEAM) return false;
            if ((axis === "x" ? gapY : gapX) !== 0) return false;
            if (runsAlong(left.rect, axis) || runsAlong(right.rect, axis)) return false;

            const cross = axis === "x" ? "h" : "w";
            const start = axis === "x" ? "y" : "x";
            const leftLen = left.rect[cross];
            const rightLen = right.rect[cross];
            const [run, span] = leftLen >= rightLen ? [left.rect, right.rect] : [right.rect, left.rect];
            if (run[cross] < span[cross] * PARKED_LENGTH_RATIO) return false;
            return offsetFromBothEnds(span[start], span[start] + span[cross], run[start], run[start] + run[cross]);
          });

          if (wedged) {
            issues.push({
              floorId: floor.id,
              kind: "wedged-fixture",
              message: `${floor.id}: ${left.ownerId} is parked ${wedged === "x" ? gapX : gapY} units off the face of ${right.ownerId}, clear of both its ends; sit it flush against a run end or open at least ${MIN_COMFORTABLE_AISLE}`,
            });
          }
        }
      }
    }

    /**
     * Connectivity reads the *true* geometry, not the rect view above: a diagonal
     * or curved partition has no honest rectangle, and treating its bounding box
     * as solid would wall off floor a bot can actually walk.
     */
    const blocking: Solid[] = [
      ...floor.objects.flatMap((object) => objectCollisionRects(object).map(rectSolid)),
      ...floor.stairs.flatMap((stair) => stairGuardRects(stair).map(rectSolid)),
      ...floor.walls.map(rectSolid),
      ...(floor.barriers ?? []).flatMap((barrier) => barrier.solids),
    ];
    issues.push(...offFloorIssues(building, floor));
    issues.push(...stairTargetIssues(map, building, floor));
    issues.push(...connectivityIssues(map, building, floor, blocking, radius));

    /**
     * You have to be able to walk onto the flight.
     *
     * `blocked-stair-side` only ever looked at freestanding `openEnd` stairs, so
     * an enclosed stair core — which is most of them — was never checked at all,
     * and a bin parked across the bottom of a flight sealed a whole floor with
     * nothing to flag it. This walks the entry half from its outer end to the
     * break line and asks whether a full-size bot fits the whole way.
     */
    for (const stair of floor.stairs) {
      const { entry, vertical } = stairHalves(stair);
      const outerFirst = vertical ? entry.y === stair.rect.y : entry.x === stair.rect.x;
      /**
       * Sampled from a bot-radius inside the flight's outer end to the break
       * line. The outer end itself is skipped on purpose: on an enclosed stair
       * it sits against the core wall, which is not an obstruction — you step on
       * from the side, through the door.
       */
      const run = vertical ? entry.h : entry.w;
      const first = Math.min(0.45, radius / Math.max(run, 1));
      const steps = 8;
      /**
       * Full radius, not the `radius - 1` the other rules use. That one unit of
       * slack exists to stop a fixture resting exactly against a wall reading as
       * an obstruction, and it is the wrong trade at a stair: a flight a bot can
       * only reach by threading a 47-unit gap is a floor the player cannot leave.
       */
      const blocked = Array.from({ length: steps + 1 }, (_, index) => {
        const along = first + (1 - first) * (index / steps);
        const t = outerFirst ? along : 1 - along;
        return vertical
          ? { x: entry.x + entry.w / 2, y: entry.y + entry.h * t }
          : { x: entry.x + entry.w * t, y: entry.y + entry.h / 2 };
      }).some((point) => !circleClearsSolids(point, radius, blocking));

      if (blocked) {
        issues.push({
          floorId: floor.id,
          kind: "blocked-stair-approach",
          message: `${floor.id}: ${stair.id} cannot be walked onto — something stands in the entry half of the flight`,
        });
      }
    }

    for (const stair of floor.stairs.filter((candidate) => candidate.access === "openEnd")) {
      const { entry, vertical } = stairHalves(stair);
      const midpoint = { x: entry.x + entry.w / 2, y: entry.y + entry.h / 2 };
      const sidePoints = vertical
        ? [
            { x: stair.rect.x - radius - 4, y: midpoint.y },
            { x: stair.rect.x + stair.rect.w + radius + 4, y: midpoint.y },
          ]
        : [
            { x: midpoint.x, y: stair.rect.y - radius - 4 },
            { x: midpoint.x, y: stair.rect.y + stair.rect.h + radius + 4 },
          ];
      const hasClearSide = sidePoints.some((point) =>
        point.x >= building.footprint.x + radius &&
        point.x <= building.footprint.x + building.footprint.w - radius &&
        point.y >= building.footprint.y + radius &&
        point.y <= building.footprint.y + building.footprint.h - radius &&
        circleClearsSolids(point, radius - 1, blocking));

      if (!hasClearSide) {
        issues.push({
          floorId: floor.id,
          kind: "blocked-stair-side",
          message: `${floor.id}: ${stair.id} has no full-size side exit from its active half`,
        });
      }
    }
  }

  return issues;
}

/**
 * Dot placement, over the whole map including the street.
 *
 * Dots are the loot economy, so a badly placed one is not cosmetic: a Dot inside a
 * collider is scenery nobody can collect, and two Dots inside a bot diameter are
 * one pickup with a wasted slot. Downtown had both — six overlapping pairs, the
 * closest 5.7 units apart, and four Dots a bot could not stand on.
 *
 * The overlaps were structural rather than careless. `addBlueprintSpawns` places a
 * Dot beside every scannable object, and the authored Dots had been placed at the
 * same interesting objects, so the two collided by construction. The placer is
 * separation-aware now; this is the check that keeps it honest.
 *
 * Grouped by *physics* floor, not authored floor, because every GROUND floor shares
 * the outdoor plane — a Dot just inside a door and one just outside it are the same
 * few square metres.
 */
export function auditDotPlacement(map: MapDocument, radius = defaultGameConfig.botRadius): FloorQualityIssue[] {
  const groups = new Map<string, Array<{ dot: DotSpawn; floorId: string }>>();
  const add = (physics: string, floorId: string, dots: readonly DotSpawn[]): void => {
    const list = groups.get(physics) ?? [];
    for (const dot of dots) list.push({ dot, floorId });
    groups.set(physics, list);
  };
  add(OUTDOOR_FLOOR_ID, OUTDOOR_FLOOR_ID, map.outdoor.dotSpawns);
  for (const building of map.buildings) {
    for (const floor of building.floors) {
      add(isGroundFloor(floor) ? OUTDOOR_FLOOR_ID : physicsFloorId(map, floor.id), floor.id, floor.dotSpawns);
    }
  }

  const issues: FloorQualityIssue[] = [];
  for (const [physics, placed] of groups) {
    const solids = collectSolids(map, physics);
    for (const { dot, floorId } of placed) {
      if (circleClearsSolids(dot.position, radius, solids)) continue;
      issues.push({
        floorId,
        kind: "dot-unreachable",
        message: `${floorId}: ${dot.id} at ${dot.position.x},${dot.position.y} is somewhere a bot cannot stand`,
      });
    }
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const gap = Math.hypot(a.dot.position.x - b.dot.position.x, a.dot.position.y - b.dot.position.y);
        if (gap >= MIN_DOT_SEPARATION) continue;
        issues.push({
          floorId: a.floorId,
          kind: "dot-crowded",
          message: `${a.floorId}: ${a.dot.id} and ${b.dot.id} are ${gap.toFixed(1)} apart; `
            + `under ${MIN_DOT_SEPARATION} they are one pickup, not two`,
        });
      }
    }
  }
  return issues;
}
