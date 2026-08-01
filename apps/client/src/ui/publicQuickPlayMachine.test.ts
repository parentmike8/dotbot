import { describe, expect, it } from "vitest";
import type { PlayerRole, PublicArenaMember } from "@dotbot/protocol";
import {
  initialPublicQuickPlayState,
  assemblySecondsRemaining,
  parsePublicQuickPlayResume,
  publicQuickPlayReducer,
  publicQuickPlayResume,
  publicQuickPlayStateFromResume,
  publicPartyStatusLabel,
  publicQueueTimedOut,
  selectDeploymentMode,
} from "./publicQuickPlayMachine";

const allocation = {
  mode: "public-hot-arena" as const,
  arenaId: "A2BC",
  playerSessionId: "psess-self-only",
  websocketUrl: "wss://compute.example/ws",
  queueTicket: "00000000-0000-4000-8000-000000000801",
  partySize: 2,
};

const members: PublicArenaMember[] = [
  { playerId: "P-AAAA-BBBB", name: "Leader", partyId: "party-visible-seam", queued: true },
  { playerId: "P-CCCC-DDDD", name: "Member", partyId: "party-visible-seam", queued: true },
];

const roles: PlayerRole[] = [
  { roleId: "alpha-0", squadId: "alpha", slot: 0, controller: "human", name: "Leader", playerId: "P-AAAA-BBBB" },
  { roleId: "alpha-1", squadId: "alpha", slot: 1, controller: "ai", name: "Rival 1" },
];

describe("public quick-play client state machine", () => {
  it("selects public mode only from the complete explicit default-off gate set", () => {
    expect(selectDeploymentMode({ matchmakerUrl: "https://matchmaker.example" })).toBe("legacy");
    expect(selectDeploymentMode({
      matchmakerUrl: "javascript:alert(1)",
      publicQuickPlayEnabled: true,
      atomicPartyAllocationEnabled: true,
      durablePartiesEnabled: true,
      quickPlayBuildId: "web-42",
      quickPlayRegions: ["ca-central-1"],
    })).toBe("legacy");
    expect(selectDeploymentMode({
      matchmakerUrl: "https://matchmaker.example",
      publicQuickPlayEnabled: true,
      atomicPartyAllocationEnabled: true,
      durablePartiesEnabled: true,
      quickPlayBuildId: "web-42",
      quickPlayRegions: ["ca-central-1"],
    })).toBe("public");
  });

  it("fences double deploy, cancel/start races, and stale reroute responses", () => {
    let state = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim", operationId: "op-1", intent: "initial", now: 100,
    });
    state = publicQuickPlayReducer(state, {
      type: "claim", operationId: "op-duplicate", intent: "initial", now: 101,
    });
    expect(state).toMatchObject({ phase: "claiming", operationId: "op-1" });

    state = publicQuickPlayReducer(state, { type: "allocated", operationId: "op-1", allocation });
    state = publicQuickPlayReducer(state, { type: "cancel", operationId: "op-1", returnToBase: true });
    state = publicQuickPlayReducer(state, { type: "matchStart", operationId: "op-1", matchId: "stale-match", roles });
    state = publicQuickPlayReducer(state, { type: "allocated", operationId: "op-stale", allocation });
    expect(state).toMatchObject({ phase: "cancelling", operationId: "op-1", returnToBase: true });
  });

  it("keeps assembly, reconnect, AI takeover, results, and one fresh redeploy explicit", () => {
    let state = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim", operationId: "op-1", intent: "initial", now: 100,
    });
    state = publicQuickPlayReducer(state, { type: "allocated", operationId: "op-1", allocation });
    state = publicQuickPlayReducer(state, {
      type: "arenaState", operationId: "op-1", arena: {
        phase: "assembling", members, retiring: false, assemblyStartedAt: 100, assemblyDeadlineAt: 6_100,
      },
    });
    expect(state).toMatchObject({ phase: "assembling", connection: "connected" });
    state = publicQuickPlayReducer(state, { type: "connection", operationId: "op-1", connection: "reconnecting" });
    state = publicQuickPlayReducer(state, { type: "matchStart", operationId: "op-1", matchId: "match-1", roles });
    state = publicQuickPlayReducer(state, {
      type: "roleController", operationId: "op-1", matchId: "match-1", roleId: "alpha-0", controller: "ai",
    });
    expect(state.roles?.find((role) => role.roleId === "alpha-0")?.controller).toBe("ai");
    state = publicQuickPlayReducer(state, { type: "results", operationId: "op-1" });
    expect(state.phase).toBe("results");
    state = publicQuickPlayReducer(state, { type: "claim", operationId: "op-2", intent: "redeploy", now: 10_000 });
    state = publicQuickPlayReducer(state, { type: "claim", operationId: "op-3", intent: "redeploy", now: 10_001 });
    expect(state).toMatchObject({ phase: "claiming", operationId: "op-2", intent: "redeploy" });
  });

  it("retries a failed allocated connection against the same fenced reservation", () => {
    let state = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim", operationId: "op-connection", intent: "initial", now: 100,
    });
    state = publicQuickPlayReducer(state, { type: "allocated", operationId: "op-connection", allocation });
    state = publicQuickPlayReducer(state, {
      type: "failed",
      operationId: "op-connection",
      message: "Connection interrupted.",
      retryable: true,
      connection: true,
    });
    state = publicQuickPlayReducer(state, { type: "reconnect", operationId: "op-connection" });
    expect(state).toMatchObject({
      phase: "connecting",
      operationId: "op-connection",
      allocation,
      connection: "connecting",
    });

    state = publicQuickPlayReducer(state, { type: "cancel", operationId: "op-connection", returnToBase: true });
    state = publicQuickPlayReducer(state, {
      type: "failed",
      operationId: "op-connection",
      message: "The run started before cancellation completed.",
      retryable: true,
      connection: true,
    });
    expect(state).toMatchObject({ phase: "error", connection: "failed", allocation });

    const responseLost = publicQuickPlayReducer({
      phase: "cancelling",
      operationId: "op-response-lost",
      intent: "initial",
      connection: "disconnected",
    }, {
      type: "reconnect",
      operationId: "op-response-lost",
      allocation,
    });
    expect(responseLost).toMatchObject({ phase: "connecting", allocation, connection: "connecting" });
  });

  it("round-trips only the per-member opaque refresh envelope and never a token or canonical identity", () => {
    const refreshOperationId = "00000000-0000-4000-8000-000000000901";
    const cancelOperationId = "00000000-0000-4000-8000-000000000902";
    let state = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim", operationId: refreshOperationId, intent: "initial", now: 100,
    });
    state = publicQuickPlayReducer(state, { type: "allocated", operationId: refreshOperationId, allocation });
    const resume = publicQuickPlayResume(state);
    const serialized = JSON.stringify(resume);
    expect(serialized).not.toContain("device-token");
    expect(serialized).not.toContain("canonicalPlayerId");
    expect(serialized).not.toContain("party-visible-seam");
    expect(parsePublicQuickPlayResume(JSON.parse(serialized))).toEqual(resume);
    expect(parsePublicQuickPlayResume({ ...resume, token: "leak" })).toBeNull();
    expect(publicQuickPlayStateFromResume(resume!)).toMatchObject({
      phase: "connecting",
      operationId: refreshOperationId,
      connection: "connecting",
      allocation,
    });

    let cancelling = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim", operationId: cancelOperationId, intent: "initial", now: 200,
    });
    cancelling = publicQuickPlayReducer(cancelling, {
      type: "cancel", operationId: cancelOperationId, returnToBase: true,
    });
    const cancelResume = publicQuickPlayResume(cancelling);
    expect(cancelResume).toEqual({
      version: 1,
      operationId: cancelOperationId,
      intent: "initial",
      action: "cancel",
      returnToBase: true,
    });
    expect(publicQuickPlayStateFromResume(cancelResume!)).toMatchObject({
      phase: "cancelling",
      operationId: cancelOperationId,
      connection: "disconnected",
      returnToBase: true,
    });
  });

  it("keeps the visible assembly countdown inside the one-to-six second contract", () => {
    expect(assemblySecondsRemaining(undefined, 1_000)).toBe(1);
    expect(assemblySecondsRemaining(9_000, 1_000)).toBe(6);
    expect(assemblySecondsRemaining(6_001, 1_000)).toBe(6);
    expect(assemblySecondsRemaining(3_001, 1_000)).toBe(3);
    expect(assemblySecondsRemaining(999, 1_000)).toBe(1);
  });

  it("fences a queue timeout for whole-party cancellation before another claim", () => {
    expect(publicQueueTimedOut(1_000, 120_999)).toBe(false);
    expect(publicQueueTimedOut(1_000, 121_000)).toBe(true);

    let state = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim", operationId: "op-timeout", intent: "initial", now: 1_000,
    });
    if (publicQueueTimedOut(state.startedAt!, 121_000)) {
      state = publicQuickPlayReducer(state, { type: "cancel", operationId: "op-timeout", returnToBase: true });
    }
    expect(state).toMatchObject({
      phase: "cancelling",
      operationId: "op-timeout",
      returnToBase: true,
    });
  });

  it("keeps party leader/member presentation explicit", () => {
    expect(publicPartyStatusLabel(1, null)).toBe("SOLO PARTY");
    expect(publicPartyStatusLabel(3, true)).toBe("PARTY 3/3 · LEADER");
    expect(publicPartyStatusLabel(2, false)).toBe("PARTY 2/3 · MEMBER");
  });
});
