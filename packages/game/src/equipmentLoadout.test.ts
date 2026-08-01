import { describe, expect, it } from "vitest";
import { CORE_REGISTRY, PLATE_SET_REGISTRY, catalogRef, createVersionedRegistry, type CoreDefinition } from "./catalog";
import {
  appendPhysicalItemHistory,
  bankExtractedItems,
  createPhysicalItem,
  lockLoadoutAtPublicQueueEntry,
  reconcileLoadoutAfterLoss,
  removePhysicalItems,
  validateLoadout,
  type LoadoutSelection,
  type PhysicalStorage,
} from "./equipment";

const provenance = { eventId: "found-1", kind: "found" as const, ownerId: "player-a", contextId: "test-room" };

const testCoreRegistry = createVersionedRegistry<CoreDefinition>({
  registryId: CORE_REGISTRY.registryId,
  schemaVersion: CORE_REGISTRY.schemaVersion,
  contentVersion: 2,
  entries: [
    ...CORE_REGISTRY.entries,
    {
      id: "test-light",
      equipmentKind: "core",
      default: false,
      physical: true,
      plateCount: { kind: "relative", direction: "fewer" },
      movement: "lighter",
    },
  ],
});
const equipmentCatalogs = { cores: testCoreRegistry, plateSets: PLATE_SET_REGISTRY };

describe("physical equipment and loadout seams", () => {
  it("banks extracted physical items without equipping the next run", () => {
    const rareCore = createPhysicalItem("core-instance-1", catalogRef(testCoreRegistry, "test-light"), "core", provenance, equipmentCatalogs);
    expect(() => {
      (rareCore.definition as { entryId: string }).entryId = "mutated";
    }).toThrow();
    const storage: PhysicalStorage = { items: [] };
    const selected: LoadoutSelection = { core: { kind: "default" }, plateSet: { kind: "default" }, carriedItemInstanceIds: [] };
    const banked = bankExtractedItems(storage, [rareCore], equipmentCatalogs);
    expect(banked.storage.items).toEqual([rareCore]);
    expect(banked).not.toHaveProperty("selectedLoadout");
    expect(selected).toEqual({ core: { kind: "default" }, plateSet: { kind: "default" }, carriedItemInstanceIds: [] });
  });

  it("equips stored Core and Plate Set instances, locks a snapshot, and rejects duplicate risk", () => {
    const core = createPhysicalItem("core-1", catalogRef(testCoreRegistry, "test-light"), "core", provenance, equipmentCatalogs);
    const plates = createPhysicalItem("plates-1", catalogRef(PLATE_SET_REGISTRY, "stealth"), "plateSet", provenance, equipmentCatalogs);
    const storage = { items: [core, plates] };
    const selection: LoadoutSelection = {
      core: { kind: "stored", instanceId: "core-1" },
      plateSet: { kind: "stored", instanceId: "plates-1" },
      carriedItemInstanceIds: [],
    };
    expect(validateLoadout(selection, storage, equipmentCatalogs)).toEqual({ ok: true });
    const locked = lockLoadoutAtPublicQueueEntry(selection, storage, "queue-entry-1", equipmentCatalogs);
    expect(locked).toMatchObject({ ok: true, lock: { lockId: "queue-entry-1", selection } });
    selection.carriedItemInstanceIds.push("plates-1");
    if (locked.ok) expect(locked.lock.selection.carriedItemInstanceIds).toEqual([]);
    expect(validateLoadout({ ...selection, carriedItemInstanceIds: ["core-1"] }, storage, equipmentCatalogs))
      .toEqual({ ok: false, reason: "duplicate-instance", instanceId: "core-1" });
  });

  it("falls back to ordinary defaults after a physical Core or Plate Set is lost", () => {
    const missing: LoadoutSelection = {
      core: { kind: "stored", instanceId: "lost-core" },
      plateSet: { kind: "stored", instanceId: "lost-plates" },
      carriedItemInstanceIds: ["lost-cargo"],
    };
    expect(reconcileLoadoutAfterLoss(missing, { items: [] }, equipmentCatalogs)).toEqual({
      core: { kind: "default" },
      plateSet: { kind: "default" },
      carriedItemInstanceIds: [],
    });
  });

  it("removes losable instances and keeps append-only ownership/extraction history", () => {
    const core = appendPhysicalItemHistory(
      createPhysicalItem("core-1", catalogRef(testCoreRegistry, "test-light"), "core", provenance, equipmentCatalogs),
      { eventId: "extracted-1", kind: "extracted", ownerId: "player-b", contextId: "match-1" },
    );
    const lost = removePhysicalItems({ items: [core] }, [core.instanceId]);
    expect(lost.storage.items).toEqual([]);
    expect(lost.removed[0]?.history).toEqual([provenance, expect.objectContaining({ ownerId: "player-b", kind: "extracted" })]);
    expect(() => appendPhysicalItemHistory(core, { eventId: "extracted-1", kind: "lost", ownerId: "player-b" }))
      .toThrow(/conflicting/i);
  });

  it("rejects virtual defaults, stale catalog refs, and duplicate stored identities", () => {
    expect(() => createPhysicalItem(
      "default-core",
      catalogRef(CORE_REGISTRY, "standard-black"),
      "core",
      provenance,
      { cores: CORE_REGISTRY, plateSets: PLATE_SET_REGISTRY },
    )).toThrow(/default-definition/i);
    expect(() => createPhysicalItem(
      "stale-core",
      { ...catalogRef(testCoreRegistry, "test-light"), contentVersion: 1 },
      "core",
      provenance,
      equipmentCatalogs,
    )).toThrow(/catalog-mismatch/i);

    const core = createPhysicalItem("core-1", catalogRef(testCoreRegistry, "test-light"), "core", provenance, equipmentCatalogs);
    expect(validateLoadout(
      { core: { kind: "default" }, plateSet: { kind: "default" }, carriedItemInstanceIds: [] },
      { items: [core, core] },
      equipmentCatalogs,
    )).toEqual({ ok: false, reason: "duplicate-storage-instance", instanceId: "core-1" });
  });

  it("rejects an empty queue lock id and freezes the accepted run snapshot", () => {
    const core = createPhysicalItem("core-1", catalogRef(testCoreRegistry, "test-light"), "core", provenance, equipmentCatalogs);
    const storage = { items: [core] };
    const selection: LoadoutSelection = { core: { kind: "stored", instanceId: "core-1" }, plateSet: { kind: "default" }, carriedItemInstanceIds: [] };
    expect(lockLoadoutAtPublicQueueEntry(selection, storage, "", equipmentCatalogs)).toEqual({ ok: false, reason: "invalid-lock-id" });
    const result = lockLoadoutAtPublicQueueEntry(selection, storage, "queue-1", equipmentCatalogs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => {
      (result.lock.selection.carriedItemInstanceIds as string[]).push("forged-after-lock");
    }).toThrow();
    expect(() => {
      (result.lock.itemSnapshots[0]!.definition as { entryId: string }).entryId = "forged-after-lock";
    }).toThrow();
  });
});
