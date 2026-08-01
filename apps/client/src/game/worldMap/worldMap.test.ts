import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { worldMap } from "@dotbot/game/content/world";
import { OUTDOOR_FLOOR_ID, type GameSnapshot } from "@dotbot/game/types";
import type { LiveMark } from "../pings";
import {
  exteriorMapPresentation,
  fitWorldMapScale,
  mapMarkers,
  worldMapBounds,
} from "./worldMap";

const snapshot: GameSnapshot = {
  timeMs: 1_000,
  bots: [
    {
      id: "viewer", name: "You", squadId: "alpha", isAmbient: false, color: "#fff",
      position: { x: 100, y: 200 }, radius: 24, state: "alive", floorId: "mercy:F1",
      facing: 0, moving: false, maxShields: 3, shields: 3, shieldSegments: [1, 1, 1],
      bays: [null, null, null, null], hold: [], carriedCount: 0, searched: false,
      pleaded: false, radarActiveMs: 0, radarPings: [], dashOverchargeMs: 0,
      incognitoMs: 0, dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
    },
    {
      id: "mate", name: "Mate", squadId: "alpha", isAmbient: false, color: "#0ff",
      position: { x: 500, y: 600 }, radius: 24, state: "alive", floorId: "civic:F7",
      facing: 0, moving: false, maxShields: 3, shields: 3, shieldSegments: [1, 1, 1],
      bays: [null, null, null, null], hold: [], carriedCount: 0, searched: false,
      pleaded: false, radarActiveMs: 0, radarPings: [], dashOverchargeMs: 0,
      incognitoMs: 0, dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
    },
    {
      id: "hidden-rival", name: "Rival", squadId: "bravo", isAmbient: false, color: "#f00",
      position: { x: 700, y: 800 }, radius: 24, state: "alive", floorId: OUTDOOR_FLOOR_ID,
      facing: 0, moving: false, maxShields: 3, shields: 3, shieldSegments: [1, 1, 1],
      bays: [null, null, null, null], hold: [], carriedCount: 0, searched: false,
      pleaded: false, radarActiveMs: 0, radarPings: [], dashOverchargeMs: 0,
      incognitoMs: 0, dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
    },
  ],
  dots: [{
    id: "hidden-loot", item: { kind: "powerup", type: "health" }, position: { x: 900, y: 900 },
    radius: 10, floorId: OUTDOOR_FLOOR_ID, active: true, captureProgressMs: 0,
  }],
  mines: [],
  coverages: [],
  noises: [],
  doors: [],
  debug: { tickHz: 60, tickCount: 60, fps: 60, activeBodies: 3, activeDots: 1 },
};

const marks: LiveMark[] = [
  {
    id: "outside", kind: "here", position: { x: 300, y: 400 },
    floorId: OUTDOOR_FLOOR_ID, placedAtMs: 0, botId: "viewer",
  },
  {
    id: "inside", kind: "enemy", position: { x: 310, y: 410 },
    floorId: "civic:F7", placedAtMs: 0, botId: "viewer",
  },
  {
    id: "rival-outside", kind: "enemy", position: { x: 700, y: 800 },
    floorId: OUTDOOR_FLOOR_ID, placedAtMs: 0, botId: "hidden-rival",
  },
];

describe("exterior world map knowledge", () => {
  it("never exposes an interior floor and uses an authored roof only as a roof", () => {
    const presentation = exteriorMapPresentation(downtownMap);
    for (const building of presentation.buildings) {
      expect(building.visibleFloorIds).toEqual(
        downtownMap.buildings
          .find((candidate) => candidate.id === building.buildingId)!
          .floors
          .filter((floor) => floor.label === "ROOF")
          .map((floor) => floor.id),
      );
      expect(building.visibleFloorIds.every((id) => id.endsWith(":ROOF"))).toBe(true);
    }
  });

  it("shows authoritative squad positions from any floor but no rivals or hidden pickups", () => {
    const markers = mapMarkers(downtownMap, snapshot, "viewer", marks);
    expect(markers.squad.map((marker) => marker.id)).toEqual(["viewer", "mate"]);
    expect(markers.squad.find((marker) => marker.id === "mate")?.position).toEqual({ x: 500, y: 600 });
    expect(markers.squad.some((marker) => marker.id === "hidden-rival")).toBe(false);
    expect(markers.pings.map((marker) => marker.id)).toEqual(["outside"]);
    expect(JSON.stringify(markers)).not.toContain("hidden-loot");
  });

  it("does not turn an interior squad mark into exterior knowledge", () => {
    expect(mapMarkers(downtownMap, snapshot, "viewer", marks).pings).toEqual([
      expect.objectContaining({ id: "outside", floorId: OUTDOOR_FLOOR_ID }),
    ]);
  });
});

describe("world-sized viewport", () => {
  it("derives bounds from the map document so world growth needs no camera edit", () => {
    expect(worldMapBounds(downtownMap)).toEqual({ x: 0, y: 0, w: downtownMap.width, h: downtownMap.height });
    expect(worldMapBounds(worldMap)).toEqual({ x: 0, y: 0, w: 4200, h: 3400 });
    expect(fitWorldMapScale(worldMapBounds(worldMap), { width: 375, height: 812 }, 24))
      .toBeLessThan(fitWorldMapScale(worldMapBounds(downtownMap), { width: 375, height: 812 }, 24));
  });
});
