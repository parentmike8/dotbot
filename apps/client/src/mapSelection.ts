import { downtownMap } from "@dotbot/game/content/downtown";
import { quaysideMap } from "@dotbot/game/content/quaysideDepot";
import { worldMap } from "@dotbot/game/content/world";
import type { MapDocument } from "@dotbot/game/types";

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
export function selectMapDocument(search: string): MapDocument {
  const query = new URLSearchParams(search);
  const pick = query.get("map");
  const base = pick === "quayside" ? quaysideMap : pick === "downtown" ? downtownMap : worldMap;
  return spawnAt(base, query.get("at"));
}

/**
 * `?at=fair` starts you in the fairground instead of walking there.
 *
 * The world is 4200 x 3400 and the player spawns in the city, so reviewing the far
 * side of it meant a two-minute walk before every single look — which is the kind of
 * friction that stops a region getting reviewed at all. This moves the player's spawn
 * to the arrival point of the named region and changes nothing else.
 *
 * Matched on the insertion point's own id prefix rather than a table of coordinates,
 * so a region that gains an arrival point is reachable by this without an edit here.
 */
function spawnAt(map: MapDocument, region: string | null): MapDocument {
  if (!region) return map;
  const arrival = map.insertionPoints.find((point) => point.id.startsWith(region.toLowerCase()));
  if (!arrival) return map;
  return {
    ...map,
    botSpawns: map.botSpawns.map((spawn) =>
      spawn.id === "player" ? { ...spawn, position: { ...arrival.position }, floorId: undefined } : spawn,
    ),
  };
}

/** Region prefixes `?at=` accepts, for anything that wants to offer them. */
export function spawnRegions(map: MapDocument): string[] {
  return [...new Set(map.insertionPoints.map((point) => point.id.split("-")[0]))];
}
