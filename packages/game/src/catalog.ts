import type { PowerupType } from "./types";
import {
  catalogRef,
  createVersionedRegistry,
  type CatalogRef,
  type VersionedRegistry,
} from "./registry";

export { catalogRef, createVersionedRegistry, resolveCatalogRef } from "./registry";
export type { CatalogRef, VersionedRegistry } from "./registry";

export type CoreDefinition = {
  id: string;
  equipmentKind: "core";
  default: boolean;
  physical: boolean;
  plateCount: { kind: "fixed"; count: number } | { kind: "relative"; direction: "fewer" | "more" };
  /** Semantic direction only; runtime movement values remain separately tuned. */
  movement?: "lighter" | "heavier";
};

export type PlateSetCapability = {
  suppressesSignals?: readonly ("radar" | "noiseMarker")[];
  shortensChannels?: readonly ("revive" | "bodyLoot")[];
  countersDamage?: readonly ("mine")[];
};

export type PlateSetDefinition = {
  id: string;
  equipmentKind: "plateSet";
  default: boolean;
  physical: boolean;
  capabilities: PlateSetCapability;
};

export type BaseObjectDefinition = {
  id: string;
  purpose: "storage" | "loadout";
};

export type BlueprintDefinition = {
  id: string;
  output: CatalogRef;
};

export type DomainItemSpec =
  | { kind: "powerup"; powerupType: PowerupType }
  | { kind: "mine" }
  | { kind: "catalog"; catalogKind: "core" | "plateSet" | "blueprint" | "baseObject"; ref: CatalogRef };

export type DomainItemStack = {
  item: DomainItemSpec;
  quantity: number;
};

export type EquipmentCatalogs = {
  readonly cores: VersionedRegistry<CoreDefinition>;
  readonly plateSets: VersionedRegistry<PlateSetDefinition>;
};

export const CORE_REGISTRY = createVersionedRegistry<CoreDefinition>({
  registryId: "dotbot.cores",
  schemaVersion: 1,
  contentVersion: 1,
  entries: [
    { id: "standard-black", equipmentKind: "core", default: true, physical: false, plateCount: { kind: "fixed", count: 3 } },
  ],
});

export const PLATE_SET_REGISTRY = createVersionedRegistry<PlateSetDefinition>({
  registryId: "dotbot.plate-sets",
  schemaVersion: 1,
  contentVersion: 1,
  entries: [
    { id: "ordinary", equipmentKind: "plateSet", default: true, physical: false, capabilities: {} },
    {
      id: "stealth",
      equipmentKind: "plateSet",
      default: false,
      physical: true,
      capabilities: { suppressesSignals: ["radar", "noiseMarker"] },
    },
    {
      id: "tech",
      equipmentKind: "plateSet",
      default: false,
      physical: true,
      capabilities: { shortensChannels: ["revive", "bodyLoot"] },
    },
    {
      id: "blast",
      equipmentKind: "plateSet",
      default: false,
      physical: true,
      capabilities: { countersDamage: ["mine"] },
    },
  ],
});

export const BASE_OBJECT_REGISTRY = createVersionedRegistry<BaseObjectDefinition>({
  registryId: "dotbot.base-objects",
  schemaVersion: 1,
  contentVersion: 1,
  entries: [
    { id: "storage", purpose: "storage" },
    { id: "locker", purpose: "loadout" },
  ],
});

export const BLUEPRINT_REGISTRY = createVersionedRegistry<BlueprintDefinition>({
  registryId: "dotbot.blueprints",
  schemaVersion: 1,
  contentVersion: 1,
  entries: [
    { id: "locker", output: catalogRef(BASE_OBJECT_REGISTRY, "locker") },
  ],
});

export const DEFAULT_EQUIPMENT_CATALOGS: EquipmentCatalogs = Object.freeze({
  cores: CORE_REGISTRY,
  plateSets: PLATE_SET_REGISTRY,
});

export type EquipmentCatalogIssue = {
  registryId: string;
  entryId?: string;
  code: "missing-default" | "multiple-defaults" | "missing-standard-black" | "missing-ordinary" | "invalid-default"
    | "invalid-plate-count" | "physical-default" | "non-physical-special";
};

export function validateEquipmentCatalogs(catalogs: EquipmentCatalogs): EquipmentCatalogIssue[] {
  const issues: EquipmentCatalogIssue[] = [];
  const validateDefaults = (registry: VersionedRegistry<CoreDefinition | PlateSetDefinition>) => {
    const defaults = registry.entries.filter((entry) => entry.default);
    if (defaults.length === 0) issues.push({ registryId: registry.registryId, code: "missing-default" });
    if (defaults.length > 1) issues.push({ registryId: registry.registryId, code: "multiple-defaults" });
    for (const entry of registry.entries) {
      if (entry.default && entry.physical) issues.push({ registryId: registry.registryId, entryId: entry.id, code: "physical-default" });
      if (!entry.default && !entry.physical) issues.push({ registryId: registry.registryId, entryId: entry.id, code: "non-physical-special" });
    }
  };
  validateDefaults(catalogs.cores);
  validateDefaults(catalogs.plateSets);
  const standard = catalogs.cores.entries.find((entry) => entry.id === "standard-black");
  if (!standard) {
    issues.push({ registryId: catalogs.cores.registryId, code: "missing-standard-black" });
  } else if (
    !standard.default
    || standard.physical
    || standard.plateCount.kind !== "fixed"
    || standard.plateCount.count !== 3
    || standard.movement !== undefined
  ) {
    issues.push({ registryId: catalogs.cores.registryId, entryId: standard.id, code: "invalid-default" });
  }
  const ordinary = catalogs.plateSets.entries.find((entry) => entry.id === "ordinary");
  if (!ordinary) {
    issues.push({ registryId: catalogs.plateSets.registryId, code: "missing-ordinary" });
  } else if (
    !ordinary.default
    || ordinary.physical
    || Object.values(ordinary.capabilities).some((values) => values !== undefined && values.length > 0)
  ) {
    issues.push({ registryId: catalogs.plateSets.registryId, entryId: ordinary.id, code: "invalid-default" });
  }
  for (const core of catalogs.cores.entries) {
    if (core.plateCount.kind === "fixed" && (!Number.isInteger(core.plateCount.count) || core.plateCount.count < 1)) {
      issues.push({ registryId: catalogs.cores.registryId, entryId: core.id, code: "invalid-plate-count" });
    }
  }
  return issues;
}

export function domainItemKey(item: DomainItemSpec): string {
  if (item.kind === "powerup") return `powerup:${item.powerupType}`;
  if (item.kind === "mine") return "mine";
  const ref = item.ref;
  return `${item.catalogKind}:${ref.registryId}:${ref.schemaVersion}:${ref.contentVersion}:${ref.entryId}`;
}

export function cloneDomainItemStack(stack: DomainItemStack): DomainItemStack {
  return {
    quantity: stack.quantity,
    item: stack.item.kind === "catalog"
      ? { ...stack.item, ref: { ...stack.item.ref } }
      : { ...stack.item },
  };
}

export function plateSetSuppressesSignal(
  plateSet: PlateSetDefinition,
  signal: "radar" | "noiseMarker",
): boolean {
  return plateSet.capabilities.suppressesSignals?.includes(signal) ?? false;
}

export function plateSetShortensChannel(
  plateSet: PlateSetDefinition,
  channel: "revive" | "bodyLoot",
): boolean {
  return plateSet.capabilities.shortensChannels?.includes(channel) ?? false;
}

export function plateSetCountersDamage(plateSet: PlateSetDefinition, damage: "mine"): boolean {
  return plateSet.capabilities.countersDamage?.includes(damage) ?? false;
}

// Keep imported generic helpers visible to declaration emit and IDE navigation.
export type DomainRegistry<T extends { id: string }> = VersionedRegistry<T>;
export type DomainCatalogReference = CatalogRef;
