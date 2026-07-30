import { defaultGameConfig } from "./config";
import { isAmbientBotSpawn } from "./faction";
import { physicsFloorId } from "./mapModel";
import { findNavigationPath } from "./navigation";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { BotSpawn, MapDocument, Vec2 } from "./types";

export type PatrolAuditIssue = {
  spawnId: string;
  routeId?: string;
  code:
    | "ambient-route-missing"
    | "escort-route-authored"
    | "route-purpose-missing"
    | "route-too-few-waypoints"
    | "route-too-short"
    | "route-leg-too-short"
    | "route-crosses-physics-floors"
    | "route-leg-unreachable";
  detail: string;
};

const MIN_WAYPOINTS = 4;
const MIN_LEG_PX = defaultGameConfig.botRadius * 2;
const MIN_LOOP_PX = defaultGameConfig.botRadius * 10;

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Audit authored patrols against the same production collision/navigation used
 * by live bots. A route is a closed loop: the last waypoint must navigate back
 * to the first with a full-size bot, not merely sit inside the map bounds.
 */
export function auditPatrolRoutes(
  map: MapDocument,
  radius = defaultGameConfig.botRadius,
): PatrolAuditIssue[] {
  const issues: PatrolAuditIssue[] = [];

  for (const spawn of map.botSpawns) {
    const isAmbient = isAmbientBotSpawn(spawn);
    const route = spawn.patrol;

    if (!isAmbient && route) {
      issues.push({
        spawnId: spawn.id,
        routeId: route.id,
        code: "escort-route-authored",
        detail: `non-ambient ${spawn.id} must follow its squad and cannot own patrol ${route.id}`,
      });
      continue;
    }

    if (!isAmbient) continue;

    if (!route) {
      issues.push({
        spawnId: spawn.id,
        code: "ambient-route-missing",
        detail: `ambient ${spawn.id} has no authored responsibility loop`,
      });
      continue;
    }

    if (route.purpose.trim().length === 0) {
      issues.push({
        spawnId: spawn.id,
        routeId: route.id,
        code: "route-purpose-missing",
        detail: `patrol ${route.id} does not state its world responsibility`,
      });
    }

    if (route.waypoints.length < MIN_WAYPOINTS) {
      issues.push({
        spawnId: spawn.id,
        routeId: route.id,
        code: "route-too-few-waypoints",
        detail: `patrol ${route.id} has ${route.waypoints.length}; at least ${MIN_WAYPOINTS} are required`,
      });
    }

    if (route.waypoints.length === 0) continue;

    const spawnFloor = physicsFloorId(map, spawn.floorId ?? OUTDOOR_FLOOR_ID);
    const points = route.waypoints.map((waypoint) => ({
      position: waypoint.position,
      floorId: physicsFloorId(map, waypoint.floorId ?? spawn.floorId ?? OUTDOOR_FLOOR_ID),
    }));
    const routeFloors = new Set(points.map((point) => point.floorId));

    if (routeFloors.size !== 1 || !routeFloors.has(spawnFloor)) {
      issues.push({
        spawnId: spawn.id,
        routeId: route.id,
        code: "route-crosses-physics-floors",
        detail: `patrol ${route.id} must stay on ${spawnFloor}; got ${[...routeFloors].join(", ")}`,
      });
      continue;
    }

    let loopLength = 0;

    for (let index = 0; index < points.length; index += 1) {
      const from = points[index];
      const to = points[(index + 1) % points.length];
      const directLength = distance(from.position, to.position);
      loopLength += directLength;

      if (directLength < MIN_LEG_PX) {
        issues.push({
          spawnId: spawn.id,
          routeId: route.id,
          code: "route-leg-too-short",
          detail: `patrol ${route.id} leg ${index + 1} is ${directLength.toFixed(1)} px; minimum is ${MIN_LEG_PX}`,
        });
      }

      if (findNavigationPath(map, spawnFloor, from.position, to.position, radius).length === 0) {
        issues.push({
          spawnId: spawn.id,
          routeId: route.id,
          code: "route-leg-unreachable",
          detail: `full-size bot cannot navigate patrol ${route.id} leg ${index + 1}`,
        });
      }
    }

    if (loopLength < MIN_LOOP_PX) {
      issues.push({
        spawnId: spawn.id,
        routeId: route.id,
        code: "route-too-short",
        detail: `patrol ${route.id} closes in ${loopLength.toFixed(1)} px; minimum is ${MIN_LOOP_PX}`,
      });
    }

    if (findNavigationPath(map, spawnFloor, spawn.position, points[0].position, radius).length === 0) {
      issues.push({
        spawnId: spawn.id,
        routeId: route.id,
        code: "route-leg-unreachable",
        detail: `full-size bot cannot enter patrol ${route.id} from its spawn`,
      });
    }
  }

  return issues;
}
