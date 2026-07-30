export const BASE_TUTORIAL_PHASES = ["movement", "practice", "fabricator", "doorOpen", "complete"] as const;
export type BaseTutorialPhase = (typeof BASE_TUTORIAL_PHASES)[number];

export const BASE_TUTORIAL_ACTIONS = ["moved", "practiceHit", "usedFabricator", "enteredBase"] as const;
export type BaseTutorialAction = (typeof BASE_TUTORIAL_ACTIONS)[number];

export type BaseTutorialState = {
  phase: BaseTutorialPhase;
  revision: number;
};

export const initialBaseTutorialState: BaseTutorialState = { phase: "movement", revision: 0 };
export const completedBaseTutorialState: BaseTutorialState = { phase: "complete", revision: 4 };

export const BASE_TUTORIAL_TARGET_ID = "base-practice-bot";
export const BASE_TUTORIAL_DOOR_ID = "base-intro-door";
export const BASE_TUTORIAL_FABRICATOR_ID = "base-intro-fabricator";
export const BASE_TUTORIAL_FABRICATOR_DOT_ID = "interaction-object-base-intro-fabricator";
/** Crossing north of the workshop partition means the player entered the base. */
export const BASE_TUTORIAL_ENTRY_Y = 450;

const actionIndex: Readonly<Record<BaseTutorialAction, number>> = {
  moved: 0,
  practiceHit: 1,
  usedFabricator: 2,
  enteredBase: 3,
};

const phaseIndex: Readonly<Record<BaseTutorialPhase, number>> = {
  movement: 0,
  practice: 1,
  fabricator: 2,
  doorOpen: 3,
  complete: 4,
};

export function isBaseTutorialAction(value: unknown): value is BaseTutorialAction {
  return typeof value === "string" && (BASE_TUTORIAL_ACTIONS as readonly string[]).includes(value);
}

export function isBaseTutorialPhase(value: unknown): value is BaseTutorialPhase {
  return typeof value === "string" && (BASE_TUTORIAL_PHASES as readonly string[]).includes(value);
}

export function isBaseTutorialComplete(state: Pick<BaseTutorialState, "phase">): boolean {
  return state.phase === "complete";
}

/**
 * Ordered and retry-safe. A repeated action is an acknowledgement, not a
 * second mutation; a future action is a bypass attempt and is refused.
 */
export function advanceBaseTutorial(
  current: BaseTutorialState,
  action: BaseTutorialAction,
): { state: BaseTutorialState; changed: boolean } {
  const actionAt = actionIndex[action];
  const currentAt = phaseIndex[current.phase];
  if (actionAt < currentAt) return { state: current, changed: false };
  if (actionAt > currentAt) {
    throw new Error(`Tutorial action ${action} is out of order for ${current.phase}.`);
  }
  const phase = BASE_TUTORIAL_PHASES[currentAt + 1];
  if (!phase) return { state: current, changed: false };
  return {
    state: { phase, revision: current.revision + 1 },
    changed: true,
  };
}
