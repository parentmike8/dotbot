import type { DotBotEntity, Item } from "./types";

export type InventoryCarrier = Pick<DotBotEntity, "bays" | "hold">;

export function carriedItems(carrier: InventoryCarrier): Item[] {
  return [...carrier.bays.filter((item): item is Item => item !== null), ...carrier.hold];
}

export function carriedCount(carrier: InventoryCarrier): number {
  return carrier.bays.filter((item) => item !== null).length + carrier.hold.length;
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
