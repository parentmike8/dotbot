import type { Item } from "@dotbot/game/types";

/**
 * How an item names itself in the overlay.
 *
 * One place, because the bay bank, the swap picker and the loot picker all show the
 * same items and a player who learns a mark in one has learned it everywhere.
 */
export function itemLabel(item: Item): string {
  if (item.kind === "blueprint") return `Blueprint: ${item.blueprintId}`;
  if (item.kind === "mine") return "Mine";
  return ({ health: "Health", radar: "Radar", dashOvercharge: "Dash overcharge", incognito: "Incognito" } as const)[item.type];
}

export function itemGlyph(item: Item | null): string {
  if (!item) return "·";
  if (item.kind === "blueprint") return "⌑";
  if (item.kind === "mine") return "×";
  return ({ health: "+", radar: "◎", dashOvercharge: "›", incognito: "◌" } as const)[item.type];
}

/** Which of the three item families a mark belongs to, for its slot's accent. */
export function itemFamily(item: Item | null): "empty" | "powerup" | "mine" | "blueprint" {
  if (!item) return "empty";
  return item.kind;
}
