import { describe, expect, it, vi } from "vitest";
import type { PlayerRole, PublicArenaMember } from "@dotbot/protocol";
import {
  assemblyProgressPercent,
  initialPublicQuickPlayState,
  assemblySecondsRemaining,
  fetchDeploymentConfig,
  parsePublicQuickPlayResume,
  publicQuickPlayCancellationTicket,
  publicQuickPlayReducer,
  publicQuickPlayResume,
  publicQuickPlayStateFromResume,
  publicPartyStatusLabel,
  publicQueueSecondsElapsed,
  publicQueueTimedOut,
  selectDeploymentMode,
  shouldCancelBeforeBaseReturn,
  startPublicQuickPlayOperations,
} from "./publicQuickPlayMachine";

const allocation = {
  mode: "public-hot-arena" as const,
  arenaId: "A2BC",
  playerSessionId: "psess-self-only",
  websocketUrl: "wss://compute.example/ws",
  expiresAt: "2099-01-01T00:00:00.000Z",
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
  it("falls back to legacy deployment when the config read hangs or is malformed", async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")));
      }));
      const pending = fetchDeploymentConfig(hangingFetch, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({});
      expect(hangingFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);

      const malformedFetch = vi.fn<typeof fetch>(async () => new Response("null", { status: 200 }));
      await expect(fetchDeploymentConfig(malformedFetch, 100)).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the authoritative queue path without waiting for presentation reads", async () => {
    let releasePresentation!: () => void;
    const presentation = vi.fn(() => new Promise<void>((resolve) => { releasePresentation = resolve; }));
    const queue = vi.fn(async () => undefined);

    const started = startPublicQuickPlayOperations(presentation, queue);

    expect(presentation).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledOnce();
    await started;
    releasePresentation();
  });

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
      matchmakerUrl: "https://operator:secret@matchmaker.example/public?token=secret#fragment",
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
      type: "allocated", operationId: cancelOperationId, allocation,
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
      queueTicket: allocation.queueTicket,
    });
    expect(JSON.stringify(cancelResume)).not.toContain(allocation.playerSessionId);
    expect(JSON.stringify(cancelResume)).not.toContain(allocation.websocketUrl);
    const resumedCancellation = publicQuickPlayStateFromResume(cancelResume!);
    expect(resumedCancellation).toMatchObject({
      phase: "cancelling",
      operationId: cancelOperationId,
      connection: "disconnected",
      returnToBase: true,
      cancellationQueueTicket: allocation.queueTicket,
    });
    expect(publicQuickPlayCancellationTicket(resumedCancellation)).toBe(allocation.queueTicket);
    expect(publicQuickPlayCancellationTicket(resumedCancellation)).not.toBe(cancelOperationId);
  });

  it("rejects an expired allocation from refresh storage", () => {
    const expiredResume = {
      version: 1,
      operationId: "00000000-0000-4000-8000-000000000905",
      intent: "initial",
      action: "connect",
      returnToBase: false,
      allocation: {
        ...allocation,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    } as const;
    expect(parsePublicQuickPlayResume(expiredResume)).toBeNull();
    const admitted = parsePublicQuickPlayResume({ ...expiredResume, admitted: true });
    expect(admitted).toMatchObject({ action: "connect", admitted: true });
    expect(publicQuickPlayStateFromResume(admitted!)).toMatchObject({
      phase: "connecting",
      admitted: true,
      allocation: expiredResume.allocation,
    });

    const staleCancellation = parsePublicQuickPlayResume({
      ...expiredResume,
      action: "cancel",
      returnToBase: true,
    });
    expect(staleCancellation).toEqual({
      version: 1,
      operationId: expiredResume.operationId,
      intent: "initial",
      action: "cancel",
      returnToBase: true,
      queueTicket: allocation.queueTicket,
    });
  });

  it("retains the exact in-flight claim operation across refresh before allocation", () => {
    const operationId = "00000000-0000-4000-8000-000000000903";
    const claiming = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim",
      operationId,
      intent: "initial",
      now: 12_345,
    });

    const resume = publicQuickPlayResume(claiming);
    expect(resume).toEqual({
      version: 1,
      operationId,
      intent: "initial",
      action: "claim",
      returnToBase: false,
      startedAt: 12_345,
    });
    expect(parsePublicQuickPlayResume(JSON.parse(JSON.stringify(resume)))).toEqual(resume);
    expect(publicQuickPlayStateFromResume(resume!)).toMatchObject({
      phase: "claiming",
      operationId,
      intent: "initial",
      startedAt: 12_345,
      connection: "disconnected",
    });
  });

  it("moves a failed pre-run reservation into fenced cancellation before base return", () => {
    const operationId = "00000000-0000-4000-8000-000000000904";
    let state = publicQuickPlayReducer(initialPublicQuickPlayState, {
      type: "claim",
      operationId,
      intent: "initial",
      now: 100,
    });
    state = publicQuickPlayReducer(state, { type: "allocated", operationId, allocation });
    state = publicQuickPlayReducer(state, {
      type: "failed",
      operationId,
      message: "Connection interrupted.",
      retryable: true,
      connection: true,
    });
    state = publicQuickPlayReducer(state, { type: "cancel", operationId, returnToBase: true });

    expect(state).toMatchObject({
      phase: "cancelling",
      operationId,
      allocation,
      returnToBase: true,
    });
  });

  it("does not cancel a shared claim when this tab lost the player-session race", () => {
    const failed = {
      phase: "error" as const,
      operationId: "00000000-0000-4000-8000-000000000906",
      intent: "redeploy" as const,
      allocation,
      connection: "failed" as const,
      error: { message: "already connected", retryable: false },
    };
    expect(shouldCancelBeforeBaseReturn(failed, true)).toBe(false);
    expect(shouldCancelBeforeBaseReturn(failed, false)).toBe(true);
  });

  it("keeps the visible assembly countdown inside the one-to-six second contract", () => {
    expect(assemblySecondsRemaining(undefined, 1_000)).toBe(1);
    expect(assemblySecondsRemaining(9_000, 1_000)).toBe(6);
    expect(assemblySecondsRemaining(6_001, 1_000)).toBe(6);
    expect(assemblySecondsRemaining(3_001, 1_000)).toBe(3);
    expect(assemblySecondsRemaining(999, 1_000)).toBe(1);
  });

  it("reports honest queue elapsed time without displaying negative time", () => {
    expect(publicQueueSecondsElapsed(undefined, 5_000)).toBe(0);
    expect(publicQueueSecondsElapsed(5_000, 4_000)).toBe(0);
    expect(publicQueueSecondsElapsed(1_000, 1_999)).toBe(0);
    expect(publicQueueSecondsElapsed(1_000, 2_000)).toBe(1);
    expect(publicQueueSecondsElapsed(1_000, 63_400)).toBe(62);
  });

  it("bounds the assembly loading bar from zero through one hundred percent", () => {
    expect(assemblyProgressPercent(undefined, 7_000, 1_000)).toBe(0);
    expect(assemblyProgressPercent(1_000, 1_000, 1_000)).toBe(0);
    expect(assemblyProgressPercent(1_000, 7_000, 0)).toBe(0);
    expect(assemblyProgressPercent(1_000, 7_000, 4_000)).toBe(50);
    expect(assemblyProgressPercent(1_000, 7_000, 8_000)).toBe(100);
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
