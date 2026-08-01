import {
  resolveCatalogRef,
  type CatalogRef,
} from "./registry";
import type { EquipmentCatalogs } from "./catalog";

export type EquipmentKind = "core" | "plateSet";

export type PhysicalItemHistoryEvent = {
  eventId: string;
  kind: "found" | "fabricated" | "extracted" | "transferred" | "lost";
  ownerId?: string;
  contextId?: string;
};

export type PhysicalItemInstance = {
  readonly instanceId: string;
  readonly definition: Readonly<CatalogRef>;
  readonly equipmentKind: EquipmentKind;
  readonly history: readonly Readonly<PhysicalItemHistoryEvent>[];
};

export type PhysicalStorage = {
  readonly items: readonly PhysicalItemInstance[];
};

export type EquipmentSelection = { kind: "default" } | { kind: "stored"; instanceId: string };

export type LoadoutSelection = {
  core: EquipmentSelection;
  plateSet: EquipmentSelection;
  carriedItemInstanceIds: string[];
};

export type LockedLoadoutSelection = {
  readonly core: Readonly<EquipmentSelection>;
  readonly plateSet: Readonly<EquipmentSelection>;
  readonly carriedItemInstanceIds: readonly string[];
};

export type LockedLoadout = {
  readonly lockId: string;
  readonly selection: LockedLoadoutSelection;
  readonly itemSnapshots: readonly PhysicalItemInstance[];
};

export function createPhysicalItem(
  instanceId: string,
  definition: CatalogRef,
  equipmentKind: EquipmentKind,
  initialHistory: PhysicalItemHistoryEvent,
  catalogs: EquipmentCatalogs,
): PhysicalItemInstance {
  if (!instanceId.trim()) throw new Error("Physical item instance id is required.");
  if (!initialHistory.eventId.trim()) throw new Error("Physical item history event id is required.");
  const item: PhysicalItemInstance = {
    instanceId,
    definition: { ...definition },
    equipmentKind,
    history: [{ ...initialHistory }],
  };
  const validation = validatePhysicalItem(item, catalogs);
  if (!validation.ok) throw new Error(`Invalid physical item ${instanceId}: ${validation.reason}`);
  return freezePhysicalItem(item);
}

export function appendPhysicalItemHistory(
  item: PhysicalItemInstance,
  event: PhysicalItemHistoryEvent,
): PhysicalItemInstance {
  if (!event.eventId.trim()) throw new Error("Physical item history event id is required.");
  const existing = item.history.find((entry) => entry.eventId === event.eventId);
  if (existing) {
    if (!sameHistoryEvent(existing, event)) {
      throw new Error(`Conflicting physical item history event: ${event.eventId}`);
    }
    return clonePhysicalItem(item);
  }
  return freezePhysicalItem({ ...clonePhysicalItem(item), history: [...item.history.map((entry) => ({ ...entry })), { ...event }] });
}

export function bankExtractedItems(
  storage: PhysicalStorage,
  extracted: readonly PhysicalItemInstance[],
  catalogs: EquipmentCatalogs,
): { storage: PhysicalStorage; bankedInstanceIds: string[] } {
  const currentStorage = validatePhysicalStorage(storage, catalogs);
  if (!currentStorage.ok) throw new Error(`Cannot bank into invalid physical storage: ${currentStorage.reason}`);
  const existing = new Set(storage.items.map((item) => item.instanceId));
  const banked: PhysicalItemInstance[] = [];
  for (const item of extracted) {
    const validation = validatePhysicalItem(item, catalogs);
    if (!validation.ok) throw new Error(`Cannot bank physical item ${item.instanceId}: ${validation.reason}`);
    if (existing.has(item.instanceId)) throw new Error(`Physical item already stored: ${item.instanceId}`);
    existing.add(item.instanceId);
    banked.push(clonePhysicalItem(item));
  }
  return {
    storage: { items: [...storage.items.map(clonePhysicalItem), ...banked] },
    bankedInstanceIds: banked.map((item) => item.instanceId),
  };
}

/** Removes exact at-risk instances. Defaults are virtual and can never appear here. */
export function removePhysicalItems(
  storage: PhysicalStorage,
  instanceIds: readonly string[],
): { storage: PhysicalStorage; removed: PhysicalItemInstance[] } {
  const ids = new Set(instanceIds);
  const removed = storage.items.filter((item) => ids.has(item.instanceId)).map(clonePhysicalItem);
  return {
    storage: { items: storage.items.filter((item) => !ids.has(item.instanceId)).map(clonePhysicalItem) },
    removed,
  };
}

export type LoadoutValidation =
  | { ok: true }
  | {
    ok: false;
    reason: "missing-instance" | "wrong-equipment-kind" | "duplicate-instance" | "duplicate-storage-instance"
      | "catalog-mismatch" | "non-physical-definition" | "default-definition";
    instanceId: string;
  };

type LoadoutValidationFailure = Exclude<LoadoutValidation, { ok: true }>;

export function validatePhysicalItem(
  item: PhysicalItemInstance,
  catalogs: EquipmentCatalogs,
): LoadoutValidation {
  let definition: { equipmentKind: EquipmentKind; physical: boolean; default: boolean };
  try {
    definition = item.equipmentKind === "core"
      ? resolveCatalogRef(catalogs.cores, item.definition)
      : resolveCatalogRef(catalogs.plateSets, item.definition);
  } catch {
    return { ok: false, reason: "catalog-mismatch", instanceId: item.instanceId };
  }
  if (definition.equipmentKind !== item.equipmentKind) {
    return { ok: false, reason: "wrong-equipment-kind", instanceId: item.instanceId };
  }
  if (definition.default) return { ok: false, reason: "default-definition", instanceId: item.instanceId };
  if (!definition.physical) return { ok: false, reason: "non-physical-definition", instanceId: item.instanceId };
  return { ok: true };
}

export function validateLoadout(
  selection: LoadoutSelection,
  storage: PhysicalStorage,
  catalogs: EquipmentCatalogs,
): LoadoutValidation {
  const storageValidation = validatePhysicalStorage(storage, catalogs);
  if (!storageValidation.ok) return storageValidation;
  const byId = new Map(storage.items.map((item) => [item.instanceId, item]));
  const used = new Set<string>();
  const validateSlot = (slot: EquipmentSelection, expected: EquipmentKind): LoadoutValidation => {
    if (slot.kind === "default") return { ok: true };
    const item = byId.get(slot.instanceId);
    if (!item) return { ok: false, reason: "missing-instance", instanceId: slot.instanceId };
    if (item.equipmentKind !== expected) return { ok: false, reason: "wrong-equipment-kind", instanceId: slot.instanceId };
    if (used.has(slot.instanceId)) return { ok: false, reason: "duplicate-instance", instanceId: slot.instanceId };
    used.add(slot.instanceId);
    return { ok: true };
  };
  const core = validateSlot(selection.core, "core");
  if (!core.ok) return core;
  const plateSet = validateSlot(selection.plateSet, "plateSet");
  if (!plateSet.ok) return plateSet;
  for (const instanceId of selection.carriedItemInstanceIds) {
    if (!byId.has(instanceId)) return { ok: false, reason: "missing-instance", instanceId };
    if (used.has(instanceId)) return { ok: false, reason: "duplicate-instance", instanceId };
    used.add(instanceId);
  }
  return { ok: true };
}

export function validatePhysicalStorage(
  storage: PhysicalStorage,
  catalogs: EquipmentCatalogs,
): LoadoutValidation {
  const storageIds = new Set<string>();
  for (const item of storage.items) {
    if (storageIds.has(item.instanceId)) {
      return { ok: false, reason: "duplicate-storage-instance", instanceId: item.instanceId };
    }
    storageIds.add(item.instanceId);
    const validItem = validatePhysicalItem(item, catalogs);
    if (!validItem.ok) return validItem;
  }
  return { ok: true };
}

export type LockLoadoutResult =
  | LoadoutValidationFailure
  | { ok: false; reason: "invalid-lock-id" }
  | { ok: true; lock: LockedLoadout };

export function lockLoadoutAtPublicQueueEntry(
  selection: LoadoutSelection,
  storage: PhysicalStorage,
  lockId: string,
  catalogs: EquipmentCatalogs,
): LockLoadoutResult {
  if (!lockId.trim()) return { ok: false, reason: "invalid-lock-id" };
  const validation = validateLoadout(selection, storage, catalogs);
  if (!validation.ok) return validation;
  const ids = new Set<string>();
  if (selection.core.kind === "stored") ids.add(selection.core.instanceId);
  if (selection.plateSet.kind === "stored") ids.add(selection.plateSet.instanceId);
  for (const id of selection.carriedItemInstanceIds) ids.add(id);
  return deepFreeze({
    ok: true,
    lock: {
      lockId,
      selection: cloneLoadout(selection),
      itemSnapshots: storage.items.filter((item) => ids.has(item.instanceId)).map(clonePhysicalItem),
    },
  });
}

export function reconcileLoadoutAfterLoss(
  selection: LoadoutSelection,
  storage: PhysicalStorage,
  catalogs: EquipmentCatalogs,
): LoadoutSelection {
  const storageValidation = validatePhysicalStorage(storage, catalogs);
  if (!storageValidation.ok) throw new Error(`Cannot reconcile invalid physical storage: ${storageValidation.reason}`);
  const byId = new Map(storage.items.map((item) => [item.instanceId, item]));
  const validSlot = (slot: EquipmentSelection, kind: EquipmentKind): EquipmentSelection => {
    if (slot.kind === "default") return { kind: "default" };
    const item = byId.get(slot.instanceId);
    return item?.equipmentKind === kind && validatePhysicalItem(item, catalogs).ok ? { ...slot } : { kind: "default" };
  };
  return {
    core: validSlot(selection.core, "core"),
    plateSet: validSlot(selection.plateSet, "plateSet"),
    carriedItemInstanceIds: selection.carriedItemInstanceIds.filter((id) => byId.has(id)),
  };
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value) as T;
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}

function cloneLoadout(selection: LoadoutSelection): LoadoutSelection {
  return {
    core: { ...selection.core },
    plateSet: { ...selection.plateSet },
    carriedItemInstanceIds: [...selection.carriedItemInstanceIds],
  };
}

function clonePhysicalItem(item: PhysicalItemInstance): PhysicalItemInstance {
  return freezePhysicalItem({
    ...item,
    definition: { ...item.definition },
    history: item.history.map((event) => ({ ...event })),
  });
}

function freezePhysicalItem(item: PhysicalItemInstance): PhysicalItemInstance {
  Object.freeze(item.definition);
  for (const event of item.history) Object.freeze(event);
  Object.freeze(item.history);
  return Object.freeze(item);
}

function sameHistoryEvent(left: Readonly<PhysicalItemHistoryEvent>, right: PhysicalItemHistoryEvent): boolean {
  return left.eventId === right.eventId
    && left.kind === right.kind
    && left.ownerId === right.ownerId
    && left.contextId === right.contextId;
}
