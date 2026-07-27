import { describe, expect, it } from "vitest";
import { carriedItems, hasRoom, insertItem, removeCarriedAt } from "./inventory";
import type { Item } from "./types";

const health: Item = { kind: "powerup", type: "health" };
const radar: Item = { kind: "powerup", type: "radar" };
const overcharge: Item = { kind: "powerup", type: "dashOvercharge" };
const incognito: Item = { kind: "powerup", type: "incognito" };

describe("removeCarriedAt", () => {
  it("addresses bays in order, then the hold — the order contents are shown in", () => {
    const carrier = { bays: [health, radar, null], hold: [overcharge, incognito] };
    expect(carriedItems(carrier)).toEqual([health, radar, overcharge, incognito]);
    expect(removeCarriedAt(carrier, 2)).toEqual(overcharge);
    expect(carrier).toEqual({ bays: [health, radar, null], hold: [incognito] });
  });

  it("leaves a hole where a bay item was, so the other bays keep their keys", () => {
    // A bay index is a digit the player presses. Closing the gap would move an
    // item the player did not touch onto a different key.
    const carrier = { bays: [health, radar, overcharge], hold: [] as Item[] };
    expect(removeCarriedAt(carrier, 1)).toEqual(radar);
    expect(carrier.bays).toEqual([health, null, overcharge]);
  });

  it("skips empty bays when counting, so a hole is not a slot", () => {
    const carrier = { bays: [null, health, null], hold: [radar] };
    expect(removeCarriedAt(carrier, 0)).toEqual(health);
    expect(carrier.bays).toEqual([null, null, null]);
    expect(removeCarriedAt(carrier, 0)).toEqual(radar);
    expect(carrier.hold).toEqual([]);
  });

  it("takes nothing at all for an index that names nothing", () => {
    // Every index here arrives from a client. A negative one used to be the sharp
    // edge: `splice(-1, 1)` counts from the end and would remove the last item.
    const carrier = { bays: [health, null, null], hold: [radar] };
    for (const index of [-1, 2, 99, 0.5, Number.NaN]) {
      expect(removeCarriedAt(carrier, index)).toBeNull();
    }
    expect(carrier).toEqual({ bays: [health, null, null], hold: [radar] });
  });
});

describe("hasRoom", () => {
  it("counts an empty bay or an open hold slot, and nothing else", () => {
    expect(hasRoom({ bays: [health, null], hold: [radar] }, 1)).toBe(true);
    expect(hasRoom({ bays: [health, radar], hold: [] }, 1)).toBe(true);
    expect(hasRoom({ bays: [health, radar], hold: [overcharge] }, 1)).toBe(false);
  });

  it("agrees with insertItem, which is the only reason it exists", () => {
    // Asked before an item leaves a body, never after: a take that has to be
    // undone is a take that can lose the item in between.
    for (const holdSlots of [0, 1, 2]) {
      for (const bays of [[null, null], [health, null], [health, radar]]) {
        const carrier = { bays: [...bays], hold: Array.from({ length: holdSlots }, () => radar).slice(0, holdSlots) };
        const room = hasRoom(carrier, holdSlots);
        expect(insertItem(carrier, overcharge, holdSlots)).toBe(room);
      }
    }
  });
});
