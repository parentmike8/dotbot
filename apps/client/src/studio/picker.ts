import type { MapDocument } from "@dotbot/game/types";

/**
 * Choosing a building when there are more than a handful.
 *
 * The dropdown was a plain `<option>` list over every editable building. That is fine at
 * four and useless at ninety, and ninety is the stated target — the project's scale-first
 * rule is that no system may assume a small enumerated world. A `<select>` fails it in the
 * most ordinary way: it makes you scroll a list you cannot search, sorted by nothing in
 * particular, with no memory of where you were working.
 *
 * So: search, and recents. Both are here as pure functions rather than in the component,
 * because ranking is the part with rules in it — and a picker that quietly ranks the wrong
 * thing first is the sort of fault you feel as friction for weeks without diagnosing.
 */

export type BuildingChoice = {
  id: string;
  name: string;
  kind: string;
};

/** Every building the tool can edit, in the map's own order. */
export function buildingChoices(map: MapDocument, editable: readonly string[]): BuildingChoice[] {
  const wanted = new Set(editable);
  return map.buildings
    .filter((building) => wanted.has(building.id))
    .map((building) => ({ id: building.id, name: building.name, kind: building.kind }));
}

/**
 * How well a choice answers a query, or `null` for no match.
 *
 * Lower is better. A prefix of the name beats a word inside it, which beats the id, which
 * beats the kind — because typing "civ" means you want CIVIC TOWER and not the four other
 * things that happen to contain those letters somewhere.
 */
function score(choice: BuildingChoice, query: string): number | null {
  const name = choice.name.toLowerCase();
  const id = choice.id.toLowerCase();
  const kind = choice.kind.toLowerCase();

  if (name.startsWith(query)) return 0;
  // A word boundary inside the name: "tower" should find CIVIC TOWER.
  if (name.split(/\s+/).some((word) => word.startsWith(query))) return 1;
  if (name.includes(query)) return 2;
  if (id.startsWith(query)) return 3;
  if (id.includes(query)) return 4;
  if (kind.startsWith(query)) return 5;
  return null;
}

/**
 * The choices matching a query, best first, stable within a rank.
 *
 * An empty query matches everything in the map's own order, so the picker with nothing
 * typed is exactly the list it replaced.
 */
export function filterBuildings(choices: readonly BuildingChoice[], query: string): BuildingChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...choices];

  return choices
    .map((choice, index) => ({ choice, index, rank: score(choice, needle) }))
    .filter((entry): entry is { choice: BuildingChoice; index: number; rank: number } => entry.rank !== null)
    // Ties keep the map's order rather than reshuffling, so the list does not jump about
    // as you type a character that changes nothing.
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.choice);
}

/** How many recently-opened buildings to remember. */
export const RECENT_LIMIT = 5;

/**
 * Push a building to the front of the recents.
 *
 * Most recent first, because the two buildings you are working between are the two you
 * want one click away — which is the actual failure of an alphabetical list at scale.
 *
 * It dedupes the WHOLE list, not just the id being pushed. Only filtering the incoming id
 * would be enough given that this is the only way the list is ever built, and that is
 * exactly the kind of reasoning that stops being true later — a list restored from
 * storage, or merged from two sessions. Cheap here, so the invariant is unconditional.
 */
export function remember(recents: readonly string[], id: string): string[] {
  return [...new Set([id, ...recents])].slice(0, RECENT_LIMIT);
}

/**
 * Recents as choices, skipping any that are no longer editable.
 *
 * A remembered id can outlive its building — a map switch via `?map=`, or a source file
 * removed — and a picker offering something that no longer exists throws on click rather
 * than doing nothing.
 */
export function recentChoices(
  choices: readonly BuildingChoice[],
  recents: readonly string[],
): BuildingChoice[] {
  return recents
    .map((id) => choices.find((choice) => choice.id === id))
    .filter((choice): choice is BuildingChoice => choice !== undefined);
}
