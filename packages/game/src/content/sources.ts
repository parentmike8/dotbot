import type { SourceBuilding } from "../mapSource";
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
