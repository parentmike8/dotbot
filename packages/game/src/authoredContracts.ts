import { type DomainItemStack, cloneDomainItemStack } from "./catalog";
import {
  advanceObjective,
  createObjectiveProgress,
  type AuthoredObjectiveDefinition,
  type ObjectiveDomainEvent,
  type ObjectiveProgress,
  validateObjectiveDefinition,
} from "./objectives";
import { createVersionedRegistry, type VersionedRegistry } from "./registry";

export type AuthoredContractDefinition = {
  id: string;
  title: string;
  /** Ordered authored dependencies. Every id must precede this entry. */
  prerequisiteIds: readonly string[];
  objectives: readonly AuthoredObjectiveDefinition[];
  rewards: {
    items: readonly DomainItemStack[];
    levelProgress: number;
  };
};

export type ContractStatus = "locked" | "available" | "active" | "completed";

export type ContractProgressState = {
  contractId: string;
  status: ContractStatus;
  objectives: readonly ObjectiveProgress[];
};

export type LevelCurve = {
  thresholds: readonly { level: number; minimumProgress: number }[];
};

export type LevelProgress = {
  totalProgress: number;
  level: number;
};

export type ContractGraphState = {
  registry: {
    registryId: string;
    schemaVersion: number;
    contentVersion: number;
  };
  contracts: Readonly<Record<string, ContractProgressState>>;
  level: LevelProgress;
};

export type ContractGraphStateIssue = {
  code:
    | "registry-version"
    | "registry-definition"
    | "missing-contract"
    | "unknown-contract"
    | "contract-id"
    | "invalid-status"
    | "objective-shape"
    | "objective-progress"
    | "inactive-progress"
    | "status-prerequisites"
    | "status-completion"
    | "level-progress";
  contractId?: string;
  detail: string;
};

export const TEST_LEVEL_CURVE: LevelCurve = Object.freeze({
  thresholds: Object.freeze([
    Object.freeze({ level: 1, minimumProgress: 0 }),
    Object.freeze({ level: 2, minimumProgress: 10 }),
    Object.freeze({ level: 3, minimumProgress: 30 }),
  ]),
});

/** Disposable integration content only. The real progression arc is deferred. */
export const AUTHORED_CONTRACT_REGISTRY = createVersionedRegistry<AuthoredContractDefinition>({
  registryId: "dotbot.contracts",
  schemaVersion: 1,
  contentVersion: 1,
  entries: [
    {
      id: "test-open-storage",
      title: "TEST STORAGE",
      prerequisiteIds: [],
      objectives: [{ id: "use-test-storage", kind: "interact", targetId: "test-storage-locker", count: 1 }],
      rewards: { items: [], levelProgress: 10 },
    },
    {
      id: "test-extract-health",
      title: "TEST EXTRACTION",
      prerequisiteIds: ["test-open-storage"],
      objectives: [{ id: "extract-test-health", kind: "extractItems", itemId: "powerup:health", count: 1 }],
      rewards: { items: [], levelProgress: 10 },
    },
  ],
});

export type ContractRegistryIssue = {
  code: "unknown-prerequisite" | "prerequisite-order" | "duplicate-prerequisite" | "duplicate-objective" | "empty-objectives"
    | "invalid-objective" | "invalid-reward";
  contractId: string;
  detail: string;
};

export function validateContractRegistry(
  registry: VersionedRegistry<AuthoredContractDefinition>,
): ContractRegistryIssue[] {
  const issues: ContractRegistryIssue[] = [];
  const indices = new Map(registry.entries.map((entry, index) => [entry.id, index]));
  for (const [index, contract] of registry.entries.entries()) {
    const prerequisites = new Set<string>();
    for (const prerequisiteId of contract.prerequisiteIds) {
      if (prerequisites.has(prerequisiteId)) {
        issues.push({ code: "duplicate-prerequisite", contractId: contract.id, detail: prerequisiteId });
      }
      prerequisites.add(prerequisiteId);
      const prerequisiteIndex = indices.get(prerequisiteId);
      if (prerequisiteIndex === undefined) {
        issues.push({ code: "unknown-prerequisite", contractId: contract.id, detail: prerequisiteId });
      } else if (prerequisiteIndex >= index) {
        issues.push({ code: "prerequisite-order", contractId: contract.id, detail: prerequisiteId });
      }
    }
    if (contract.objectives.length === 0) {
      issues.push({ code: "empty-objectives", contractId: contract.id, detail: "Contract has no objectives." });
    }
    const objectiveIds = new Set<string>();
    for (const objective of contract.objectives) {
      if (objectiveIds.has(objective.id)) {
        issues.push({ code: "duplicate-objective", contractId: contract.id, detail: objective.id });
      }
      objectiveIds.add(objective.id);
      if (validateObjectiveDefinition(objective).length > 0) {
        issues.push({ code: "invalid-objective", contractId: contract.id, detail: objective.id });
      }
    }
    if (!Number.isSafeInteger(contract.rewards.levelProgress) || contract.rewards.levelProgress < 0) {
      issues.push({ code: "invalid-reward", contractId: contract.id, detail: "Level progress must be a non-negative integer." });
    }
    for (const item of contract.rewards.items) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
        issues.push({ code: "invalid-reward", contractId: contract.id, detail: "Reward item quantity must be a positive integer." });
      }
    }
  }
  return issues;
}

export function createContractGraphState(
  registry: VersionedRegistry<AuthoredContractDefinition>,
  levelCurve: LevelCurve,
  completedContractIds: readonly string[] = [],
  totalLevelProgress = 0,
): ContractGraphState {
  const issues = validateContractRegistry(registry);
  if (issues.length > 0) throw new Error(`Invalid Contract registry: ${issues.map((issue) => `${issue.code}:${issue.contractId}`).join(", ")}`);
  validateLevelCurve(levelCurve);
  const knownIds = new Set(registry.entries.map((entry) => entry.id));
  const seenCompleted = new Set<string>();
  for (const contractId of completedContractIds) {
    if (!knownIds.has(contractId)) throw new Error(`Unknown completed Contract id: ${contractId}`);
    if (seenCompleted.has(contractId)) throw new Error(`Duplicate completed Contract id: ${contractId}`);
    seenCompleted.add(contractId);
  }
  const completed = new Set(completedContractIds);
  const contracts = Object.fromEntries(registry.entries.map((contract): [string, ContractProgressState] => {
    const isCompleted = completed.has(contract.id);
    return [contract.id, {
      contractId: contract.id,
      status: isCompleted
        ? "completed"
        : contract.prerequisiteIds.every((id) => completed.has(id)) ? "available" : "locked",
      objectives: contract.objectives.map((objective) => {
        const progress = createObjectiveProgress(objective);
        return isCompleted ? { ...progress, current: progress.required, completed: true } : progress;
      }),
    }];
  }));
  const state: ContractGraphState = {
    registry: {
      registryId: registry.registryId,
      schemaVersion: registry.schemaVersion,
      contentVersion: registry.contentVersion,
    },
    contracts,
    level: { totalProgress: totalLevelProgress, level: levelForProgress(totalLevelProgress, levelCurve) },
  };
  assertContractGraphState(state, registry, levelCurve);
  return state;
}

export type ActivateContractResult =
  | { ok: false; reason: "unknown-contract" | "locked" | "already-active" | "completed" }
  | { ok: true; state: ContractGraphState };

export function activateContract(
  state: ContractGraphState,
  registry: VersionedRegistry<AuthoredContractDefinition>,
  contractId: string,
  levelCurve: LevelCurve,
): ActivateContractResult {
  assertContractGraphState(state, registry, levelCurve);
  const current = ownContractProgress(state.contracts, contractId);
  if (!current) return { ok: false, reason: "unknown-contract" };
  if (current.status === "locked") return { ok: false, reason: "locked" };
  if (current.status === "active") return { ok: false, reason: "already-active" };
  if (current.status === "completed") return { ok: false, reason: "completed" };
  return {
    ok: true,
    state: {
      ...state,
      contracts: { ...state.contracts, [contractId]: { ...current, status: "active" } },
    },
  };
}

export type ContractAdvanceResult = {
  state: ContractGraphState;
  completedContractIds: string[];
  rewards: { items: DomainItemStack[]; levelProgress: number };
};

export function advanceContractGraph(
  state: ContractGraphState,
  registry: VersionedRegistry<AuthoredContractDefinition>,
  event: ObjectiveDomainEvent,
  levelCurve: LevelCurve,
): ContractAdvanceResult {
  assertContractGraphState(state, registry, levelCurve);
  const contracts: Record<string, ContractProgressState> = { ...state.contracts };
  const completedContractIds: string[] = [];
  const rewards = { items: [] as DomainItemStack[], levelProgress: 0 };
  for (const definition of registry.entries) {
    const current = ownContractProgress(contracts, definition.id);
    if (!current || current.status !== "active") continue;
    const objectives = definition.objectives.map((objective, index) =>
      advanceObjective(objective, current.objectives[index] ?? createObjectiveProgress(objective), event));
    if (objectives.every((objective) => objective.completed)) {
      contracts[definition.id] = { ...current, objectives, status: "completed" };
      completedContractIds.push(definition.id);
      rewards.items.push(...definition.rewards.items.map(cloneDomainItemStack));
      rewards.levelProgress += definition.rewards.levelProgress;
    } else {
      contracts[definition.id] = { ...current, objectives };
    }
  }
  for (const definition of registry.entries) {
    const current = ownContractProgress(contracts, definition.id);
    if (current?.status === "locked" && definition.prerequisiteIds.every((id) => ownContractProgress(contracts, id)?.status === "completed")) {
      contracts[definition.id] = { ...current, status: "available" };
    }
  }
  const totalProgress = state.level.totalProgress + rewards.levelProgress;
  const nextState = { ...state, contracts, level: { totalProgress, level: levelForProgress(totalProgress, levelCurve) } };
  assertContractGraphState(nextState, registry, levelCurve);
  return {
    state: nextState,
    completedContractIds,
    rewards,
  };
}

export function validateContractGraphState(
  state: ContractGraphState,
  registry: VersionedRegistry<AuthoredContractDefinition>,
  levelCurve: LevelCurve,
): ContractGraphStateIssue[] {
  const issues: ContractGraphStateIssue[] = [];
  for (const registryIssue of validateContractRegistry(registry)) {
    issues.push({ code: "registry-definition", contractId: registryIssue.contractId, detail: registryIssue.code });
  }
  if (
    state.registry.registryId !== registry.registryId
    || state.registry.schemaVersion !== registry.schemaVersion
    || state.registry.contentVersion !== registry.contentVersion
  ) issues.push({ code: "registry-version", detail: "State and Contract registry versions differ." });

  const definitions = new Map(registry.entries.map((entry) => [entry.id, entry]));
  for (const contractId of Object.keys(state.contracts)) {
    if (!definitions.has(contractId)) issues.push({ code: "unknown-contract", contractId, detail: contractId });
  }
  for (const definition of registry.entries) {
    const progress = ownContractProgress(state.contracts, definition.id);
    if (!progress || typeof progress !== "object") {
      issues.push({ code: "missing-contract", contractId: definition.id, detail: definition.id });
      continue;
    }
    if (progress.contractId !== definition.id) {
      issues.push({ code: "contract-id", contractId: definition.id, detail: progress.contractId });
    }
    if (!isContractStatus(progress.status)) {
      issues.push({ code: "invalid-status", contractId: definition.id, detail: String(progress.status) });
    }
    const objectiveProgresses = Array.isArray(progress.objectives) ? progress.objectives : [];
    if (!Array.isArray(progress.objectives) || objectiveProgresses.length !== definition.objectives.length) {
      issues.push({ code: "objective-shape", contractId: definition.id, detail: "Objective count differs." });
    }
    for (const [index, objective] of definition.objectives.entries()) {
      const objectiveProgress = objectiveProgresses[index];
      if (
        !objectiveProgress
        || typeof objectiveProgress !== "object"
        || objectiveProgress.objectiveId !== objective.id
        || objectiveProgress.required !== objective.count
      ) {
        issues.push({ code: "objective-shape", contractId: definition.id, detail: objective.id });
        continue;
      }
      if (
        !Number.isSafeInteger(objectiveProgress.current)
        || objectiveProgress.current < 0
        || objectiveProgress.current > objectiveProgress.required
        || objectiveProgress.completed !== (objectiveProgress.current >= objectiveProgress.required)
      ) issues.push({ code: "objective-progress", contractId: definition.id, detail: objective.id });
    }
    const prerequisitesComplete = definition.prerequisiteIds.every((id) => ownContractProgress(state.contracts, id)?.status === "completed");
    if ((progress.status === "available" || progress.status === "active" || progress.status === "completed") !== prerequisitesComplete) {
      issues.push({ code: "status-prerequisites", contractId: definition.id, detail: progress.status });
    }
    const objectivesComplete = objectiveProgresses.length > 0 && objectiveProgresses.every(
      (objective) => objective !== null && typeof objective === "object" && objective.completed === true,
    );
    if ((progress.status === "completed") !== objectivesComplete) {
      issues.push({ code: "status-completion", contractId: definition.id, detail: progress.status });
    }
    if (
      (progress.status === "locked" || progress.status === "available")
      && objectiveProgresses.some((objective) =>
        objective !== null
        && typeof objective === "object"
        && (objective.current !== 0 || objective.completed))
    ) {
      issues.push({ code: "inactive-progress", contractId: definition.id, detail: progress.status });
    }
  }
  if (!Number.isSafeInteger(state.level.totalProgress) || state.level.totalProgress < 0) {
    issues.push({ code: "level-progress", detail: String(state.level.totalProgress) });
  } else if (state.level.level !== levelForProgress(state.level.totalProgress, levelCurve)) {
    issues.push({ code: "level-progress", detail: `Expected Level ${levelForProgress(state.level.totalProgress, levelCurve)}.` });
  }
  return issues;
}

export function levelForProgress(totalProgress: number, curve: LevelCurve): number {
  validateLevelCurve(curve);
  if (!Number.isSafeInteger(totalProgress) || totalProgress < 0) {
    throw new Error("Level progress must be a non-negative safe integer.");
  }
  let level = curve.thresholds[0]!.level;
  for (const threshold of curve.thresholds) {
    if (totalProgress < threshold.minimumProgress) break;
    level = threshold.level;
  }
  return level;
}

function validateLevelCurve(curve: LevelCurve): void {
  if (curve.thresholds.length === 0) throw new Error("Level curve requires at least one threshold.");
  if (curve.thresholds[0]?.minimumProgress !== 0) throw new Error("Level curve must begin at zero progress.");
  if (curve.thresholds[0]?.level !== 1) throw new Error("Level curve must begin at Level 1.");
  let previousLevel = 0;
  let previousProgress = -1;
  for (const threshold of curve.thresholds) {
    if (!Number.isSafeInteger(threshold.level) || threshold.level <= previousLevel) throw new Error("Level curve levels must increase.");
    if (!Number.isSafeInteger(threshold.minimumProgress) || threshold.minimumProgress <= previousProgress) {
      throw new Error("Level curve progress thresholds must increase.");
    }
    previousLevel = threshold.level;
    previousProgress = threshold.minimumProgress;
  }
}

function isContractStatus(status: unknown): status is ContractStatus {
  return status === "locked" || status === "available" || status === "active" || status === "completed";
}

function ownContractProgress(
  contracts: Readonly<Record<string, ContractProgressState>>,
  contractId: string,
): ContractProgressState | undefined {
  return Object.hasOwn(contracts, contractId) ? contracts[contractId] : undefined;
}

function assertContractGraphState(
  state: ContractGraphState,
  registry: VersionedRegistry<AuthoredContractDefinition>,
  levelCurve: LevelCurve,
): void {
  const issues = validateContractGraphState(state, registry, levelCurve);
  if (issues.length > 0) {
    throw new Error(`Invalid Contract graph state: ${issues.map((issue) => `${issue.code}:${issue.contractId ?? issue.detail}`).join(", ")}`);
  }
}
