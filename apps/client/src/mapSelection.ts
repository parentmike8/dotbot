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
  const pick = new URLSearchParams(search).get("map");
  if (pick === "quayside") return quaysideMap;
  if (pick === "downtown") return downtownMap;
  return worldMap;
}
