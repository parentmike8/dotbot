import { auditBuildingFloorQuality } from "./mapQuality";
import { collisionLayers } from "./mapModel";
import type { Building, FloorPlan, MapDocument, Rect, Vec2 } from "./types";

export type MapEditorIssue = {
  severity: "error" | "warning";
  path: string;
  message: string;
};

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);

function rectIssues(value: unknown, path: string, issues: MapEditorIssue[]): value is Rect {
  if (!object(value)) {
    issues.push({ severity: "error", path, message: "Expected a rectangle." });
    return false;
  }
  for (const key of ["x", "y", "w", "h"] as const) {
    if (!finite(value[key])) issues.push({ severity: "error", path: `${path}.${key}`, message: "Expected a finite number." });
  }
  if (finite(value.w) && value.w <= 0) issues.push({ severity: "error", path: `${path}.w`, message: "Width must be greater than zero." });
  if (finite(value.h) && value.h <= 0) issues.push({ severity: "error", path: `${path}.h`, message: "Height must be greater than zero." });
  return finite(value.x) && finite(value.y) && finite(value.w) && finite(value.h) && value.w > 0 && value.h > 0;
}

function pointIssues(value: unknown, path: string, issues: MapEditorIssue[]): value is Vec2 {
  if (!object(value) || !finite(value.x) || !finite(value.y)) {
    issues.push({ severity: "error", path, message: "Expected a finite x/y position." });
    return false;
  }
  return true;
}

function uniqueIds(values: unknown[], path: string, issues: MapEditorIssue[]): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!object(value) || !text(value.id)) {
      issues.push({ severity: "error", path: `${path}[${index}].id`, message: "A non-empty id is required." });
      return;
    }
    if (seen.has(value.id)) issues.push({ severity: "error", path: `${path}[${index}].id`, message: `Duplicate id ${value.id}.` });
    seen.add(value.id);
  });
}

function floorIssues(floor: unknown, path: string, issues: MapEditorIssue[]): floor is FloorPlan {
  if (!object(floor)) {
    issues.push({ severity: "error", path, message: "Expected a floor plan." });
    return false;
  }
  if (!text(floor.id)) issues.push({ severity: "error", path: `${path}.id`, message: "A floor id is required." });
  if (!text(floor.label)) issues.push({ severity: "error", path: `${path}.label`, message: "A floor label is required." });
  for (const key of ["walls", "doorways", "objects", "stairs", "dotSpawns"] as const) {
    if (!array(floor[key])) issues.push({ severity: "error", path: `${path}.${key}`, message: "Expected an array." });
    else uniqueIds(floor[key], `${path}.${key}`, issues);
  }
  if (array(floor.walls)) floor.walls.forEach((wall, index) => rectIssues(wall, `${path}.walls[${index}]`, issues));
  if (array(floor.objects)) floor.objects.forEach((item, index) => rectIssues(item, `${path}.objects[${index}]`, issues));
  if (array(floor.stairs)) floor.stairs.forEach((stair, index) => {
    if (!object(stair)) return;
    rectIssues(stair.rect, `${path}.stairs[${index}].rect`, issues);
    if (!text(stair.toFloorId)) issues.push({ severity: "error", path: `${path}.stairs[${index}].toFloorId`, message: "A target floor is required." });
  });
  if (array(floor.doorways)) floor.doorways.forEach((door, index) => {
    if (!object(door) || !finite(door.x) || !finite(door.y) || !finite(door.width) || door.width <= 0) {
      issues.push({ severity: "error", path: `${path}.doorways[${index}]`, message: "Doorways require finite x/y and a positive width." });
    }
  });
  if (array(floor.dotSpawns)) floor.dotSpawns.forEach((dot, index) => {
    if (object(dot)) pointIssues(dot.position, `${path}.dotSpawns[${index}].position`, issues);
  });
  return text(floor.id) && text(floor.label) && ["walls", "doorways", "objects", "stairs", "dotSpawns"].every((key) => array(floor[key]));
}

function buildingIssues(building: unknown, path: string, issues: MapEditorIssue[]): building is Building {
  if (!object(building)) {
    issues.push({ severity: "error", path, message: "Expected a building." });
    return false;
  }
  if (!text(building.id)) issues.push({ severity: "error", path: `${path}.id`, message: "A building id is required." });
  if (!text(building.name)) issues.push({ severity: "error", path: `${path}.name`, message: "A building name is required." });
  rectIssues(building.footprint, `${path}.footprint`, issues);
  if (!array(building.floors) || building.floors.length === 0) {
    issues.push({ severity: "error", path: `${path}.floors`, message: "A building needs at least one floor." });
    return false;
  }
  uniqueIds(building.floors, `${path}.floors`, issues);
  building.floors.forEach((floor, index) => floorIssues(floor, `${path}.floors[${index}]`, issues));
  return text(building.id) && text(building.name) && object(building.footprint);
}

export function validateEditableMap(value: unknown): MapEditorIssue[] {
  const issues: MapEditorIssue[] = [];
  if (!object(value)) return [{ severity: "error", path: "$", message: "Expected a map document." }];
  if (!text(value.id)) issues.push({ severity: "error", path: "$.id", message: "A map id is required." });
  if (!text(value.name)) issues.push({ severity: "error", path: "$.name", message: "A map name is required." });
  if (!finite(value.width) || value.width <= 0) issues.push({ severity: "error", path: "$.width", message: "Map width must be positive." });
  if (!finite(value.height) || value.height <= 0) issues.push({ severity: "error", path: "$.height", message: "Map height must be positive." });
  if (!object(value.outdoor)) issues.push({ severity: "error", path: "$.outdoor", message: "An outdoor plan is required." });
  else {
    for (const key of ["roads", "parks", "walls", "objects", "dotSpawns"] as const) {
      if (!array(value.outdoor[key])) issues.push({ severity: "error", path: `$.outdoor.${key}`, message: "Expected an array." });
      else uniqueIds(value.outdoor[key], `$.outdoor.${key}`, issues);
    }
    for (const key of ["roads", "parks", "walls", "objects"] as const) {
      if (array(value.outdoor[key])) value.outdoor[key].forEach((entry, index) => rectIssues(entry, `$.outdoor.${key}[${index}]`, issues));
    }
  }
  for (const key of ["buildings", "extractionPoints", "insertionPoints", "botSpawns"] as const) {
    if (!array(value[key])) issues.push({ severity: "error", path: `$.${key}`, message: "Expected an array." });
    else uniqueIds(value[key], `$.${key}`, issues);
  }
  if (array(value.buildings)) {
    value.buildings.forEach((building, index) => buildingIssues(building, `$.buildings[${index}]`, issues));
    const floors = value.buildings.flatMap((building) => object(building) && array(building.floors) ? building.floors : []);
    const floorIds = new Set(floors.filter(object).map((floor) => floor.id).filter(text));
    for (const floor of floors.filter(object)) {
      if (!array(floor.stairs)) continue;
      for (const stair of floor.stairs.filter(object)) {
        if (text(stair.toFloorId) && !floorIds.has(stair.toFloorId)) {
          issues.push({ severity: "error", path: `$.floors.${String(floor.id)}.stairs.${String(stair.id)}`, message: `Unknown target floor ${stair.toFloorId}.` });
        }
      }
    }
  }
  if (array(value.insertionPoints)) value.insertionPoints.forEach((point, index) => {
    if (object(point)) pointIssues(point.position, `$.insertionPoints[${index}].position`, issues);
  });
  if (array(value.botSpawns)) value.botSpawns.forEach((spawn, index) => {
    if (object(spawn)) pointIssues(spawn.position, `$.botSpawns[${index}].position`, issues);
  });
  if (array(value.botSpawns) && !value.botSpawns.some((spawn) => object(spawn) && spawn.id === "player" && spawn.controller === "human")) {
    issues.push({ severity: "warning", path: "$.botSpawns", message: "No local human player start. Add an Insertion point in Map Studio before playtesting." });
  }
  if (array(value.extractionPoints)) value.extractionPoints.forEach((point, index) => {
    if (object(point)) rectIssues(point.rect, `$.extractionPoints[${index}].rect`, issues);
  });

  if (!issues.some((issue) => issue.severity === "error")) {
    const map = value as unknown as MapDocument;
    try {
      collisionLayers(map);
    } catch (error) {
      issues.push({ severity: "error", path: "$.buildings", message: error instanceof Error ? error.message : "Invalid collision layers." });
    }
    for (const building of map.buildings) {
      for (const quality of auditBuildingFloorQuality(map, building.id)) {
        issues.push({ severity: "warning", path: `$.buildings.${building.id}`, message: quality.message });
      }
    }
  }
  return issues;
}

export function cloneMapDocument(map: MapDocument): MapDocument {
  return structuredClone(map);
}
