import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { worldMap } from "@dotbot/game/content/world";
import { arrivalGroups, selectBaseMap, spawnAt } from "./mapSelection";

const playerSpawn = (map: typeof worldMap) => map.botSpawns.find((spawn) => spawn.id === "player")!;

describe("choosing where a run starts", () => {
  it("groups every arrival point under the region it is in, in authored order", () => {
    const groups = arrivalGroups(worldMap);
    expect(groups.map((group) => group.area)).toEqual([
      "Downtown",
      "Fenchurch Yard",
      "The Pleasure Ground",
      "The Great Temple",
    ]);
    // Every point lands in exactly one group, and none is dropped.
    expect(groups.flatMap((group) => group.points).map((point) => point.id))
      .toEqual(worldMap.insertionPoints.map((point) => point.id));
  });

  /**
   * The reason `area` is stamped at composition rather than parsed off the id.
   *
   * The fair's and the temple's arrival points happen to be prefixed (`fair-`, `tmp-`) and
   * Downtown's are `nw-corner`, `west-gate`, `se-court` — six points with six prefixes. Any
   * grouping built on the ids would have split the city into six "regions" and looked
   * right for three regions out of four.
   */
  it("does not depend on the arrival ids sharing a prefix", () => {
    const city = arrivalGroups(worldMap).find((group) => group.area === "Downtown")!;
    expect(city.points).toHaveLength(6);
    expect(new Set(city.points.map((point) => point.id.split("-")[0])).size).toBe(6);
  });

  it("leaves a single-region map ungrouped rather than inventing an area", () => {
    const groups = arrivalGroups(downtownMap);
    expect(groups).toHaveLength(1);
    expect(groups[0].area).toBeNull();
    expect(groups[0].points).toHaveLength(downtownMap.insertionPoints.length);
  });

  it("moves only the player to the chosen point", () => {
    const target = worldMap.insertionPoints.find((point) => point.id === "tmp-spur")!;
    const moved = spawnAt(worldMap, "tmp-spur");
    expect(playerSpawn(moved).position).toEqual(target.position);
    // Every rival stays exactly where the region authored it.
    const rivals = (map: typeof worldMap) => map.botSpawns.filter((spawn) => spawn.id !== "player");
    expect(rivals(moved)).toEqual(rivals(worldMap));
  });

  /** `?at=fair` predates the picker and still has to land at the fairground. */
  it("takes an exact id or a region prefix, exact first", () => {
    expect(playerSpawn(spawnAt(worldMap, "fair")).position)
      .toEqual(worldMap.insertionPoints.find((point) => point.id === "fair-carpark")!.position);
    expect(playerSpawn(spawnAt(worldMap, "fair-avenue")).position)
      .toEqual(worldMap.insertionPoints.find((point) => point.id === "fair-avenue")!.position);
  });

  it("leaves the map alone for no choice and for a name it does not know", () => {
    expect(spawnAt(worldMap, null)).toBe(worldMap);
    expect(spawnAt(worldMap, "atlantis")).toBe(worldMap);
  });

  /**
   * An arrival point is outdoor ground, so choosing one must CLEAR any interior floor the
   * authored spawn carried — otherwise the player starts on a floor plan the point is not
   * on, which is a spawn inside whatever mass happens to be there.
   */
  it("puts the player on the arrival point's own floor, not the authored spawn's", () => {
    const indoors = {
      ...worldMap,
      botSpawns: worldMap.botSpawns.map((spawn) =>
        spawn.id === "player" ? { ...spawn, floorId: "civic:F6" } : spawn),
    };
    expect(playerSpawn(spawnAt(indoors, "tmp-trail")).floorId).toBeUndefined();
  });

  it("still selects the map by ?map=, with the world as the default", () => {
    expect(selectBaseMap("").id).toBe("world");
    expect(selectBaseMap("?map=downtown").id).toBe(downtownMap.id);
    expect(selectBaseMap("?solo").id).toBe("world");
  });
});
