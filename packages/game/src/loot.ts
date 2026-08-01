import { cloneDomainItemStack, type DomainItemStack } from "./catalog";
import { createVersionedRegistry, resolveCatalogRef, type CatalogRef, type VersionedRegistry } from "./registry";

export type LootTableEntry = {
  weight: number;
  output: DomainItemStack;
};

export type LootTableDefinition = {
  id: string;
  rolls: number;
  entries: readonly LootTableEntry[];
};

export const LOOT_TABLE_REGISTRY = createVersionedRegistry<LootTableDefinition>({
  registryId: "dotbot.loot-tables",
  schemaVersion: 1,
  contentVersion: 1,
  entries: [
    {
      id: "test-locker",
      rolls: 1,
      entries: [
        { weight: 3, output: { item: { kind: "powerup", powerupType: "health" }, quantity: 1 } },
        { weight: 1, output: { item: { kind: "powerup", powerupType: "radar" }, quantity: 1 } },
      ],
    },
  ],
});

export type LootTableIssue = {
  code: "invalid-rolls" | "empty-entries" | "invalid-weight" | "invalid-quantity";
  tableId: string;
};

export function validateLootTableRegistry(
  registry: VersionedRegistry<LootTableDefinition>,
): LootTableIssue[] {
  const issues: LootTableIssue[] = [];
  for (const table of registry.entries) {
    if (!Number.isInteger(table.rolls) || table.rolls < 0) issues.push({ code: "invalid-rolls", tableId: table.id });
    if (table.rolls > 0 && table.entries.length === 0) issues.push({ code: "empty-entries", tableId: table.id });
    for (const entry of table.entries) {
      if (!Number.isFinite(entry.weight) || entry.weight <= 0) issues.push({ code: "invalid-weight", tableId: table.id });
      if (!Number.isInteger(entry.output.quantity) || entry.output.quantity <= 0) {
        issues.push({ code: "invalid-quantity", tableId: table.id });
      }
    }
  }
  return issues;
}

export function rollLootTable(
  registry: VersionedRegistry<LootTableDefinition>,
  tableRef: CatalogRef,
  seed: string,
): DomainItemStack[] {
  const table = resolveCatalogRef(registry, tableRef);
  const issues = validateLootTableRegistry(registry).filter((issue) => issue.tableId === table.id);
  if (issues.length > 0) throw new Error(`Invalid loot table ${table.id}: ${issues.map((issue) => issue.code).join(", ")}`);
  const totalWeight = table.entries.reduce((total, entry) => {
    return total + entry.weight;
  }, 0);
  const random = seededRandom(`${tableRef.contentVersion}|${table.id}|${seed}`);
  const output: DomainItemStack[] = [];
  for (let roll = 0; roll < table.rolls; roll += 1) {
    let cursor = random() * totalWeight;
    const selected = table.entries.find((entry) => {
      cursor -= entry.weight;
      return cursor < 0;
    }) ?? table.entries[table.entries.length - 1];
    if (selected) output.push(cloneDomainItemStack(selected.output));
  }
  return output;
}

function seededRandom(seed: string): () => number {
  let state = stableHash(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
