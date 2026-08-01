import { describe, expect, it } from "vitest";
import { PLATE_SET_REGISTRY } from "./catalog";
import { FABRICATION_RECIPE_REGISTRY, fabricate, inventoryFromStacks, validateRecipe, type FabricationRecipeDefinition } from "./fabrication";
import { LOOT_TABLE_REGISTRY, rollLootTable, validateLootTableRegistry, type LootTableDefinition } from "./loot";
import { catalogRef, createVersionedRegistry } from "./registry";
import { authorizeInteraction, validateInteractionTarget, type DomainInteractionTarget } from "./interactions";

const channel = { kind: "stationary", durationMs: 1_000, noise: { kind: "interaction", emitted: true } } as const;

describe("generic grey Interaction Dot authorization", () => {
  it("applies Level requirements to targets rather than door-only state", () => {
    const targets: DomainInteractionTarget[] = [
      { id: "door", kind: "door", doorwayId: "test-door", dot: "grey", channel, requirements: [{ kind: "minimumLevel", level: 4 }] },
      {
        id: "locker", kind: "lootContainer", dot: "grey", channel,
        lootTable: catalogRef(LOOT_TABLE_REGISTRY, "test-locker"),
        requirements: [{ kind: "minimumLevel", level: 4 }],
      },
      { id: "station", kind: "fabricationStation", stationKind: "assembly", dot: "grey", channel, requirements: [{ kind: "minimumLevel", level: 4 }] },
    ];
    for (const target of targets) {
      expect(authorizeInteraction({ level: 3 }, target)).toEqual({ authorized: false, reason: "level-required", requiredLevel: 4, actualLevel: 3 });
      expect(authorizeInteraction({ level: 4 }, target)).toEqual({ authorized: true, targetId: target.id });
      expect(target.channel.noise.emitted).toBe(true);
    }
  });

  it("composes Contract and capability access and rejects malformed channels", () => {
    const target: DomainInteractionTarget = {
      id: "function",
      kind: "worldFunction",
      functionId: "test-function",
      dot: "grey",
      channel,
      requirements: [
        { kind: "completedContract", contractId: "contract-a" },
        { kind: "capability", capabilityId: "capability-a" },
      ],
    };
    expect(authorizeInteraction({ level: 1 }, target)).toMatchObject({ authorized: false, reason: "contract-required" });
    expect(authorizeInteraction({ level: 1, completedContractIds: new Set(["contract-a"]) }, target))
      .toMatchObject({ authorized: false, reason: "capability-required" });
    expect(authorizeInteraction({ level: 1, completedContractIds: new Set(["contract-a"]), capabilityIds: new Set(["capability-a"]) }, target))
      .toEqual({ authorized: true, targetId: "function" });
    expect(authorizeInteraction({ level: 0 }, target)).toEqual({ authorized: false, reason: "invalid-context" });

    const malformed = { ...target, channel: { ...channel, durationMs: 0 } };
    expect(validateInteractionTarget(malformed).map((issue) => issue.code)).toContain("invalid-channel-duration");
    expect(() => authorizeInteraction({ level: 1 }, malformed)).toThrow(/invalid-channel-duration/i);
    expect(validateInteractionTarget({ ...target, functionId: "" }).map((issue) => issue.code)).toContain("missing-target");
  });
});

describe("content-neutral loot and in-world fabrication", () => {
  it("rolls typed loot deterministically from a versioned table", () => {
    const table = catalogRef(LOOT_TABLE_REGISTRY, "test-locker");
    expect(rollLootTable(LOOT_TABLE_REGISTRY, table, "same-seed"))
      .toEqual(rollLootTable(LOOT_TABLE_REGISTRY, table, "same-seed"));
    expect(rollLootTable(LOOT_TABLE_REGISTRY, table, "same-seed")[0]?.item.kind).toBe("powerup");
  });

  it("validates station kind and returns typed recipe input/output without mutating inventory", () => {
    const recipe = FABRICATION_RECIPE_REGISTRY.entries[0]!;
    const inventory = inventoryFromStacks(recipe.inputs);
    const before = structuredClone(inventory);
    expect(fabricate("wrong-station", recipe, inventory)).toEqual({ ok: false, reason: "wrong-station" });
    expect(fabricate(recipe.stationKind, recipe, inventory)).toMatchObject({ ok: false, reason: "missing-blueprint" });
    const result = fabricate(recipe.stationKind, recipe, inventory, { learnedBlueprints: [recipe.requiresBlueprint!] });
    expect(result).toMatchObject({ ok: true, consumed: recipe.inputs, produced: recipe.outputs });
    expect(inventory).toEqual(before);
  });

  it("allows physical Plate Sets as typed loot and fabrication output without placing content", () => {
    const stealth = { kind: "catalog", catalogKind: "plateSet", ref: catalogRef(PLATE_SET_REGISTRY, "stealth") } as const;
    const loot = createVersionedRegistry<LootTableDefinition>({
      registryId: "test.plate-loot",
      schemaVersion: 1,
      contentVersion: 1,
      entries: [{ id: "test", rolls: 1, entries: [{ weight: 1, output: { item: stealth, quantity: 1 } }] }],
    });
    expect(rollLootTable(loot, catalogRef(loot, "test"), "seed")).toEqual([{ item: stealth, quantity: 1 }]);

    const recipe: FabricationRecipeDefinition = {
      id: "test-stealth-plates",
      stationKind: "assembly",
      inputs: [{ item: { kind: "powerup", powerupType: "incognito" }, quantity: 1 }],
      outputs: [{ item: stealth, quantity: 1 }],
    };
    const fabricated = fabricate(recipe.stationKind, recipe, inventoryFromStacks(recipe.inputs));
    expect(fabricated).toMatchObject({ ok: true, produced: [{ item: stealth, quantity: 1 }] });
  });

  it("rejects malformed loot and recipes instead of producing impossible quantities", () => {
    const badLoot = createVersionedRegistry<LootTableDefinition>({
      registryId: "test.bad-loot",
      schemaVersion: 1,
      contentVersion: 1,
      entries: [{ id: "bad", rolls: 1, entries: [{ weight: 0, output: { item: { kind: "mine" }, quantity: 0 } }] }],
    });
    expect(validateLootTableRegistry(badLoot).map((issue) => issue.code))
      .toEqual(expect.arrayContaining(["invalid-weight", "invalid-quantity"]));
    expect(() => rollLootTable(badLoot, catalogRef(badLoot, "bad"), "seed")).toThrow(/invalid loot table/i);

    const badRecipe: FabricationRecipeDefinition = { id: "bad", stationKind: "assembly", inputs: [], outputs: [] };
    expect(validateRecipe(badRecipe).map((issue) => issue.code)).toEqual(["empty-inputs", "empty-outputs"]);
    expect(() => fabricate("assembly", badRecipe, {})).toThrow(/invalid fabrication recipe/i);
  });
});
