import type { SourceBuilding } from "../mapSource";
import type { Rect } from "../types";
import { BEACON_SOURCE } from "./beaconHouse";
import { CIVIC_SOURCE } from "./civicTower";
import { LOT6_SOURCE } from "./lot6Depot";
import { MERCY_SOURCE } from "./mercyClinic";
import { QUAY_SOURCE } from "./quaysideDepot";

/**
 * Every building that exists as authored source, and the file it lives in.
 *
 * The editor needs both halves: the source to show and the file to patch. Keeping
 * them together here means a building is either editable end to end or absent —
 * there is no state where the editor offers to change something it cannot write.
 */

export type BuildingSource = {
  source: SourceBuilding;
  /** Repo-relative, so the dev-only patch endpoint can find it. */
  file: string;
};

const file = (name: string): string => `packages/game/src/content/${name}.ts`;

export const BUILDING_SOURCES: Record<string, BuildingSource> = {
  mercy: { source: MERCY_SOURCE, file: file("mercyClinic") },
  civic: { source: CIVIC_SOURCE, file: file("civicTower") },
  lot6: { source: LOT6_SOURCE, file: file("lot6Depot") },
  beacon: { source: BEACON_SOURCE, file: file("beaconHouse") },
  quay: { source: QUAY_SOURCE, file: file("quaysideDepot") },
};

export function buildingSource(id: string): BuildingSource | null {
  return BUILDING_SOURCES[id] ?? null;
}

export type StudioArea = {
  id: string;
  name: string;
  bounds: Rect;
};

/**
 * Review frames over the production world sheet. These choose a camera extent;
 * the canvas still draws `buildMapArt(worldMap)` verbatim.
 */
export const STUDIO_AREAS: StudioArea[] = [
  { id: "downtown", name: "Downtown", bounds: { x: 0, y: 0, w: 2400, h: 1600 } },
  { id: "yard", name: "Fenchurch Yard", bounds: { x: 2374, y: 0, w: 1826, h: 1800 } },
  { id: "fair", name: "Pleasure Ground", bounds: { x: 0, y: 1574, w: 2400, h: 1826 } },
  { id: "temple", name: "Great Temple", bounds: { x: 2374, y: 1774, w: 1826, h: 1626 } },
];
