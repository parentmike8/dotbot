import {
  floorPlanById,
  isGroundFloor,
  isSolidObject,
  physicsFloorId as normalizePhysicsFloorId,
} from "./mapModel";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { MapDocument, Rect, Vec2 } from "./types";

/**
 * Deterministic, static-map navigation for local DotBot AI.
 *
 * Paths include both endpoints: `[start, ...waypoints, goal]`. An empty path
 * means the requested floor is unknown, an endpoint is obstructed, the search
 * budget was exhausted, or the goal is unreachable.
 */

const MIN_CELL_SIZE = 6;
const MAX_CELL_SIZE = 8;
const MIN_SPATIAL_BIN_SIZE = 64;
const ANCHOR_RADIUS_CELLS = 3;
const MAX_ANCHORS = 12;
const MAX_GRID_NODES = 250_000;
const MAX_EXPANDED_NODES = 80_000;
const MAX_SMOOTHING_CHECKS = 8_192;
const GEOMETRY_EPSILON = 1e-7;

const CARDINAL_COST = 1;
const DIAGONAL_COST = Math.SQRT2;

/** Fixed ordering and heap tie-breaking make identical calls reproducible. */
const NEIGHBORS = [
  { dc: 1, dr: 0, cost: CARDINAL_COST },
  { dc: 0, dr: 1, cost: CARDINAL_COST },
  { dc: -1, dr: 0, cost: CARDINAL_COST },
  { dc: 0, dr: -1, cost: CARDINAL_COST },
  { dc: 1, dr: 1, cost: DIAGONAL_COST },
  { dc: -1, dr: 1, cost: DIAGONAL_COST },
  { dc: -1, dr: -1, cost: DIAGONAL_COST },
  { dc: 1, dr: -1, cost: DIAGONAL_COST },
] as const;

/** Only these directions are built; their reciprocal edge is added at once. */
const FORWARD_DIRECTIONS = [0, 1, 4, 5] as const;
const OPPOSITE_DIRECTION = [2, 3, 0, 1, 6, 7, 4, 5] as const;

type CollisionSignature = {
  hash: number;
  count: number;
};

type CollisionIndex = {
  obstacles: Rect[];
  bins: number[][];
  binSize: number;
  cols: number;
  rows: number;
  marks: Uint32Array;
  generation: number;
};

type NavigationGrid = {
  map: MapDocument;
  floorId: string;
  radius: number;
  collision: CollisionIndex;
  cellSize: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  neighborOffsets: Int32Array;
  /** 1 = traversable, 2 = obstructed. Populated by prepareGrid. */
  passability: Uint8Array;
  /** One bit per direction in NEIGHBORS. */
  connections: Uint8Array;
  /** Connected-component id for every traversable node. */
  components: Int32Array;
  prepared: boolean;
  gScore: Float64Array;
  cameFrom: Int32Array;
  seenGeneration: Uint32Array;
  closedGeneration: Uint32Array;
  goalGeneration: Uint32Array;
  searchGeneration: number;
  open: OpenHeap;
};

type CachedGrid = {
  signature: CollisionSignature;
  grid: NavigationGrid;
};

type AnchorNode = {
  index: number;
  cost: number;
};

/** Weak map ownership prevents old maps from being retained by navigation. */
const gridCache = new WeakMap<MapDocument, Map<string, CachedGrid>>();

/** Reusable, allocation-light binary heap for one cached navigation grid. */
class OpenHeap {
  private readonly indices: number[] = [];
  private readonly gs: number[] = [];
  private readonly hs: number[] = [];
  private readonly sequences: number[] = [];
  private count = 0;

  index = -1;
  g = 0;
  h = 0;
  sequence = 0;

  get length(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
  }

  push(index: number, g: number, h: number, sequence: number): void {
    let target = this.count;
    this.count += 1;

    while (target > 0) {
      const parent = Math.floor((target - 1) / 2);

      if (
        compareOpenValues(
          this.gs[parent],
          this.hs[parent],
          this.indices[parent],
          this.sequences[parent],
          g,
          h,
          index,
          sequence,
        ) <= 0
      ) {
        break;
      }

      this.copy(parent, target);
      target = parent;
    }

    this.set(target, index, g, h, sequence);
  }

  pop(): boolean {
    if (this.count === 0) {
      return false;
    }

    this.index = this.indices[0];
    this.g = this.gs[0];
    this.h = this.hs[0];
    this.sequence = this.sequences[0];

    this.count -= 1;

    if (this.count === 0) {
      return true;
    }

    const tailIndex = this.indices[this.count];
    const tailG = this.gs[this.count];
    const tailH = this.hs[this.count];
    const tailSequence = this.sequences[this.count];
    let target = 0;

    while (true) {
      const left = target * 2 + 1;

      if (left >= this.count) {
        break;
      }

      const right = left + 1;
      let child = left;

      if (
        right < this.count &&
        compareOpenValues(
          this.gs[right],
          this.hs[right],
          this.indices[right],
          this.sequences[right],
          this.gs[left],
          this.hs[left],
          this.indices[left],
          this.sequences[left],
        ) < 0
      ) {
        child = right;
      }

      if (
        compareOpenValues(
          this.gs[child],
          this.hs[child],
          this.indices[child],
          this.sequences[child],
          tailG,
          tailH,
          tailIndex,
          tailSequence,
        ) >= 0
      ) {
        break;
      }

      this.copy(child, target);
      target = child;
    }

    this.set(target, tailIndex, tailG, tailH, tailSequence);
    return true;
  }

  private copy(source: number, target: number): void {
    this.indices[target] = this.indices[source];
    this.gs[target] = this.gs[source];
    this.hs[target] = this.hs[source];
    this.sequences[target] = this.sequences[source];
  }

  private set(target: number, index: number, g: number, h: number, sequence: number): void {
    this.indices[target] = index;
    this.gs[target] = g;
    this.hs[target] = h;
    this.sequences[target] = sequence;
  }
}

function compareOpenValues(
  aG: number,
  aH: number,
  aIndex: number,
  aSequence: number,
  bG: number,
  bH: number,
  bIndex: number,
  bSequence: number,
): number {
  const fDelta = aG + aH - (bG + bH);

  if (Math.abs(fDelta) > GEOMETRY_EPSILON) {
    return fDelta;
  }

  const hDelta = aH - bH;

  if (Math.abs(hDelta) > GEOMETRY_EPSILON) {
    return hDelta;
  }

  if (aIndex !== bIndex) {
    return aIndex - bIndex;
  }

  return aSequence - bSequence;
}

/**
 * Find a collision-safe path on one Rapier physics floor.
 *
 * Ground plans share `outdoor`, so requesting either `outdoor` or a GROUND
 * plan id includes outdoor collision plus every building's GROUND collision.
 */
export function findNavigationPath(
  map: MapDocument,
  requestedFloorId: string,
  start: Vec2,
  goal: Vec2,
  radius: number,
): Vec2[] {
  if (!validRequest(map, start, goal, radius)) {
    return [];
  }

  const floorId = normalizePhysicsFloorId(map, requestedFloorId);
  const signature = collisionSignatureForFloor(map, floorId);

  if (!signature) {
    return [];
  }

  const grid = cachedGrid(map, floorId, radius, signature);

  if (!grid) {
    return [];
  }

  if (!pointIsNavigable(grid, start) || !pointIsNavigable(grid, goal)) {
    return [];
  }

  if (samePoint(start, goal)) {
    return [{ ...start }];
  }

  if (segmentIsNavigable(grid, start, goal)) {
    return [{ ...start }, { ...goal }];
  }

  prepareGrid(grid);

  const startAnchors = anchorNodes(grid, start);
  const goalAnchors = anchorNodes(grid, goal);

  if (startAnchors.length === 0 || goalAnchors.length === 0 || !anchorsShareComponent(grid, startAnchors, goalAnchors)) {
    return [];
  }

  const generation = nextSearchGeneration(grid);
  let sequence = 0;

  for (const goalAnchor of goalAnchors) {
    if (anchorHasMatchingComponent(grid, goalAnchor, startAnchors)) {
      grid.goalGeneration[goalAnchor.index] = generation;
    }
  }

  grid.open.reset();

  for (const startAnchor of startAnchors) {
    if (!anchorHasMatchingComponent(grid, startAnchor, goalAnchors)) {
      continue;
    }

    const index = startAnchor.index;

    if (grid.seenGeneration[index] === generation && startAnchor.cost + GEOMETRY_EPSILON >= grid.gScore[index]) {
      continue;
    }

    grid.seenGeneration[index] = generation;
    grid.gScore[index] = startAnchor.cost;
    grid.cameFrom[index] = -1;
    grid.open.push(index, startAnchor.cost, distance(nodePoint(grid, index), goal), sequence++);
  }

  let expanded = 0;
  let reached = -1;

  while (grid.open.length > 0 && expanded < MAX_EXPANDED_NODES) {
    grid.open.pop();
    const currentIndex = grid.open.index;
    const currentG = grid.open.g;

    if (
      grid.closedGeneration[currentIndex] === generation ||
      grid.seenGeneration[currentIndex] !== generation ||
      Math.abs(currentG - grid.gScore[currentIndex]) > GEOMETRY_EPSILON
    ) {
      continue;
    }

    if (grid.goalGeneration[currentIndex] === generation) {
      reached = currentIndex;
      break;
    }

    grid.closedGeneration[currentIndex] = generation;
    expanded += 1;
    const connectionMask = grid.connections[currentIndex];

    for (let direction = 0; direction < NEIGHBORS.length; direction += 1) {
      if ((connectionMask & (1 << direction)) === 0) {
        continue;
      }

      const nextIndex = currentIndex + grid.neighborOffsets[direction];

      if (grid.closedGeneration[nextIndex] === generation) {
        continue;
      }

      const tentative = currentG + NEIGHBORS[direction].cost * grid.cellSize;

      if (
        grid.seenGeneration[nextIndex] === generation &&
        tentative + GEOMETRY_EPSILON >= grid.gScore[nextIndex]
      ) {
        continue;
      }

      grid.seenGeneration[nextIndex] = generation;
      grid.cameFrom[nextIndex] = currentIndex;
      grid.gScore[nextIndex] = tentative;
      grid.open.push(nextIndex, tentative, distance(nodePoint(grid, nextIndex), goal), sequence++);
    }
  }

  if (reached < 0) {
    return [];
  }

  const gridPath: Vec2[] = [];
  let cursor = reached;

  while (cursor >= 0) {
    gridPath.push(nodePoint(grid, cursor));
    cursor = grid.cameFrom[cursor];
  }

  gridPath.reverse();
  const rawPath = deduplicatePath([{ ...start }, ...gridPath, { ...goal }]);
  return smoothPath(grid, rawPath);
}

/**
 * Build and cache navigation graphs for every distinct physics floor.
 *
 * Ordering is deterministic: the shared outdoor/GROUND plane first, followed
 * by non-GROUND floors in building and floor document order. Invalid map data
 * or an unusable radius is ignored so loading code can call this defensively.
 */
export function prewarmNavigation(map: MapDocument, radius: number): void {
  if (!validPrewarmRequest(map, radius)) {
    return;
  }

  const floorIds: string[] = [OUTDOOR_FLOOR_ID];
  const seen = new Set<string>(floorIds);

  for (const building of map.buildings) {
    for (const floor of building.floors) {
      const floorId = normalizePhysicsFloorId(map, floor.id);

      if (!seen.has(floorId)) {
        seen.add(floorId);
        floorIds.push(floorId);
      }
    }
  }

  for (const floorId of floorIds) {
    const signature = collisionSignatureForFloor(map, floorId);

    if (!signature) {
      continue;
    }

    const grid = cachedGrid(map, floorId, radius, signature);

    if (grid) {
      prepareGrid(grid);
    }
  }
}

function validRequest(map: MapDocument, start: Vec2, goal: Vec2, radius: number): boolean {
  return (
    Number.isFinite(map.width) &&
    Number.isFinite(map.height) &&
    map.width > 0 &&
    map.height > 0 &&
    Number.isFinite(radius) &&
    radius >= 0 &&
    radius * 2 <= map.width &&
    radius * 2 <= map.height &&
    Number.isFinite(start.x) &&
    Number.isFinite(start.y) &&
    Number.isFinite(goal.x) &&
    Number.isFinite(goal.y)
  );
}

function validPrewarmRequest(map: MapDocument, radius: number): boolean {
  if (
    !map ||
    typeof map !== "object" ||
    !Number.isFinite(map.width) ||
    !Number.isFinite(map.height) ||
    map.width <= 0 ||
    map.height <= 0 ||
    !Number.isFinite(radius) ||
    radius < 0 ||
    radius * 2 > map.width ||
    radius * 2 > map.height ||
    !map.outdoor ||
    !Array.isArray(map.outdoor.walls) ||
    !Array.isArray(map.outdoor.objects) ||
    !Array.isArray(map.buildings)
  ) {
    return false;
  }

  if (![...map.outdoor.walls, ...map.outdoor.objects].every(validCollisionRect)) {
    return false;
  }

  for (const building of map.buildings) {
    if (!building || !Array.isArray(building.floors)) {
      return false;
    }

    for (const floor of building.floors) {
      if (
        !floor ||
        typeof floor.id !== "string" ||
        floor.id.length === 0 ||
        !Array.isArray(floor.walls) ||
        !Array.isArray(floor.objects) ||
        ![...floor.walls, ...floor.objects].every(validCollisionRect)
      ) {
        return false;
      }
    }
  }

  return true;
}

function validCollisionRect(rect: Rect): boolean {
  return (
    rect !== null &&
    typeof rect === "object" &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.w) &&
    Number.isFinite(rect.h) &&
    rect.w >= 0 &&
    rect.h >= 0
  );
}

function cachedGrid(
  map: MapDocument,
  floorId: string,
  radius: number,
  signature: CollisionSignature,
): NavigationGrid | null {
  let byFloor = gridCache.get(map);

  if (!byFloor) {
    byFloor = new Map();
    gridCache.set(map, byFloor);
  }

  const key = `${floorId}\u0000${Object.is(radius, -0) ? 0 : radius}`;
  const cached = byFloor.get(key);

  if (cached && cached.signature.hash === signature.hash && cached.signature.count === signature.count) {
    return cached.grid;
  }

  const obstacles = collisionRectsForFloor(map, floorId);

  if (!obstacles) {
    return null;
  }

  const grid = buildGrid(map, floorId, obstacles, radius);

  if (!grid) {
    return null;
  }

  byFloor.set(key, { signature, grid });
  return grid;
}

/**
 * Lightweight geometry fingerprint. It invalidates cached graphs when a map
 * editor mutates collision arrays or rectangle geometry in place.
 */
function collisionSignatureForFloor(map: MapDocument, floorId: string): CollisionSignature | null {
  let hash = 0x811c9dc5;
  let count = 0;
  const include = (rect: Rect) => {
    hash = hashNumber(hash, rect.x);
    hash = hashNumber(hash, rect.y);
    hash = hashNumber(hash, rect.w);
    hash = hashNumber(hash, rect.h);
    count += 1;
  };

  hash = hashNumber(hash, map.width);
  hash = hashNumber(hash, map.height);

  if (floorId === OUTDOOR_FLOOR_ID) {
    for (const wall of map.outdoor.walls) {
      include(wall);
    }

    for (const object of map.outdoor.objects) {
      if (isSolidObject(object)) {
        include(object);
      }
    }

    for (const building of map.buildings) {
      for (const floor of building.floors) {
        if (!isGroundFloor(floor)) {
          continue;
        }

        for (const wall of floor.walls) {
          include(wall);
        }

        for (const object of floor.objects) {
          if (isSolidObject(object)) {
            include(object);
          }
        }
      }
    }

    return { hash, count };
  }

  const plan = floorPlanById(map, floorId);

  if (!plan) {
    return null;
  }

  for (const wall of plan.walls) {
    include(wall);
  }

  for (const object of plan.objects) {
    if (isSolidObject(object)) {
      include(object);
    }
  }

  return { hash, count };
}

const floatBits = new DataView(new ArrayBuffer(8));

function hashNumber(hash: number, value: number): number {
  floatBits.setFloat64(0, value, true);
  hash = mixHash(hash, floatBits.getUint32(0, true));
  return mixHash(hash, floatBits.getUint32(4, true));
}

function mixHash(hash: number, value: number): number {
  return Math.imul((hash ^ value) >>> 0, 0x01000193) >>> 0;
}

function collisionRectsForFloor(map: MapDocument, floorId: string): Rect[] | null {
  if (floorId === OUTDOOR_FLOOR_ID) {
    const result: Rect[] = [
      ...map.outdoor.walls,
      ...map.outdoor.objects.filter(isSolidObject),
    ];

    for (const building of map.buildings) {
      for (const floor of building.floors) {
        if (isGroundFloor(floor)) {
          result.push(...floor.walls, ...floor.objects.filter(isSolidObject));
        }
      }
    }

    return result;
  }

  const plan = floorPlanById(map, floorId);
  return plan ? [...plan.walls, ...plan.objects.filter(isSolidObject)] : null;
}

function buildGrid(
  map: MapDocument,
  floorId: string,
  obstacles: Rect[],
  radius: number,
): NavigationGrid | null {
  const cellSize = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, radius / 3 || MIN_CELL_SIZE));
  const minX = radius;
  const minY = radius;
  const cols = Math.floor((map.width - radius * 2) / cellSize) + 1;
  const rows = Math.floor((map.height - radius * 2) / cellSize) + 1;

  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols * rows > MAX_GRID_NODES) {
    return null;
  }

  const nodeCount = cols * rows;
  return {
    map,
    floorId,
    radius,
    collision: buildCollisionIndex(map, obstacles, radius),
    cellSize,
    minX,
    minY,
    cols,
    rows,
    neighborOffsets: Int32Array.from([1, cols, -1, -cols, cols + 1, cols - 1, -cols - 1, -cols + 1]),
    passability: new Uint8Array(nodeCount),
    connections: new Uint8Array(nodeCount),
    components: new Int32Array(nodeCount),
    prepared: false,
    gScore: new Float64Array(nodeCount),
    cameFrom: new Int32Array(nodeCount),
    seenGeneration: new Uint32Array(nodeCount),
    closedGeneration: new Uint32Array(nodeCount),
    goalGeneration: new Uint32Array(nodeCount),
    searchGeneration: 0,
    open: new OpenHeap(),
  };
}

function buildCollisionIndex(map: MapDocument, obstacles: Rect[], radius: number): CollisionIndex {
  const binSize = Math.max(MIN_SPATIAL_BIN_SIZE, radius * 4);
  const cols = Math.max(1, Math.ceil(map.width / binSize));
  const rows = Math.max(1, Math.ceil(map.height / binSize));
  const bins: number[][] = Array.from({ length: cols * rows }, () => []);

  for (let index = 0; index < obstacles.length; index += 1) {
    const rect = obstacles[index];

    if (rect.x + rect.w < 0 || rect.y + rect.h < 0 || rect.x > map.width || rect.y > map.height) {
      continue;
    }

    const minCol = clampIndex(Math.floor(rect.x / binSize), cols);
    const maxCol = clampIndex(Math.floor((rect.x + rect.w) / binSize), cols);
    const minRow = clampIndex(Math.floor(rect.y / binSize), rows);
    const maxRow = clampIndex(Math.floor((rect.y + rect.h) / binSize), rows);

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        bins[row * cols + col].push(index);
      }
    }
  }

  return {
    obstacles,
    bins,
    binSize,
    cols,
    rows,
    marks: new Uint32Array(obstacles.length),
    generation: 0,
  };
}

function clampIndex(value: number, count: number): number {
  return Math.max(0, Math.min(count - 1, value));
}

function prepareGrid(grid: NavigationGrid): void {
  if (grid.prepared) {
    return;
  }

  const nodeCount = grid.cols * grid.rows;

  for (let index = 0; index < nodeCount; index += 1) {
    grid.passability[index] = pointClearsObstacles(grid.collision, nodePoint(grid, index), grid.radius) ? 1 : 2;
  }

  for (let index = 0; index < nodeCount; index += 1) {
    if (grid.passability[index] !== 1) {
      continue;
    }

    const col = index % grid.cols;
    const row = Math.floor(index / grid.cols);
    const point = nodePoint(grid, index);

    for (const direction of FORWARD_DIRECTIONS) {
      const neighbor = NEIGHBORS[direction];
      const nextCol = col + neighbor.dc;
      const nextRow = row + neighbor.dr;

      if (nextCol < 0 || nextCol >= grid.cols || nextRow < 0 || nextRow >= grid.rows) {
        continue;
      }

      const nextIndex = nextRow * grid.cols + nextCol;

      if (grid.passability[nextIndex] !== 1) {
        continue;
      }

      if (neighbor.dc !== 0 && neighbor.dr !== 0) {
        const sideA = row * grid.cols + nextCol;
        const sideB = nextRow * grid.cols + col;

        if (grid.passability[sideA] !== 1 || grid.passability[sideB] !== 1) {
          continue;
        }
      }

      if (!segmentClearsObstacles(grid.collision, point, nodePoint(grid, nextIndex), grid.radius)) {
        continue;
      }

      grid.connections[index] |= 1 << direction;
      grid.connections[nextIndex] |= 1 << OPPOSITE_DIRECTION[direction];
    }
  }

  labelComponents(grid);
  grid.prepared = true;
}

function labelComponents(grid: NavigationGrid): void {
  const queue = new Int32Array(grid.cols * grid.rows);
  let component = 0;

  for (let index = 0; index < grid.components.length; index += 1) {
    if (grid.passability[index] !== 1 || grid.components[index] !== 0) {
      continue;
    }

    component += 1;
    let head = 0;
    let tail = 1;
    queue[0] = index;
    grid.components[index] = component;

    while (head < tail) {
      const current = queue[head++];
      const mask = grid.connections[current];

      for (let direction = 0; direction < NEIGHBORS.length; direction += 1) {
        if ((mask & (1 << direction)) === 0) {
          continue;
        }

        const next = current + grid.neighborOffsets[direction];

        if (grid.components[next] !== 0) {
          continue;
        }

        grid.components[next] = component;
        queue[tail++] = next;
      }
    }
  }
}

function nodePoint(grid: NavigationGrid, index: number): Vec2 {
  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);
  return {
    x: grid.minX + col * grid.cellSize,
    y: grid.minY + row * grid.cellSize,
  };
}

function anchorNodes(grid: NavigationGrid, point: Vec2): AnchorNode[] {
  const baseCol = Math.round((point.x - grid.minX) / grid.cellSize);
  const baseRow = Math.round((point.y - grid.minY) / grid.cellSize);
  const candidates: AnchorNode[] = [];

  for (let dr = -ANCHOR_RADIUS_CELLS; dr <= ANCHOR_RADIUS_CELLS; dr += 1) {
    for (let dc = -ANCHOR_RADIUS_CELLS; dc <= ANCHOR_RADIUS_CELLS; dc += 1) {
      const col = baseCol + dc;
      const row = baseRow + dr;

      if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) {
        continue;
      }

      const index = row * grid.cols + col;

      if (grid.passability[index] !== 1) {
        continue;
      }

      const candidate = nodePoint(grid, index);

      if (!segmentIsNavigable(grid, point, candidate)) {
        continue;
      }

      candidates.push({ index, cost: distance(point, candidate) });
    }
  }

  candidates.sort((a, b) => a.cost - b.cost || a.index - b.index);
  return candidates.slice(0, MAX_ANCHORS);
}

function anchorsShareComponent(grid: NavigationGrid, a: AnchorNode[], b: AnchorNode[]): boolean {
  for (const first of a) {
    if (anchorHasMatchingComponent(grid, first, b)) {
      return true;
    }
  }

  return false;
}

function anchorHasMatchingComponent(grid: NavigationGrid, anchor: AnchorNode, others: AnchorNode[]): boolean {
  const component = grid.components[anchor.index];
  return component !== 0 && others.some((other) => grid.components[other.index] === component);
}

function nextSearchGeneration(grid: NavigationGrid): number {
  grid.searchGeneration = (grid.searchGeneration + 1) >>> 0;

  if (grid.searchGeneration === 0) {
    grid.seenGeneration.fill(0);
    grid.closedGeneration.fill(0);
    grid.goalGeneration.fill(0);
    grid.searchGeneration = 1;
  }

  return grid.searchGeneration;
}

function pointIsNavigable(grid: NavigationGrid, point: Vec2): boolean {
  if (
    point.x < grid.radius - GEOMETRY_EPSILON ||
    point.y < grid.radius - GEOMETRY_EPSILON ||
    point.x > grid.map.width - grid.radius + GEOMETRY_EPSILON ||
    point.y > grid.map.height - grid.radius + GEOMETRY_EPSILON
  ) {
    return false;
  }

  return pointClearsObstacles(grid.collision, point, grid.radius);
}

function segmentIsNavigable(grid: NavigationGrid, start: Vec2, end: Vec2): boolean {
  return (
    pointIsNavigable(grid, start) &&
    pointIsNavigable(grid, end) &&
    segmentClearsObstacles(grid.collision, start, end, grid.radius)
  );
}

function pointClearsObstacles(collision: CollisionIndex, point: Vec2, radius: number): boolean {
  const generation = nextCollisionGeneration(collision);
  const minCol = clampIndex(Math.floor((point.x - radius) / collision.binSize), collision.cols);
  const maxCol = clampIndex(Math.floor((point.x + radius) / collision.binSize), collision.cols);
  const minRow = clampIndex(Math.floor((point.y - radius) / collision.binSize), collision.rows);
  const maxRow = clampIndex(Math.floor((point.y + radius) / collision.binSize), collision.rows);
  const radiusSquared = radius * radius;

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      for (const index of collision.bins[row * collision.cols + col]) {
        if (collision.marks[index] === generation) {
          continue;
        }

        collision.marks[index] = generation;

        if (pointToRectDistanceSquared(point, collision.obstacles[index]) + GEOMETRY_EPSILON < radiusSquared) {
          return false;
        }
      }
    }
  }

  return true;
}

function segmentClearsObstacles(collision: CollisionIndex, start: Vec2, end: Vec2, radius: number): boolean {
  const generation = nextCollisionGeneration(collision);
  const minCol = clampIndex(Math.floor((Math.min(start.x, end.x) - radius) / collision.binSize), collision.cols);
  const maxCol = clampIndex(Math.floor((Math.max(start.x, end.x) + radius) / collision.binSize), collision.cols);
  const minRow = clampIndex(Math.floor((Math.min(start.y, end.y) - radius) / collision.binSize), collision.rows);
  const maxRow = clampIndex(Math.floor((Math.max(start.y, end.y) + radius) / collision.binSize), collision.rows);
  const radiusSquared = radius * radius;

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      for (const index of collision.bins[row * collision.cols + col]) {
        if (collision.marks[index] === generation) {
          continue;
        }

        collision.marks[index] = generation;

        if (
          segmentToRectDistanceSquared(start, end, collision.obstacles[index]) + GEOMETRY_EPSILON <
          radiusSquared
        ) {
          return false;
        }
      }
    }
  }

  return true;
}

function nextCollisionGeneration(collision: CollisionIndex): number {
  collision.generation = (collision.generation + 1) >>> 0;

  if (collision.generation === 0) {
    collision.marks.fill(0);
    collision.generation = 1;
  }

  return collision.generation;
}

function pointToRectDistanceSquared(point: Vec2, rect: Rect): number {
  const closestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.h));
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  return dx * dx + dy * dy;
}

function segmentToRectDistanceSquared(start: Vec2, end: Vec2, rect: Rect): number {
  if (segmentIntersectsRect(start, end, rect)) {
    return 0;
  }

  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.x + rect.w, y: rect.y };
  const bottomRight = { x: rect.x + rect.w, y: rect.y + rect.h };
  const bottomLeft = { x: rect.x, y: rect.y + rect.h };

  return Math.min(
    segmentToSegmentDistanceSquared(start, end, topLeft, topRight),
    segmentToSegmentDistanceSquared(start, end, topRight, bottomRight),
    segmentToSegmentDistanceSquared(start, end, bottomRight, bottomLeft),
    segmentToSegmentDistanceSquared(start, end, bottomLeft, topLeft),
  );
}

function segmentIntersectsRect(start: Vec2, end: Vec2, rect: Rect): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let tMin = 0;
  let tMax = 1;

  for (const [origin, delta, min, max] of [
    [start.x, dx, rect.x, rect.x + rect.w],
    [start.y, dy, rect.y, rect.y + rect.h],
  ] as const) {
    if (Math.abs(delta) <= GEOMETRY_EPSILON) {
      if (origin < min || origin > max) {
        return false;
      }

      continue;
    }

    let near = (min - origin) / delta;
    let far = (max - origin) / delta;

    if (near > far) {
      [near, far] = [far, near];
    }

    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);

    if (tMin > tMax) {
      return false;
    }
  }

  return true;
}

function segmentToSegmentDistanceSquared(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) {
    return 0;
  }

  return Math.min(
    pointToSegmentDistanceSquared(a, c, d),
    pointToSegmentDistanceSquared(b, c, d),
    pointToSegmentDistanceSquared(c, a, b),
    pointToSegmentDistanceSquared(d, a, b),
  );
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);

  if (
    ((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) ||
      (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON)) &&
    ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) ||
      (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))
  ) {
    return true;
  }

  return (
    (Math.abs(abC) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d))
  );
}

function cross(a: Vec2, b: Vec2, point: Vec2): number {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

function pointOnSegment(point: Vec2, start: Vec2, end: Vec2): boolean {
  return (
    point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON &&
    point.y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON
  );
}

function pointToSegmentDistanceSquared(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared <= GEOMETRY_EPSILON) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return px * px + py * py;
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const px = point.x - (start.x + dx * t);
  const py = point.y - (start.y + dy * t);
  return px * px + py * py;
}

function smoothPath(grid: NavigationGrid, path: Vec2[]): Vec2[] {
  if (path.length <= 2) {
    return path;
  }

  const result: Vec2[] = [{ ...path[0] }];
  let anchor = 0;
  let checks = 0;

  while (anchor < path.length - 1) {
    let next = anchor + 1;

    for (let candidate = path.length - 1; candidate > anchor + 1; candidate -= 1) {
      if (checks >= MAX_SMOOTHING_CHECKS) {
        break;
      }

      checks += 1;

      if (segmentIsNavigable(grid, path[anchor], path[candidate])) {
        next = candidate;
        break;
      }
    }

    result.push({ ...path[next] });
    anchor = next;
  }

  return deduplicatePath(result);
}

function deduplicatePath(path: Vec2[]): Vec2[] {
  const result: Vec2[] = [];

  for (const point of path) {
    if (!result.length || !samePoint(result[result.length - 1], point)) {
      result.push({ ...point });
    }
  }

  return result;
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) <= GEOMETRY_EPSILON && Math.abs(a.y - b.y) <= GEOMETRY_EPSILON;
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
