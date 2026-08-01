export type AuthoredObjectiveDefinition =
  | { id: string; kind: "interact"; targetId: string; count: number }
  | { id: string; kind: "extractItems"; itemId: string; sourceId?: string; count: number }
  | { id: string; kind: "visit"; locationId: string; count: number };

export type ObjectiveDomainEvent =
  | { kind: "interactionCompleted"; targetId: string }
  | { kind: "itemsExtracted"; items: readonly { itemId: string; sourceId?: string; quantity: number }[] }
  | { kind: "locationReached"; locationId: string };

export type ObjectiveProgress = {
  objectiveId: string;
  current: number;
  required: number;
  completed: boolean;
};

export type ObjectiveIssue = {
  code: "missing-id" | "missing-target" | "invalid-count";
};

export function validateObjectiveDefinition(objective: AuthoredObjectiveDefinition): ObjectiveIssue[] {
  const issues: ObjectiveIssue[] = [];
  if (!objective.id.trim()) issues.push({ code: "missing-id" });
  const target = objective.kind === "interact"
    ? objective.targetId
    : objective.kind === "visit" ? objective.locationId : objective.itemId;
  if (!target.trim()) issues.push({ code: "missing-target" });
  if (objective.kind === "extractItems" && objective.sourceId !== undefined && !objective.sourceId.trim()) {
    issues.push({ code: "missing-target" });
  }
  if (!Number.isSafeInteger(objective.count) || objective.count < 1) issues.push({ code: "invalid-count" });
  return issues;
}

export function createObjectiveProgress(objective: AuthoredObjectiveDefinition): ObjectiveProgress {
  const issues = validateObjectiveDefinition(objective);
  if (issues.length > 0) throw new Error(`Invalid objective ${objective.id}: ${issues.map((issue) => issue.code).join(", ")}`);
  return { objectiveId: objective.id, current: 0, required: objective.count, completed: false };
}

export function advanceObjective(
  objective: AuthoredObjectiveDefinition,
  progress: ObjectiveProgress,
  event: ObjectiveDomainEvent,
): ObjectiveProgress {
  const definitionIssues = validateObjectiveDefinition(objective);
  if (definitionIssues.length > 0) throw new Error(`Invalid objective ${objective.id}: ${definitionIssues.map((issue) => issue.code).join(", ")}`);
  if (progress.objectiveId !== objective.id) throw new Error(`Objective progress mismatch for ${objective.id}.`);
  if (
    progress.required !== objective.count
    || !Number.isSafeInteger(progress.current)
    || progress.current < 0
    || progress.current > progress.required
    || progress.completed !== (progress.current >= progress.required)
  ) throw new Error(`Invalid objective progress for ${objective.id}.`);
  if (event.kind === "itemsExtracted" && event.items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 0)) {
    throw new Error("Extracted objective item quantities must be non-negative integers.");
  }
  if (progress.completed) return { ...progress };
  let increment = 0;
  if (objective.kind === "interact" && event.kind === "interactionCompleted" && event.targetId === objective.targetId) {
    increment = 1;
  } else if (objective.kind === "visit" && event.kind === "locationReached" && event.locationId === objective.locationId) {
    increment = 1;
  } else if (objective.kind === "extractItems" && event.kind === "itemsExtracted") {
    increment = event.items.reduce((total, item) => total + (
      item.itemId === objective.itemId && (objective.sourceId === undefined || item.sourceId === objective.sourceId)
        ? Math.max(0, item.quantity)
        : 0
    ), 0);
  }
  const current = Math.min(progress.required, progress.current + increment);
  return { ...progress, current, completed: current >= progress.required };
}

/**
 * One run-scoped AI objective. It deliberately has no Contract, reward, Level,
 * graph-version, or persistence fields; only the objective semantics are shared.
 */
export type AiObjective = {
  id: string;
  objective: AuthoredObjectiveDefinition;
  progress: ObjectiveProgress;
};

export function createAiObjective(id: string, objective: AuthoredObjectiveDefinition): AiObjective {
  if (!id.trim()) throw new Error("AI objective id is required.");
  return { id, objective: { ...objective }, progress: createObjectiveProgress(objective) };
}

export function advanceAiObjective(objective: AiObjective, event: ObjectiveDomainEvent): AiObjective {
  return {
    id: objective.id,
    objective: { ...objective.objective },
    progress: advanceObjective(objective.objective, objective.progress, event),
  };
}
