import { describe, expect, it } from "vitest";
import {
  AUTHORED_CONTRACT_REGISTRY,
  TEST_LEVEL_CURVE,
  activateContract,
  advanceContractGraph,
  createContractGraphState,
  validateContractGraphState,
  validateContractRegistry,
} from "./authoredContracts";
import { advanceAiObjective, createAiObjective } from "./objectives";
import { createVersionedRegistry } from "./registry";

describe("authored Contract graph", () => {
  it("uses stable authored ids and ordered prerequisites without daily offer fields", () => {
    expect(AUTHORED_CONTRACT_REGISTRY.entries).toHaveLength(2);
    expect(AUTHORED_CONTRACT_REGISTRY.entries[1]?.prerequisiteIds)
      .toEqual([AUTHORED_CONTRACT_REGISTRY.entries[0]?.id]);
    expect(JSON.stringify(AUTHORED_CONTRACT_REGISTRY)).not.toMatch(/dayStamp|reroll|offer/i);
    expect(validateContractRegistry(AUTHORED_CONTRACT_REGISTRY)).toEqual([]);
  });

  it("activates, progresses, completes, rewards once, raises Level, and unlocks dependants", () => {
    const [first, second] = AUTHORED_CONTRACT_REGISTRY.entries;
    let state = createContractGraphState(AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE);
    expect(state.contracts[first!.id]?.status).toBe("available");
    expect(state.contracts[second!.id]?.status).toBe("locked");
    expect(activateContract(state, AUTHORED_CONTRACT_REGISTRY, second!.id, TEST_LEVEL_CURVE)).toMatchObject({ ok: false, reason: "locked" });

    const activated = activateContract(state, AUTHORED_CONTRACT_REGISTRY, first!.id, TEST_LEVEL_CURVE);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    state = activated.state;
    const completed = advanceContractGraph(
      state,
      AUTHORED_CONTRACT_REGISTRY,
      { kind: "interactionCompleted", targetId: "test-storage-locker" },
      TEST_LEVEL_CURVE,
    );
    expect(completed.completedContractIds).toEqual([first!.id]);
    expect(completed.rewards.levelProgress).toBeGreaterThan(0);
    expect(completed.state.level.level).toBeGreaterThan(1);
    expect(completed.state.contracts[first!.id]?.status).toBe("completed");
    expect(completed.state.contracts[second!.id]?.status).toBe("available");

    const replayed = advanceContractGraph(
      completed.state,
      AUTHORED_CONTRACT_REGISTRY,
      { kind: "interactionCompleted", targetId: "test-storage-locker" },
      TEST_LEVEL_CURVE,
    );
    expect(replayed.completedContractIds).toEqual([]);
    expect(replayed.rewards).toEqual({ items: [], levelProgress: 0 });
    expect(replayed.state.level).toEqual(completed.state.level);
  });

  it("rejects prerequisites that are missing or ordered after their dependant", () => {
    const invalid = createVersionedRegistry({
      registryId: "contracts.invalid",
      schemaVersion: 1,
      contentVersion: 1,
      entries: [
        { id: "later-first", title: "Later first", prerequisiteIds: ["missing"], objectives: [], rewards: { items: [], levelProgress: 0 } },
      ],
    });
    expect(validateContractRegistry(invalid).map((issue) => issue.code)).toContain("unknown-prerequisite");
    const outOfOrder = createVersionedRegistry({
      registryId: "contracts.out-of-order",
      schemaVersion: 1,
      contentVersion: 1,
      entries: [
        { id: "first", title: "First", prerequisiteIds: ["later"], objectives: [{ id: "a", kind: "visit" as const, locationId: "a", count: 1 }], rewards: { items: [], levelProgress: 0 } },
        { id: "later", title: "Later", prerequisiteIds: [], objectives: [{ id: "b", kind: "visit" as const, locationId: "b", count: 1 }], rewards: { items: [], levelProgress: 0 } },
      ],
    });
    expect(validateContractRegistry(outOfOrder).map((issue) => issue.code)).toContain("prerequisite-order");
  });

  it("does not mutate prior state and rejects stale or corrupt persisted graph state", () => {
    const first = AUTHORED_CONTRACT_REGISTRY.entries[0]!;
    const initial = createContractGraphState(AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE);
    const before = structuredClone(initial);
    expect(validateContractGraphState(JSON.parse(JSON.stringify(initial)), AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE)).toEqual([]);
    const activated = activateContract(initial, AUTHORED_CONTRACT_REGISTRY, first.id, TEST_LEVEL_CURVE);
    expect(activated.ok).toBe(true);
    expect(initial).toEqual(before);

    const stale = { ...initial, registry: { ...initial.registry, contentVersion: 0 } };
    expect(validateContractGraphState(stale, AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE).map((issue) => issue.code))
      .toContain("registry-version");
    expect(() => activateContract(stale, AUTHORED_CONTRACT_REGISTRY, first.id, TEST_LEVEL_CURVE)).toThrow(/registry-version/i);

    const corrupt = structuredClone(initial);
    corrupt.contracts[first.id]!.objectives[0]!.current = 99;
    expect(validateContractGraphState(corrupt, AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE).map((issue) => issue.code))
      .toContain("objective-progress");
    expect(() => advanceContractGraph(corrupt, AUTHORED_CONTRACT_REGISTRY, { kind: "locationReached", locationId: "elsewhere" }, TEST_LEVEL_CURVE))
      .toThrow(/objective-progress/i);
  });

  it("requires prerequisite closure when rebuilding completion state", () => {
    const first = AUTHORED_CONTRACT_REGISTRY.entries[0]!;
    const second = AUTHORED_CONTRACT_REGISTRY.entries[1]!;
    expect(() => createContractGraphState(AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE, [second.id]))
      .toThrow(/status-prerequisites/i);
    expect(() => createContractGraphState(AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE, ["missing"]))
      .toThrow(/unknown completed/i);
    expect(() => createContractGraphState(AUTHORED_CONTRACT_REGISTRY, TEST_LEVEL_CURVE, [first.id, first.id]))
      .toThrow(/duplicate completed/i);
  });

  it("requires every objective, ignores unrelated events, and matches versioned reward data", () => {
    const registry = createVersionedRegistry({
      registryId: "contracts.multi",
      schemaVersion: 1,
      contentVersion: 1,
      entries: [{
        id: "multi",
        title: "Multi",
        prerequisiteIds: [],
        objectives: [
          { id: "interact", kind: "interact" as const, targetId: "target", count: 2 },
          { id: "extract", kind: "extractItems" as const, itemId: "powerup:health", sourceId: "source", count: 1 },
        ],
        rewards: { items: [{ item: { kind: "mine" as const }, quantity: 1 }], levelProgress: 1 },
      }],
    });
    const curve = { thresholds: [{ level: 1, minimumProgress: 0 }, { level: 2, minimumProgress: 1 }] };
    const activated = activateContract(createContractGraphState(registry, curve), registry, "multi", curve);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    const unrelated = advanceContractGraph(activated.state, registry, { kind: "locationReached", locationId: "elsewhere" }, curve);
    expect(unrelated.state.contracts.multi?.objectives.map((progress) => progress.current)).toEqual([0, 0]);
    const oneInteraction = advanceContractGraph(unrelated.state, registry, { kind: "interactionCompleted", targetId: "target" }, curve);
    const wrongSource = advanceContractGraph(oneInteraction.state, registry, {
      kind: "itemsExtracted",
      items: [{ itemId: "powerup:health", sourceId: "wrong", quantity: 1 }],
    }, curve);
    expect(wrongSource.state.contracts.multi?.objectives.map((progress) => progress.current)).toEqual([1, 0]);
    const extracted = advanceContractGraph(wrongSource.state, registry, {
      kind: "itemsExtracted",
      items: [{ itemId: "powerup:health", sourceId: "source", quantity: 1 }],
    }, curve);
    expect(extracted.completedContractIds).toEqual([]);
    const completed = advanceContractGraph(extracted.state, registry, { kind: "interactionCompleted", targetId: "target" }, curve);
    expect(completed.completedContractIds).toEqual(["multi"]);
    expect(completed.rewards).toEqual({ items: [{ item: { kind: "mine" }, quantity: 1 }], levelProgress: 1 });
    expect(completed.state.level).toEqual({ totalProgress: 1, level: 2 });
  });
});

describe("shared AI objective semantics", () => {
  it("advances the same authored objective without player progression fields", () => {
    const objective = AUTHORED_CONTRACT_REGISTRY.entries[0]!.objectives[0]!;
    const initial = createAiObjective("ai-test", objective);
    const advanced = advanceAiObjective(initial, { kind: "interactionCompleted", targetId: "test-storage-locker" });
    expect(advanced.progress.completed).toBe(true);
    expect(advanced).not.toHaveProperty("rewards");
    expect(advanced).not.toHaveProperty("level");
    expect(advanced).not.toHaveProperty("contractId");
    expect(() => advanceAiObjective(initial, {
      kind: "itemsExtracted",
      items: [{ itemId: "anything", quantity: 0.5 }],
    })).toThrow(/non-negative integers/i);
  });
});
