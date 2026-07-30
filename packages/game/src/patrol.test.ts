import { describe, expect, it } from "vitest";
import { worldMap } from "./content/world";
import { physicsFloorId } from "./mapModel";
import { auditPatrolRoutes } from "./patrol";
import { DotBotSimulation } from "./simulation";
import type { MapDocument } from "./types";

function cloneWorld(): MapDocument {
  return structuredClone(worldMap);
}

describe("production ambient patrol contract", () => {
  it("gives every ambient a purposeful, full-size navigable production loop and no escort a patrol", () => {
    expect(auditPatrolRoutes(worldMap)).toEqual([]);
  });

  it("detects a missing ambient responsibility rather than generating a fallback route", () => {
    const map = cloneWorld();
    const ambient = map.botSpawns.find((spawn) => spawn.faction === "ambient")!;
    delete ambient.patrol;

    expect(auditPatrolRoutes(map)).toContainEqual(expect.objectContaining({
      spawnId: ambient.id,
      code: "ambient-route-missing",
    }));
  });

  it("rejects a tiny ping-pong loop", () => {
    const map = cloneWorld();
    const ambient = map.botSpawns.find((spawn) => spawn.faction === "ambient")!;
    ambient.patrol!.waypoints = [
      { position: { ...ambient.position } },
      { position: { x: ambient.position.x + 4, y: ambient.position.y } },
      { position: { x: ambient.position.x + 4, y: ambient.position.y + 4 } },
      { position: { x: ambient.position.x, y: ambient.position.y + 4 } },
    ];

    const codes = auditPatrolRoutes(map)
      .filter((issue) => issue.spawnId === ambient.id)
      .map((issue) => issue.code);
    expect(codes).toContain("route-leg-too-short");
    expect(codes).toContain("route-too-short");
  });

  it("rejects a waypoint that production collision makes unreachable", () => {
    const map = cloneWorld();
    const ambient = map.botSpawns.find((spawn) => spawn.faction === "ambient")!;
    ambient.patrol!.waypoints[1] = { position: { x: 1, y: 1 } };

    expect(auditPatrolRoutes(map)).toContainEqual(expect.objectContaining({
      spawnId: ambient.id,
      code: "route-leg-unreachable",
    }));
  });

  it("physically walks every production waypoint with full-size live bots", async () => {
    const map = cloneWorld();
    map.botSpawns = map.botSpawns.filter((spawn) => spawn.faction === "ambient");
    const simulation = await DotBotSimulation.create({ map });
    const visited = new Map(
      map.botSpawns.map((spawn) => [spawn.id, new Set<number>()]),
    );
    const nearest = new Map(
      map.botSpawns.map((spawn) => [spawn.id, spawn.patrol!.waypoints.map(() => Infinity)]),
    );

    for (let tick = 0; tick < 7_200; tick += 1) {
      simulation.step();
      const bots = new Map(simulation.getSnapshot().bots.map((bot) => [bot.id, bot]));
      for (const spawn of map.botSpawns) {
        const bot = bots.get(spawn.id)!;
        spawn.patrol!.waypoints.forEach((waypoint, index) => {
          const away = Math.hypot(
            bot.position.x - waypoint.position.x,
            bot.position.y - waypoint.position.y,
          );
          nearest.get(spawn.id)![index] = Math.min(nearest.get(spawn.id)![index], away);
          if (bot.floorId === physicsFloorId(map, waypoint.floorId ?? spawn.floorId ?? "outdoor")
            && away <= 55) {
            visited.get(spawn.id)!.add(index);
          }
        });
      }
    }

    for (const spawn of map.botSpawns) {
      expect(
        [...visited.get(spawn.id)!].sort((a, b) => a - b),
        `${spawn.id} did not physically walk every point of ${spawn.patrol!.id}; nearest ${nearest.get(spawn.id)!.map((away) => away.toFixed(1)).join(", ")}`,
      ).toEqual(spawn.patrol!.waypoints.map((_, index) => index));
    }
    expect(simulation.getSnapshot().bots.every((bot) => bot.shields === bot.maxShields)).toBe(true);
    simulation.dispose();
  }, 30_000);
});
