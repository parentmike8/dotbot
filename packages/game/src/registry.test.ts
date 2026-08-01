import { describe, expect, it } from "vitest";
import {
  BASE_OBJECT_REGISTRY,
  BLUEPRINT_REGISTRY,
  CORE_REGISTRY,
  PLATE_SET_REGISTRY,
  catalogRef,
  createVersionedRegistry,
  plateSetCountersDamage,
  plateSetShortensChannel,
  plateSetSuppressesSignal,
  resolveCatalogRef,
  validateEquipmentCatalogs,
} from "./catalog";

describe("versioned domain registries", () => {
  it("keeps stable versioned references and rejects silent reinterpretation", () => {
    const registry = createVersionedRegistry({
      registryId: "test.things",
      schemaVersion: 1,
      contentVersion: 3,
      entries: [{ id: "one", value: 1 }],
    });
    const reference = catalogRef(registry, "one");
    expect(reference).toEqual({ registryId: "test.things", schemaVersion: 1, contentVersion: 3, entryId: "one" });
    expect(resolveCatalogRef(registry, reference)).toEqual({ id: "one", value: 1 });
    expect(() => resolveCatalogRef(registry, { ...reference, contentVersion: 2 })).toThrow(/content version/i);
    expect(() => createVersionedRegistry({ ...registry, entries: [{ id: "one" }, { id: "one" }] })).toThrow(/duplicate/i);
  });

  it("clones and freezes registry data so later mutation cannot rewrite a version", () => {
    const source = [{ id: "one", nested: { enabled: true } }];
    const registry = createVersionedRegistry({ registryId: "test.frozen", schemaVersion: 1, contentVersion: 1, entries: source });
    source[0]!.nested.enabled = false;
    expect(registry.entries[0]).toMatchObject({ nested: { enabled: true } });
    expect(() => {
      (registry.entries[0] as { nested: { enabled: boolean } }).nested.enabled = false;
    }).toThrow();
  });

  it("ships only the always-available defaults and tiny integration catalog", () => {
    expect(CORE_REGISTRY.entries).toEqual([
      expect.objectContaining({ id: "standard-black", default: true, physical: false, plateCount: { kind: "fixed", count: 3 } }),
    ]);
    expect(PLATE_SET_REGISTRY.entries.map((entry) => entry.id)).toEqual(["ordinary", "stealth", "tech", "blast"]);
    expect(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "ordinary")).toMatchObject({ default: true, physical: false });
    expect(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "stealth")?.capabilities)
      .toMatchObject({ suppressesSignals: ["radar", "noiseMarker"] });
    expect(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "tech")?.capabilities)
      .toMatchObject({ shortensChannels: ["revive", "bodyLoot"] });
    expect(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "blast")?.capabilities)
      .toMatchObject({ countersDamage: ["mine"] });
    expect(plateSetSuppressesSignal(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "stealth")!, "radar")).toBe(true);
    expect(plateSetShortensChannel(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "tech")!, "bodyLoot")).toBe(true);
    expect(plateSetCountersDamage(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "blast")!, "mine")).toBe(true);
    expect(plateSetCountersDamage(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "stealth")!, "mine")).toBe(false);
    expect(plateSetSuppressesSignal(PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "ordinary")!, "radar")).toBe(false);
    expect(() => {
      (PLATE_SET_REGISTRY.entries.find((entry) => entry.id === "stealth")!.capabilities.suppressesSignals as string[]).push("mine");
    }).toThrow();
    expect(BASE_OBJECT_REGISTRY.entries.map((entry) => entry.id)).toEqual(["storage", "locker"]);
    expect(BLUEPRINT_REGISTRY.entries.map((entry) => entry.id)).toEqual(["locker"]);
    expect(resolveCatalogRef(BASE_OBJECT_REGISTRY, BLUEPRINT_REGISTRY.entries[0]!.output).id).toBe("locker");
    expect(validateEquipmentCatalogs({ cores: CORE_REGISTRY, plateSets: PLATE_SET_REGISTRY })).toEqual([]);
  });

  it("detects catalog mutations that remove defaults or make special equipment virtual", () => {
    const noDefaultCores = createVersionedRegistry({
      ...CORE_REGISTRY,
      contentVersion: 2,
      entries: [{ id: "rare", equipmentKind: "core" as const, default: false, physical: false, plateCount: { kind: "fixed" as const, count: 0 } }],
    });
    expect(validateEquipmentCatalogs({ cores: noDefaultCores, plateSets: PLATE_SET_REGISTRY }).map((issue) => issue.code))
      .toEqual(expect.arrayContaining(["missing-default", "non-physical-special", "invalid-plate-count"]));
  });
});
