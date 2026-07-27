import type { DotBotEntity, Item } from "./types";

export type InventoryCarrier = Pick<DotBotEntity, "bays" | "hold">;

export function carriedItems(carrier: InventoryCarrier): Item[] {
  return [...carrier.bays.filter((item): item is Item => item !== null), ...carrier.hold];
}

export function carriedCount(carrier: InventoryCarrier): number {
  return carrier.bays.filter((item) => item !== null).length + carrier.hold.length;
}

/**
 * Pull out the item at a flat `carriedItems` index — bays in order, then hold.
 *
 * Bays keep their holes: emptying bay 1 must not shuffle bays 2 and 3 down a slot,
 * because a bay index is a key the player presses. Only the hold closes up.
 * Returns null when the index names nothing, so a stale click takes nothing.
 */
export function removeCarriedAt(carrier: InventoryCarrier, index: number): Item | null {
  if (!Number.isInteger(index) || index < 0) return null;
  let remaining = index;
  for (let bay = 0; bay < carrier.bays.length; bay += 1) {
    const item = carrier.bays[bay];
    if (item === null) continue;
    if (remaining === 0) {
      carrier.bays[bay] = null;
      return item;
    }
    remaining -= 1;
  }
  if (remaining >= carrier.hold.length) return null;
  return carrier.hold.splice(remaining, 1)[0] ?? null;
}

/** Is there anywhere to put one more item? Ask before taking, never after. */
export function hasRoom(carrier: InventoryCarrier, holdSlots: number): boolean {
  return carrier.bays.some((item) => item === null) || carrier.hold.length < holdSlots;
}

/** Insert into the first open bay, then the hold. Returns false when full. */
export function insertItem(carrier: InventoryCarrier, item: Item, holdSlots: number): boolean {
  const bayIndex = carrier.bays.findIndex((candidate) => candidate === null);
  if (bayIndex >= 0) {
    carrier.bays[bayIndex] = item;
    return true;
  }
  if (carrier.hold.length < holdSlots) {
    carrier.hold.push(item);
    return true;
  }
  return false;
}
