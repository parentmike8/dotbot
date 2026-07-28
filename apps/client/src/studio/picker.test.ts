import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { BUILDING_SOURCES } from "@dotbot/game/content/sources";
import {
  buildingChoices,
  filterBuildings,
  recentChoices,
  RECENT_LIMIT,
  remember,
} from "./picker";

/**
 * Finding a building when there are ninety of them.
 *
 * Against the real map, because the ranking rules are about real names — "CIVIC TOWER",
 * "MERCY CLINIC", "LOT 6 DEPOT", "BEACON HOUSE" — and a fixture with tidy names would not
 * exercise the cases that actually matter, like a query matching the second word.
 */

const editable = downtownMap.buildings.filter((b) => BUILDING_SOURCES[b.id]).map((b) => b.id);
const choices = buildingChoices(downtownMap, editable);

describe("the choices", () => {
  it("offers every editable building and nothing else", () => {
    expect(choices.length).toBe(editable.length);
    expect(choices.every((choice) => BUILDING_SOURCES[choice.id])).toBe(true);
  });

  it("keeps the map's own order", () => {
    const mapOrder = downtownMap.buildings.filter((b) => editable.includes(b.id)).map((b) => b.id);
    expect(choices.map((choice) => choice.id)).toEqual(mapOrder);
  });
});

describe("searching", () => {
  it("returns everything, in order, for an empty query", () => {
    // The picker with nothing typed has to be exactly the list it replaced.
    expect(filterBuildings(choices, "")).toEqual(choices);
    expect(filterBuildings(choices, "   ")).toEqual(choices);
  });

  it("finds a building by the start of its name", () => {
    expect(filterBuildings(choices, "civ").map((c) => c.id)).toEqual(["civic"]);
    expect(filterBuildings(choices, "MERCY").map((c) => c.id)).toEqual(["mercy"]);
  });

  it("finds it by a word inside the name, not just the first", () => {
    // "tower" is the second word of CIVIC TOWER, and typing a word you remember is the
    // commonest way anyone searches.
    expect(filterBuildings(choices, "tower").map((c) => c.id)).toContain("civic");
    expect(filterBuildings(choices, "clinic").map((c) => c.id)).toContain("mercy");
  });

  it("finds it by id, which is what the audits and errors print", () => {
    // Every audit message and patch error names the id, so pasting one in has to work.
    expect(filterBuildings(choices, "lot6").map((c) => c.id)).toContain("lot6");
  });

  it("finds a whole class of building by kind", () => {
    const offices = filterBuildings(choices, "office");
    expect(offices.length).toBeGreaterThan(0);
    expect(offices.every((choice) => choice.kind === "office")).toBe(true);
  });

  it("ranks a name prefix above a mere substring", () => {
    /**
     * The rule that makes the picker feel right rather than merely correct. If a query is
     * the start of one building's name and buried in the middle of another's, the first is
     * what you meant.
     */
    const made = [
      { id: "a", name: "OLD TOWER", kind: "office" },
      { id: "b", name: "TOWER HOUSE", kind: "residential" },
    ];
    expect(filterBuildings(made, "tower").map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("keeps ties in the map's order so the list does not jump while typing", () => {
    const made = [
      { id: "first", name: "DEPOT NORTH", kind: "warehouse" },
      { id: "second", name: "DEPOT SOUTH", kind: "warehouse" },
    ];
    expect(filterBuildings(made, "depot").map((c) => c.id)).toEqual(["first", "second"]);
    expect(filterBuildings(made, "dep").map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(filterBuildings(choices, "zzzz")).toEqual([]);
  });
});

describe("recents", () => {
  it("puts the newest first", () => {
    expect(remember(remember(remember([], "a"), "b"), "c")).toEqual(["c", "b", "a"]);
  });

  it("moves a revisited building to the front instead of duplicating it", () => {
    // Working between two buildings is the case this exists for, so a to-and-fro must not
    // fill the list with one id.
    expect(remember(["b", "a"], "a")).toEqual(["a", "b"]);
    expect(remember(["a", "b", "a"], "b")).toEqual(["b", "a"]);
  });

  it("forgets the oldest past the limit", () => {
    let recents: string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) recents = remember(recents, id);
    expect(recents).toHaveLength(RECENT_LIMIT);
    expect(recents[0]).toBe("g");
    expect(recents).not.toContain("a");
  });

  it("drops a remembered building that no longer exists", () => {
    /**
     * A remembered id outlives its building whenever the map changes under it — `?map=`
     * picks a different sheet, or a source file is deleted. Offering it would throw on
     * click, in a picker, which is the worst place for a stale handle.
     */
    const resolved = recentChoices(choices, ["civic", "a-building-that-went-away", "mercy"]);
    expect(resolved.map((choice) => choice.id)).toEqual(["civic", "mercy"]);
  });

  it("resolves recents in remembered order, not map order", () => {
    // The whole point is recency, so this must not quietly fall back to the map's order.
    expect(recentChoices(choices, ["mercy", "civic"]).map((c) => c.id)).toEqual(["mercy", "civic"]);
  });
});
