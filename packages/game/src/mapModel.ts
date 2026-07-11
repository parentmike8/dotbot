import { OUTDOOR_FLOOR_ID } from "./types";
import type {
  Building,
  FloorLabel,
  FloorPlan,
  MapDocument,
  MapObject,
  ObjectKind,
  Rect,
  StairLink,
  Vec2,
} from "./types";

/**
 * Object kinds that get physics colliders unless the object overrides `solid`.
 * Small, walk-past furniture (chairs, plants, floor markings) stays non-solid.
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
]);

export function isSolidObject(object: MapObject): boolean {
  return object.solid ?? SOLID_KINDS.has(object.kind);
}

export function rectContains(rect: Rect, point: Vec2, inset = 0): boolean {
  return (
    point.x >= rect.x + inset &&
    point.x <= rect.x + rect.w - inset &&
    point.y >= rect.y + inset &&
    point.y <= rect.y + rect.h - inset
  );
}

export function buildingContaining(map: MapDocument, point: Vec2): Building | null {
  for (const building of map.buildings) {
    if (rectContains(building.footprint, point, 6)) {
      return building;
    }
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
 * Physics layers. The outdoor plane (streets + every building's GROUND floor)
 * is layer 0. Each non-GROUND floor gets its own layer.
 */
export function collisionLayers(map: MapDocument): Map<string, number> {
  const layers = new Map<string, number>([[OUTDOOR_FLOOR_ID, 0]]);
  let next = 1;

  for (const building of map.buildings) {
    for (const floor of building.floors) {
      if (!isGroundFloor(floor)) {
        if (next >= 16) {
          throw new Error("DotBot maps support at most 16 physics collision layers, including the shared outdoor layer.");
        }

        layers.set(floor.id, next);
        next += 1;
      }
    }
  }

  return layers;
}

/**
 * The physics floor a bot occupies. GROUND floors resolve to the outdoor layer
 * because they share the street plane (you walk in through the door gap).
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

export type StairHalves = {
  /** Half of the run you walk in from on this floor. */
  entry: Rect;
  /** Half beyond the break line — the flight continuing to the other floor. */
  exit: Rect;
  /** Run direction: true when the flight runs along the y axis. */
  vertical: boolean;
};

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

/** Where a bot arriving via this stair ends up: the center of its exit half. */
export function stairExitPoint(stair: StairLink): Vec2 {
  const { exit } = stairHalves(stair);
  return { x: exit.x + exit.w / 2, y: exit.y + exit.h / 2 };
}

const FLOOR_HEIGHTS: Record<FloorLabel, number> = {
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
