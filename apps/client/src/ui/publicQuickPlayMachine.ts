import type { PlayerRole, PublicArenaMember, RoomPhase } from "@dotbot/protocol";
import type { PublicPartyAllocation } from "./publicPartyQueue";

export type PublicQuickPlayConfig = {
  matchmakerUrl?: string | null;
  publicQuickPlayEnabled?: boolean;
  atomicPartyAllocationEnabled?: boolean;
  durablePartiesEnabled?: boolean;
  quickPlayBuildId?: string | null;
  quickPlayRegions?: string[];
};

export type PublicArenaState = {
  phase: Extract<RoomPhase, "assembling" | "countdown" | "live" | "results">;
  members: PublicArenaMember[];
  retiring: boolean;
  assemblyStartedAt?: number;
  assemblyDeadlineAt?: number;
};

export type PublicQuickPlayPhase =
  | "idle"
  | "claiming"
  | "connecting"
  | "assembling"
  | "live"
  | "results"
  | "cancelling"
  | "error";

export type PublicQuickPlayState = {
  phase: PublicQuickPlayPhase;
  operationId?: string;
  intent?: "initial" | "redeploy";
  startedAt?: number;
  allocation?: PublicPartyAllocation;
  arena?: PublicArenaState;
  matchId?: string;
  roles?: PlayerRole[];
  admitted?: boolean;
  connection: "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";
  error?: { message: string; retryable: boolean };
  returnToBase?: boolean;
};

export type PublicQuickPlayEvent =
  | { type: "claim"; operationId: string; intent: "initial" | "redeploy"; now: number }
  | { type: "allocated"; operationId: string; allocation: PublicPartyAllocation }
  | { type: "arenaState"; operationId: string; arena: PublicArenaState }
  | { type: "matchStart"; operationId: string; matchId?: string; roles?: PlayerRole[] }
  | { type: "roleController"; operationId: string; matchId: string; roleId: string; controller: "ai" }
  | { type: "results"; operationId: string }
  | { type: "connection"; operationId: string; connection: PublicQuickPlayState["connection"] }
  | { type: "cancel"; operationId: string; returnToBase: boolean }
  | { type: "cancelled"; operationId: string }
  | { type: "reconnect"; operationId: string; allocation?: PublicPartyAllocation }
  | { type: "failed"; operationId: string; message: string; retryable: boolean; connection?: boolean }
  | { type: "base" };

export const initialPublicQuickPlayState: PublicQuickPlayState = {
  phase: "idle",
  connection: "disconnected",
};

export function selectDeploymentMode(config: PublicQuickPlayConfig): "public" | "legacy" {
  return config.publicQuickPlayEnabled === true
    && config.atomicPartyAllocationEnabled === true
    && config.durablePartiesEnabled === true
    && isPublicMatchmakerUrl(config.matchmakerUrl)
    && typeof config.quickPlayBuildId === "string"
    && /^[A-Za-z0-9._-]{1,64}$/.test(config.quickPlayBuildId)
    && Array.isArray(config.quickPlayRegions)
    && config.quickPlayRegions.length > 0
    && config.quickPlayRegions.every((region) => typeof region === "string" && /^[a-z0-9-]{3,64}$/.test(region))
    ? "public"
    : "legacy";
}

export async function fetchDeploymentConfig(
  request: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<PublicQuickPlayConfig> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request("/api/game-config", { cache: "no-store", signal: controller.signal });
    if (!response.ok) return {};
    const value: unknown = await response.json();
    return isRecord(value) ? value as PublicQuickPlayConfig : {};
  } catch {
    return {};
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export function publicQueueTimedOut(startedAt: number, now = Date.now(), timeoutMs = 120_000): boolean {
  return now - startedAt >= timeoutMs;
}

/** Party/account details only decorate the queue UI. They must never delay the
 * authoritative claim/recovery path, especially during a control-plane read
 * outage or a refresh with an in-flight operation. */
export function startPublicQuickPlayOperations(
  loadPresentation: () => Promise<unknown>,
  enterQueue: () => Promise<void>,
): Promise<void> {
  void loadPresentation().catch(() => undefined);
  return enterQueue();
}

export function publicPartyStatusLabel(size: number, isLeader: boolean | null): string {
  const bounded = Math.max(1, Math.min(3, Math.floor(size)));
  return bounded === 1 ? "SOLO PARTY" : `PARTY ${bounded}/3 · ${isLeader ? "LEADER" : "MEMBER"}`;
}

export function shouldCancelBeforeBaseReturn(
  state: PublicQuickPlayState,
  playerSessionInUseElsewhere: boolean,
): boolean {
  return !playerSessionInUseElsewhere && state.phase === "error" && Boolean(state.allocation) && !state.matchId;
}

export function publicQuickPlayReducer(
  state: PublicQuickPlayState,
  event: PublicQuickPlayEvent,
): PublicQuickPlayState {
  if (event.type === "base") return initialPublicQuickPlayState;
  if (event.type === "claim") {
    if (state.phase !== "idle" && state.phase !== "results" && state.phase !== "error") return state;
    return {
      phase: "claiming",
      operationId: event.operationId,
      intent: event.intent,
      startedAt: event.now,
      connection: "disconnected",
    };
  }
  if (!state.operationId || event.operationId !== state.operationId) return state;
  switch (event.type) {
    case "allocated":
      if (state.phase !== "claiming") return state;
      return { ...state, phase: "connecting", allocation: event.allocation, connection: "connecting", error: undefined };
    case "arenaState": {
      if (state.phase === "cancelling" || state.phase === "error" || state.phase === "idle") return state;
      const phase = event.arena.phase === "results"
        ? "results"
        : event.arena.phase === "live"
          ? state.matchId ? "live" : "connecting"
          : "assembling";
      return { ...state, phase, arena: event.arena, admitted: true, connection: "connected", error: undefined };
    }
    case "matchStart":
      if (state.phase === "cancelling" || state.phase === "idle" || state.phase === "error") return state;
      return {
        ...state,
        phase: "live",
        admitted: true,
        connection: "connected",
        ...(event.matchId ? { matchId: event.matchId } : {}),
        roles: event.roles ? event.roles.map((role) => ({ ...role })) : state.roles,
        error: undefined,
      };
    case "roleController":
      if (state.matchId !== event.matchId || !state.roles) return state;
      return {
        ...state,
        roles: state.roles.map((role) => role.roleId === event.roleId ? { ...role, controller: event.controller } : role),
      };
    case "results":
      if (state.phase !== "live" && state.phase !== "connecting") return state;
      return { ...state, phase: "results", connection: "connected" };
    case "connection":
      if (state.phase === "idle") return state;
      return { ...state, connection: event.connection };
    case "cancel":
      if (state.phase !== "claiming" && state.phase !== "connecting" && state.phase !== "assembling"
        && !(state.phase === "error" && state.allocation && !state.matchId)) return state;
      return { ...state, phase: "cancelling", connection: "disconnected", returnToBase: event.returnToBase, error: undefined };
    case "cancelled":
      return state.phase === "cancelling" ? initialPublicQuickPlayState : state;
    case "reconnect":
      if (state.phase !== "error" && state.phase !== "cancelling") return state;
      if (!state.allocation && !event.allocation) return state;
      return {
        ...state,
        phase: "connecting",
        allocation: event.allocation ? { ...event.allocation } : state.allocation,
        connection: "connecting",
        error: undefined,
        returnToBase: undefined,
      };
    case "failed":
      if (state.phase === "cancelling" && event.retryable && !event.connection) {
        return { ...state, error: { message: event.message, retryable: true } };
      }
      return {
        ...state,
        phase: "error",
        connection: event.connection ? "failed" : state.connection,
        error: { message: event.message, retryable: event.retryable },
      };
    default:
      return state;
  }
}

type PublicQuickPlayResumeBase = {
  version: 1;
  operationId: string;
  intent: "initial" | "redeploy";
};

export type PublicQuickPlayResume = PublicQuickPlayResumeBase & (
  | { action: "claim"; returnToBase: false; startedAt: number }
  | { action: "connect"; returnToBase: false; allocation: PublicPartyAllocation; admitted?: true }
  | { action: "cancel"; returnToBase: boolean }
);

export function publicQuickPlayStateFromResume(resume: PublicQuickPlayResume): PublicQuickPlayState {
  if (resume.action === "claim") {
    return {
      phase: "claiming",
      operationId: resume.operationId,
      intent: resume.intent,
      startedAt: resume.startedAt,
      connection: "disconnected",
    };
  }
  if (resume.action === "cancel") {
    return {
      phase: "cancelling",
      operationId: resume.operationId,
      intent: resume.intent,
      connection: "disconnected",
      returnToBase: resume.returnToBase,
    };
  }
  return {
    phase: "connecting",
    operationId: resume.operationId,
    intent: resume.intent,
    allocation: { ...resume.allocation },
    ...(resume.admitted ? { admitted: true } : {}),
    connection: "connecting",
  };
}

export function assemblySecondsRemaining(deadlineAt: number | undefined, now = Date.now()): number {
  if (deadlineAt === undefined) return 1;
  return Math.max(1, Math.min(6, Math.ceil((deadlineAt - now) / 1_000)));
}

export function publicQuickPlayResume(state: PublicQuickPlayState): PublicQuickPlayResume | null {
  if (!state.operationId || !state.intent) return null;
  if (state.phase === "claiming" && Number.isSafeInteger(state.startedAt) && state.startedAt! >= 0) {
    return {
      version: 1,
      operationId: state.operationId,
      intent: state.intent,
      action: "claim",
      returnToBase: false,
      startedAt: state.startedAt!,
    };
  }
  if (state.phase === "cancelling") {
    return {
      version: 1,
      operationId: state.operationId,
      intent: state.intent,
      action: "cancel",
      returnToBase: state.returnToBase === true,
    };
  }
  if (!state.allocation) return null;
  return {
    version: 1,
    operationId: state.operationId,
    intent: state.intent,
    action: "connect",
    returnToBase: false,
    allocation: { ...state.allocation },
    ...(state.admitted ? { admitted: true } : {}),
  };
}

export function parsePublicQuickPlayResume(value: unknown): PublicQuickPlayResume | null {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, ["version", "operationId", "intent", "action", "returnToBase", "allocation", "startedAt", "admitted"])
    || Object.keys(value).length < 5) return null;
  if (value.version !== 1 || typeof value.operationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId)
    || (value.intent !== "initial" && value.intent !== "redeploy")
    || (value.action !== "claim" && value.action !== "connect" && value.action !== "cancel")
    || typeof value.returnToBase !== "boolean"
    || (value.action === "claim" && (value.returnToBase !== false || value.allocation !== undefined
      || value.admitted !== undefined || !Number.isSafeInteger(value.startedAt)
      || (value.startedAt as number) < 0 || Object.keys(value).length !== 6))
    || (value.action !== "claim" && value.startedAt !== undefined)
    || (value.admitted !== undefined && (value.action !== "connect" || value.admitted !== true))
    || (value.action === "connect" && value.returnToBase !== false)
    || (value.action === "connect" && !isResumeAllocation(value.allocation, value.admitted === true))
    || (value.action === "cancel" && value.allocation !== undefined && !isResumeAllocation(value.allocation, true))) return null;
  if (value.action === "claim") {
    return {
      version: 1,
      operationId: value.operationId,
      intent: value.intent,
      action: "claim",
      returnToBase: false,
      startedAt: value.startedAt as number,
    };
  }
  if (value.action === "connect") {
    return {
      version: 1,
      operationId: value.operationId,
      intent: value.intent,
      action: "connect",
      returnToBase: false,
      allocation: { ...value.allocation as PublicPartyAllocation },
      ...(value.admitted === true ? { admitted: true } : {}),
    };
  }
  return {
    version: 1,
    operationId: value.operationId,
    intent: value.intent,
    action: "cancel",
    returnToBase: value.returnToBase,
  };
}

function isResumeAllocation(value: unknown, admitted = false): value is PublicPartyAllocation {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, ["mode", "arenaId", "playerSessionId", "websocketUrl", "expiresAt", "queueTicket", "partySize"])) return false;
  if (value.mode !== "public-hot-arena" || typeof value.arenaId !== "string" || !/^[A-HJ-NP-Z2-9]{4}$/.test(value.arenaId)
    || typeof value.playerSessionId !== "string" || value.playerSessionId.length < 1 || value.playerSessionId.length > 2048
    || typeof value.websocketUrl !== "string" || typeof value.queueTicket !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.queueTicket)
    || !Number.isInteger(value.partySize) || (value.partySize as number) < 1 || (value.partySize as number) > 3
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || (!admitted && Date.parse(value.expiresAt) <= Date.now())) return false;
  try {
    const url = new URL(value.websocketUrl);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "wss:" || (url.protocol === "ws:" && isLoopback(url.hostname)));
  } catch {
    return false;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function isPublicMatchmakerUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
