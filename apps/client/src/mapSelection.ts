import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { quaysideMap } from "@dotbot/game/content/quaysideDepot";
import { worldMap } from "@dotbot/game/content/world";
import { squadSpawnPosition } from "@dotbot/game/insertion";
import type { InsertionPoint, MapDocument } from "@dotbot/game/types";

/**
 * The world is the game.
 *
 * Downtown used to be, and it is still the regression map — every test in the suite is
 * written against it, and `?map=downtown` opens it alone on its own 2400 x 1600 sheet. But
 * the city is now one of four regions on one sheet, joined by two of its own streets
 * running out of it, so opening the city by itself is opening a fixture rather than the
 * game.
 *
 * `?map=quayside` is the non-rectangular reference building the contract cites for angled
 * and curved geometry: also a fixture for review, not a destination.
 */
export function selectBaseMap(search: string): MapDocument {
  const pick = new URLSearchParams(search).get("map");
  return pick === "quayside" ? quaysideMap : pick === "downtown" ? downtownMap : worldMap;
}

/** The whole selection in one call, for callers with no run to restart. */
export function selectMapDocument(search: string): MapDocument {
  const query = new URLSearchParams(search);
  return spawnAt(selectBaseMap(search), query.get("at"));
}

/**
 * Start the player's squad at a named arrival point instead of the authored spawn.
 *
 * `?at=fair` was the first use and the reason this exists: the world is 4200 x 3400 and
 * the player spawns in the city, so reviewing the far side of it meant a two-minute walk
 * before every single look — the kind of friction that stops a region getting reviewed at
 * all. The spawn picker is the second use, and it passes an exact point id.
 *
 * Matches an EXACT id first, then falls back to an id prefix, so `?at=fair` still lands at
 * the fairground's first drop while `fair-avenue` picks that one specifically. Nothing here
 * is a table of coordinates, so a region that gains an arrival point is reachable by both
 * without an edit to this file.
 *
 * The human takes formation slot zero and their escorts take the same safe slots used by
 * the authoritative multiplayer insertion system. `floorId: undefined` is meaningful:
 * an outdoor arrival must clear any stale interior floor from every squad member.
 */
export function spawnAt(map: MapDocument, key: string | null): MapDocument {
  if (!key) return map;
  const wanted = key.toLowerCase();
  const arrival = map.insertionPoints.find((point) => point.id.toLowerCase() === wanted)
    ?? map.insertionPoints.find((point) => point.id.toLowerCase().startsWith(wanted));
  if (!arrival) return map;
  const player = map.botSpawns.find((spawn) => spawn.controller === "human");
  if (!player) return map;
  const squad = [
    player,
    ...map.botSpawns.filter((spawn) => spawn.id !== player.id && spawn.squadId === player.squadId),
  ];
  const formationIndex = new Map(squad.map((spawn, index) => [spawn.id, index]));
  return {
    ...map,
    botSpawns: map.botSpawns.map((spawn) => {
      const memberIndex = formationIndex.get(spawn.id);
      return memberIndex === undefined
        ? spawn
        : {
            ...spawn,
            position: squadSpawnPosition(arrival, memberIndex, defaultGameConfig.botRadius),
            floorId: arrival.floorId,
          };
    }),
  };
}

/** Region prefixes `?at=` accepts, for anything that wants to offer them. */
export function spawnRegions(map: MapDocument): string[] {
  return [...new Set(map.insertionPoints.map((point) => point.id.split("-")[0]))];
}

export type ArrivalGroup = {
  /** The region's display name, or null on a map with only one place in it. */
  area: string | null;
  points: InsertionPoint[];
};

/**
 * Every arrival point on the map, grouped by region, in authored order.
 *
 * Authored order rather than alphabetical, because the regions are authored in the order
 * the world reads — city, depot, fair, ruin — and that gradient is the one thing a list of
 * twelve place names can carry for free. Sorting it would throw it away.
 */
export function arrivalGroups(map: MapDocument): ArrivalGroup[] {
  const groups: ArrivalGroup[] = [];
  for (const point of map.insertionPoints) {
    const area = point.area ?? null;
    const last = groups[groups.length - 1];
    if (last && last.area === area) last.points.push(point);
    else groups.push({ area, points: [point] });
  }
  return groups;
}
