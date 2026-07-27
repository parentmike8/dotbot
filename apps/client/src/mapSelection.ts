import { downtownMap } from "@dotbot/game/content/downtown";
import { quaysideMap } from "@dotbot/game/content/quaysideDepot";
import type { MapDocument } from "@dotbot/game/types";

/**
 * Downtown is the game. `?map=quayside` opens the non-rectangular reference
 * building the contract cites for angled and curved geometry — it is a fixture
 * for review, not a playable destination.
 */
export function selectMapDocument(search: string): MapDocument {
  return new URLSearchParams(search).get("map") === "quayside" ? quaysideMap : downtownMap;
}
