import { describe, expect, it } from "vitest";
import { BASE_KIND_ZONES, BASE_OBJECT_KINDS, createBaseMap, starterBaseLayout } from "./content/base";
import { downtownMap } from "./content/downtown";
import { RECIPES } from "./content/recipes";
import { defaultGameConfig } from "./config";

describe("economy recipe data", () => {
  it("has unique ids, positive costs, four powerup conversions, and the symmetric expansion sink", () => {
    expect(new Set(RECIPES.map((recipe) => recipe.id)).size).toBe(RECIPES.length);
    expect(RECIPES.every((recipe) => recipe.costs.length > 0 && recipe.costs.every((cost) => cost.qty > 0))).toBe(true);
    const powerups = RECIPES.flatMap((recipe) => recipe.output.kind === "item" && recipe.output.item.kind === "powerup" ? [recipe.output.item.type] : []);
    expect(new Set(powerups)).toEqual(new Set(["health", "radar", "dashOvercharge", "incognito"]));
    expect(RECIPES.filter((recipe) => recipe.output.kind === "item" && recipe.output.item.kind === "mine"))
      .toMatchObject([{ id: "fabricate-mine", requiresBlueprint: "workbench" }]);
    const expansion = RECIPES.find((recipe) => recipe.id === "expansion-secondFloor");
    expect(expansion).toMatchObject({ output: { kind: "expansion", upgradeId: "secondFloor" } });
    expect(expansion?.costs).toEqual([
      { itemType: "h", qty: 6 },
      { itemType: "r", qty: 6 },
      { itemType: "d", qty: 6 },
      { itemType: "i", qty: 6 },
    ]);
  });

  it("gates furniture with real Downtown blueprint fragments and covers every output with zone data", () => {
    const blueprintIds = new Set(downtownMap.buildings.flatMap((building) => building.floors)
      .flatMap((floor) => floor.dotSpawns)
      .flatMap((spawn) => spawn.item.kind === "blueprint" ? [spawn.item.blueprintId] : []));
    const furnitureRecipes = RECIPES.filter((recipe) => recipe.output.kind === "furniture");
    for (const recipe of furnitureRecipes) {
      expect(recipe.requiresBlueprint, recipe.id).toBeTruthy();
      expect(blueprintIds.has(recipe.requiresBlueprint!), recipe.id).toBe(true);
      if (recipe.output.kind === "furniture") expect(BASE_KIND_ZONES[recipe.output.objectKind].length, recipe.id).toBeGreaterThan(0);
    }
    const derivedFurniture = new Set(["repairBench", "listeningPost", "signalMast"]);
    expect(new Set(furnitureRecipes.flatMap((recipe) =>
      recipe.output.kind === "furniture" && !derivedFurniture.has(recipe.output.objectKind) ? [recipe.output.objectKind] : [],
    ))).toEqual(blueprintIds);
    expect(furnitureRecipes.find((recipe) => recipe.id === "furniture-listeningPost")?.requiresBlueprint).toBe("serverRack");
    expect(furnitureRecipes.find((recipe) => recipe.id === "furniture-signalMast")?.requiresBlueprint).toBe("generator");
    expect(new Set(Object.keys(BASE_KIND_ZONES))).toEqual(new Set(BASE_OBJECT_KINDS));
  });

  it("cannot encode combat-stat mutations", () => {
    const before = structuredClone(defaultGameConfig);
    createBaseMap(starterBaseLayout);
    expect(defaultGameConfig).toEqual(before);
    const forbiddenKeys = new Set(["damage", "damageSpeed", "speed", "playerSpeed", "botSpeed", "plates", "maxShields", "shieldSegments"]);
    for (const recipe of RECIPES) {
      expect(collectKeys(recipe).filter((key) => forbiddenKeys.has(key)), recipe.id).toEqual([]);
    }
  });
});

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}
