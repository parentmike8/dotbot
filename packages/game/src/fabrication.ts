import {
  BASE_OBJECT_REGISTRY,
  BLUEPRINT_REGISTRY,
  catalogRef,
  cloneDomainItemStack,
  domainItemKey,
  type DomainItemStack,
} from "./catalog";
import { createVersionedRegistry, type CatalogRef } from "./registry";

export type FabricationStationKind = "fabricator" | "assembly";

export type FabricationRecipeDefinition = {
  id: string;
  stationKind: FabricationStationKind;
  inputs: readonly DomainItemStack[];
  outputs: readonly DomainItemStack[];
  requiresBlueprint?: CatalogRef;
};

export type DomainInventory = Readonly<Record<string, number>>;

export type FabricationContext = {
  learnedBlueprints?: readonly CatalogRef[];
};

export const FABRICATION_RECIPE_REGISTRY = createVersionedRegistry<FabricationRecipeDefinition>({
  registryId: "dotbot.fabrication-recipes",
  schemaVersion: 1,
  contentVersion: 1,
  entries: [
    {
      id: "test-locker",
      stationKind: "assembly",
      inputs: [{ item: { kind: "powerup", powerupType: "health" }, quantity: 1 }],
      outputs: [{ item: { kind: "catalog", catalogKind: "baseObject", ref: catalogRef(BASE_OBJECT_REGISTRY, "locker") }, quantity: 1 }],
      requiresBlueprint: catalogRef(BLUEPRINT_REGISTRY, "locker"),
    },
  ],
});

export function inventoryFromStacks(stacks: readonly DomainItemStack[]): DomainInventory {
  const inventory: Record<string, number> = {};
  for (const stack of stacks) {
    if (!Number.isSafeInteger(stack.quantity) || stack.quantity <= 0) throw new Error("Item stack quantity must be a positive safe integer.");
    const key = domainItemKey(stack.item);
    const quantity = (inventory[key] ?? 0) + stack.quantity;
    if (!Number.isSafeInteger(quantity)) throw new Error(`Item stack total exceeds the safe integer range: ${key}`);
    inventory[key] = quantity;
  }
  return inventory;
}

export type FabricationResult =
  | { ok: false; reason: "wrong-station" }
  | { ok: false; reason: "missing-blueprint"; blueprint: CatalogRef }
  | { ok: false; reason: "missing-inputs"; missing: DomainItemStack[] }
  | { ok: true; consumed: readonly DomainItemStack[]; produced: readonly DomainItemStack[]; remaining: DomainInventory };

export function fabricate(
  stationKind: string,
  recipe: FabricationRecipeDefinition,
  inventory: DomainInventory,
  context: FabricationContext = {},
): FabricationResult {
  const issues = validateRecipe(recipe);
  if (issues.length > 0) throw new Error(`Invalid fabrication recipe ${recipe.id}: ${issues.map((issue) => issue.code).join(", ")}`);
  if (stationKind !== recipe.stationKind) return { ok: false, reason: "wrong-station" };
  if (recipe.requiresBlueprint && !context.learnedBlueprints?.some((reference) => sameCatalogRef(reference, recipe.requiresBlueprint!))) {
    return { ok: false, reason: "missing-blueprint", blueprint: { ...recipe.requiresBlueprint } };
  }
  for (const [key, quantity] of Object.entries(inventory)) {
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error(`Invalid fabrication inventory quantity for ${key}.`);
    }
  }
  const missing = recipe.inputs.filter((stack) => (inventory[domainItemKey(stack.item)] ?? 0) < stack.quantity)
    .map(cloneDomainItemStack);
  if (missing.length > 0) return { ok: false, reason: "missing-inputs", missing };
  const remaining = { ...inventory };
  for (const stack of recipe.inputs) {
    const key = domainItemKey(stack.item);
    remaining[key] = (remaining[key] ?? 0) - stack.quantity;
  }
  return {
    ok: true,
    consumed: recipe.inputs.map(cloneDomainItemStack),
    produced: recipe.outputs.map(cloneDomainItemStack),
    remaining,
  };
}

export type FabricationRecipeIssue = {
  code: "empty-inputs" | "empty-outputs" | "invalid-quantity" | "duplicate-input";
  detail: string;
};

export function validateRecipe(recipe: FabricationRecipeDefinition): FabricationRecipeIssue[] {
  const issues: FabricationRecipeIssue[] = [];
  if (recipe.inputs.length === 0) issues.push({ code: "empty-inputs", detail: recipe.id });
  if (recipe.outputs.length === 0) issues.push({ code: "empty-outputs", detail: recipe.id });
  for (const stack of [...recipe.inputs, ...recipe.outputs]) {
    if (!Number.isSafeInteger(stack.quantity) || stack.quantity <= 0) {
      issues.push({ code: "invalid-quantity", detail: `${recipe.id}:${domainItemKey(stack.item)}` });
    }
  }
  const inputKeys = new Set<string>();
  for (const stack of recipe.inputs) {
    const key = domainItemKey(stack.item);
    if (inputKeys.has(key)) issues.push({ code: "duplicate-input", detail: `${recipe.id}:${key}` });
    inputKeys.add(key);
  }
  return issues;
}

function sameCatalogRef(left: CatalogRef, right: CatalogRef): boolean {
  return left.registryId === right.registryId
    && left.schemaVersion === right.schemaVersion
    && left.contentVersion === right.contentVersion
    && left.entryId === right.entryId;
}
