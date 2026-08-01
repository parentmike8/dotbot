export type RegistryEntry = { id: string };

export type VersionedRegistry<T extends RegistryEntry> = {
  registryId: string;
  schemaVersion: number;
  contentVersion: number;
  entries: readonly T[];
};

export type CatalogRef = {
  registryId: string;
  schemaVersion: number;
  contentVersion: number;
  entryId: string;
};

export function createVersionedRegistry<T extends RegistryEntry>(
  registry: VersionedRegistry<T>,
): VersionedRegistry<T> {
  if (!registry.registryId.trim()) throw new Error("Registry id is required.");
  if (!Number.isSafeInteger(registry.schemaVersion) || registry.schemaVersion < 1) {
    throw new Error("Registry schema version must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(registry.contentVersion) || registry.contentVersion < 1) {
    throw new Error("Registry content version must be a positive safe integer.");
  }
  const ids = new Set<string>();
  for (const entry of registry.entries) {
    if (!entry.id.trim()) throw new Error("Registry entry id is required.");
    if (ids.has(entry.id)) throw new Error(`Duplicate registry entry id: ${entry.id}`);
    ids.add(entry.id);
  }
  return deepCloneAndFreeze({
    ...registry,
    entries: registry.entries,
  });
}

export function catalogRef<T extends RegistryEntry>(
  registry: VersionedRegistry<T>,
  entryId: string,
): CatalogRef {
  if (!registry.entries.some((entry) => entry.id === entryId)) {
    throw new Error(`Unknown ${registry.registryId} entry: ${entryId}`);
  }
  return {
    registryId: registry.registryId,
    schemaVersion: registry.schemaVersion,
    contentVersion: registry.contentVersion,
    entryId,
  };
}

export function resolveCatalogRef<T extends RegistryEntry>(
  registry: VersionedRegistry<T>,
  reference: CatalogRef,
): T {
  if (reference.registryId !== registry.registryId) {
    throw new Error(`Registry id mismatch: expected ${registry.registryId}, received ${reference.registryId}.`);
  }
  if (reference.schemaVersion !== registry.schemaVersion) {
    throw new Error(`Registry schema version mismatch: expected ${registry.schemaVersion}, received ${reference.schemaVersion}.`);
  }
  if (reference.contentVersion !== registry.contentVersion) {
    throw new Error(`Registry content version mismatch: expected ${registry.contentVersion}, received ${reference.contentVersion}.`);
  }
  const entry = registry.entries.find((candidate) => candidate.id === reference.entryId);
  if (!entry) throw new Error(`Unknown ${registry.registryId} entry: ${reference.entryId}`);
  return entry;
}

/** Registries are data tables; clone and freeze every nested array/object. */
function deepCloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepCloneAndFreeze(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, deepCloneAndFreeze(child)]),
    );
    return Object.freeze(clone) as T;
  }
  return value;
}
