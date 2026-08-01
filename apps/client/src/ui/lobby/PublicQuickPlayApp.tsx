import { useEffect, useReducer, useRef, useState } from "react";
import type { PublicArenaMember } from "@dotbot/protocol";
import { NetSession } from "../../game/session/NetSession";
import { NetGameView } from "./NetGameView";
import {
  cancelPublicPartyAllocation,
  getPublicPartyAllocationStatus,
  PublicPartyQueueError,
  requestPublicPartyAllocation,
  shouldRetryPublicPartyClaim,
  type PublicPartyAllocation,
  type PublicPartyAllocationStatus,
} from "../publicPartyQueue";
import {
  assemblyProgressPercent,
  assemblySecondsRemaining,
  initialPublicQuickPlayState,
  parsePublicQuickPlayResume,
  publicQuickPlayCancellationTicket,
  publicQuickPlayReducer,
  publicQuickPlayResume,
  publicQuickPlayStateFromResume,
  publicPartyStatusLabel,
  publicQueueSecondsElapsed,
  publicQueueTimedOut,
  shouldCancelBeforeBaseReturn,
  startPublicQuickPlayOperations,
  type PublicQuickPlayConfig,
  type PublicQuickPlayEvent,
  type PublicQuickPlayState,
} from "../publicQuickPlayMachine";
import {
  deviceTokenKey,
  ensureAccountToken,
  fetchAccountState,
  fetchPartyState,
  playerNameKey,
  type PartyState,
} from "../identity";
import "./lobby.css";

type PublicQuickPlayAppProps = {
  config: PublicQuickPlayConfig;
  embedded?: boolean;
  onReturnToBase?: () => void;
};

const resumeKey = "dotbot.publicQuickPlay.resume.v1";
const queueTimeoutMs = 120_000;

export function PublicQuickPlayApp({ config, embedded = false, onReturnToBase }: PublicQuickPlayAppProps) {
  const [state, reactDispatch] = useReducer(publicQuickPlayReducer, undefined, initialState);
  const stateRef = useRef(state);
  const [session, setSession] = useState<NetSession | null>(null);
  const sessionRef = useRef<NetSession | null>(null);
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState("");
  const [waitingForCapacity, setWaitingForCapacity] = useState(false);
  const [party, setParty] = useState<PartyState | null>(null);
  const [isPartyLeader, setIsPartyLeader] = useState<boolean | null>(null);
  const partyLeaderRef = useRef<boolean | null>(null);
  const [clock, setClock] = useState(Date.now());
  const cancellationRequests = useRef(new Set<string>());
  const playerSessionInUseElsewhere = useRef(new Set<string>());
  const authoritativeConnectionFailures = useRef(new Map<string, string>());
  const disposed = useRef(false);
  const name = (localStorage.getItem(playerNameKey) ?? "Player").trim() || "Player";
  const matchmakerUrl = config.matchmakerUrl!;
  const buildId = config.quickPlayBuildId!;
  const regions = config.quickPlayRegions!;

  const dispatch = (event: PublicQuickPlayEvent): void => {
    stateRef.current = publicQuickPlayReducer(stateRef.current, event);
    writeResume(publicQuickPlayResume(stateRef.current));
    reactDispatch(event);
  };

  useEffect(() => {
    stateRef.current = state;
    writeResume(publicQuickPlayResume(state));
  }, [state]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void startPublicQuickPlayOperations(
      async () => {
        try {
          const [nextParty, account] = await Promise.all([fetchPartyState(), fetchAccountState()]);
          if (disposed.current) return;
          setParty(nextParty);
          const ownId = account.publicPlayerId?.replace(/-/g, "");
          const own = nextParty?.members.find((member) => member.publicPlayerId.replace(/-/g, "") === ownId);
          const leader = own?.leader ?? (nextParty ? false : null);
          partyLeaderRef.current = leader;
          setIsPartyLeader(leader);
        } catch {
          // Party detail is presentation-only. The atomic claim remains the
          // authority and still determines the whole roster.
        }
      },
      async () => {
        const resumed = stateRef.current.allocation;
        if (stateRef.current.phase === "cancelling") await cancel(stateRef.current.returnToBase === true);
        else if (resumed && stateRef.current.operationId) await connect(stateRef.current.operationId, resumed);
        else if (stateRef.current.phase === "claiming" && stateRef.current.operationId && stateRef.current.intent
          && stateRef.current.startedAt !== undefined) {
          await claim(stateRef.current.intent, {
            operationId: stateRef.current.operationId,
            startedAt: stateRef.current.startedAt,
          });
        } else await claim("initial");
      },
    );
    return () => {
      disposed.current = true;
      sessionRef.current?.dispose();
    };
  }, []);

  async function claim(
    intent: "initial" | "redeploy",
    resumed?: { operationId: string; startedAt: number },
  ): Promise<void> {
    if (resumed) {
      if (stateRef.current.phase !== "claiming" || stateRef.current.operationId !== resumed.operationId) return;
    } else if (stateRef.current.phase !== "idle" && stateRef.current.phase !== "results" && stateRef.current.phase !== "error") return;
    const operationId = resumed?.operationId ?? crypto.randomUUID();
    if (!resumed) dispatch({ type: "claim", operationId, intent, now: Date.now() });
    setWaitingForCapacity(false);
    setMessage(partyLeaderRef.current === false ? "WAITING FOR PARTY LEADER" : "LOCKING PARTY LOADOUT");
    let token: string;
    try {
      token = await ensureAccountToken(name);
    } catch (error) {
      dispatch({ type: "failed", operationId, message: queueErrorMessage(error), retryable: true, connection: true });
      return;
    }
    const startedAt = resumed?.startedAt ?? Date.now();
    const latencies = Object.fromEntries(regions.map((region) => [region, 0]));

    while (!disposed.current && !publicQueueTimedOut(startedAt, Date.now(), queueTimeoutMs)) {
      try {
        const result = await requestPublicPartyAllocation({
          matchmakerUrl,
          token,
          buildId,
          latencies,
          queueRequestId: operationId,
          signal: AbortSignal.timeout(10_000),
        });
        if (cancellationRequests.current.has(operationId)) {
          await finishCancellation(operationId, result.allocation.queueTicket, token);
          return;
        }
        if (stateRef.current.operationId !== operationId) {
          await cancelPublicPartyAllocation({
            matchmakerUrl,
            token,
            queueTicket: result.allocation.queueTicket,
            signal: AbortSignal.timeout(5_000),
          }).catch(() => undefined);
          return;
        }
        dispatch({ type: "allocated", operationId, allocation: result.allocation });
        setWaitingForCapacity(false);
        setMessage("CONNECTING TO PUBLIC ASSEMBLY");
        await connect(operationId, result.allocation, token);
        return;
      } catch (error) {
        if (disposed.current || stateRef.current.operationId !== operationId) return;
        let recovered: PublicPartyAllocation | null;
        try {
          recovered = await recoverAllocation(operationId, token);
        } catch (statusError) {
          dispatch({ type: "failed", operationId, message: queueErrorMessage(statusError), retryable: false });
          return;
        }
        if (stateRef.current.operationId !== operationId) return;
        if (recovered) {
          if (cancellationRequests.current.has(operationId)) {
            await finishCancellation(operationId, recovered.queueTicket, token);
            return;
          }
          dispatch({ type: "allocated", operationId, allocation: recovered });
          setWaitingForCapacity(false);
          await connect(operationId, recovered, token);
          return;
        }
        if (cancellationRequests.current.has(operationId)
          && error instanceof PublicPartyQueueError && !error.retryable && error.status < 500) {
          finishLocalCancellation(operationId);
          return;
        }
        const mayRetry = shouldRetryPublicPartyClaim(error);
        if (!mayRetry) {
          dispatch({ type: "failed", operationId, message: queueErrorMessage(error), retryable: false });
          return;
        }
        const fleetWaking = error instanceof PublicPartyQueueError
          && error.status === 503
          && error.message.toLowerCase().includes("waking");
        setWaitingForCapacity(fleetWaking);
        setMessage(partyLeaderRef.current === false
          ? "WAITING FOR PARTY LEADER · PARTY STAYS INTACT"
          : fleetWaking
            ? "SERVER WAKING · DEPLOYMENT WILL CONTINUE AUTOMATICALLY"
            : "FINDING PUBLIC ARENA · RETRYING");
        await delay(error instanceof PublicPartyQueueError && error.status === 503 ? 3_000 : 750);
      }
    }
    if (!disposed.current && stateRef.current.operationId === operationId) {
      cancellationRequests.current.add(operationId);
      dispatch({ type: "cancel", operationId, returnToBase: true });
      setMessage("PUBLIC ASSEMBLY TIMED OUT · RELEASING PARTY CLAIM");
      await finishCancellation(
        operationId,
        publicQuickPlayCancellationTicket(stateRef.current) ?? operationId,
        token,
      );
    }
  }

  async function recoverAllocation(operationId: string, token: string): Promise<PublicPartyAllocation | null> {
    let status: PublicPartyAllocationStatus;
    try {
      status = await getPublicPartyAllocationStatus({
        matchmakerUrl,
        token,
        queueTicket: operationId,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // A response-lost create is recovered by status when present. Otherwise
      // the same idempotency key is retried through the ordinary claim loop.
      return null;
    }
    if (status.status === "active" || (status.status === "completed" && status.allocation)) {
      return status.allocation ?? null;
    }
    if (status.status === "expired") {
      cancellationRequests.current.add(operationId);
      dispatch({ type: "cancel", operationId, returnToBase: true });
      setMessage("PUBLIC ASSEMBLY EXPIRED · RELEASING PARTY CLAIM");
      await finishCancellation(operationId, status.queueTicket, token);
      return null;
    }
    if (status.status === "cancelled" || status.status === "completed") {
      throw new PublicPartyQueueError("That queue claim is no longer active.", 409, false);
    }
    if (stateRef.current.operationId === operationId) {
      setMessage(status.status === "cancelling" ? "CANCELLATION IS RECONCILING" : "PARTY ALLOCATION IS RECONCILING");
    }
    return null;
  }

  async function connect(operationId: string, allocation: PublicPartyAllocation, knownToken?: string): Promise<void> {
    if (disposed.current || stateRef.current.operationId !== operationId) return;
    let token: string;
    try {
      token = knownToken ?? localStorage.getItem(deviceTokenKey) ?? await ensureAccountToken(name);
    } catch (error) {
      dispatch({ type: "failed", operationId, message: queueErrorMessage(error), retryable: true, connection: true });
      return;
    }
    sessionRef.current?.dispose();
    const next = new NetSession({
      url: allocation.websocketUrl,
      roomCode: allocation.arenaId,
      name,
      token,
      mode: "public",
      playerSessionId: allocation.playerSessionId,
      onArenaState: (arena) => {
        if (stateRef.current.operationId !== operationId) return;
        dispatch({ type: "arenaState", operationId, arena });
        setMessage(arena.phase === "results" ? "RUN COMPLETE · CHOOSE THE NEXT ACTION" : "");
      },
      onMatchStart: ({ matchId, roles }) => {
        if (stateRef.current.operationId !== operationId) return;
        dispatch({ type: "matchStart", operationId, matchId, roles });
        setMessage("");
      },
      onRoleController: ({ matchId, roleId, controller }) => {
        dispatch({ type: "roleController", operationId, matchId, roleId, controller });
      },
      onRunOver: () => dispatch({ type: "results", operationId }),
      onConnectionChange: (connection) => {
        if (stateRef.current.operationId !== operationId) return;
        if (connection === "connected") {
          playerSessionInUseElsewhere.current.delete(operationId);
          authoritativeConnectionFailures.current.delete(operationId);
        }
        dispatch({ type: "connection", operationId, connection });
        if (connection === "reconnecting") setMessage("CONNECTION INTERRUPTED · RECONNECTING TO YOUR ROLE");
        if (connection === "connected") setMessage("");
        if (connection === "failed") setMessage("RECONNECT WINDOW CLOSED · YOUR ROLE IS NOW AI");
      },
      onServerError: ({ code, msg }) => {
        if (stateRef.current.operationId !== operationId) return;
        if (code === "player_session_in_use") {
          playerSessionInUseElsewhere.current.add(operationId);
          setMessage("THIS RESERVED ROLE IS ACTIVE IN ANOTHER TAB · WAITING FOR HANDOFF");
          return;
        }
        // A signed reservation that reached an authoritative server rejection
        // must not be retried as though the network merely dropped. In
        // particular, party_invalid after the handoff grace means AI owns the
        // role for the rest of this run.
        authoritativeConnectionFailures.current.set(operationId, msg);
      },
      onError: (value) => {
        if (value && stateRef.current.operationId === operationId) setMessage(value.toUpperCase());
      },
    });
    sessionRef.current = next;
    setSession(next);
    setPlaying(false);
    try {
      await next.start();
      if (!disposed.current && stateRef.current.operationId === operationId) setPlaying(true);
    } catch (error) {
      if (stateRef.current.operationId === operationId && stateRef.current.phase !== "cancelling") {
        const inUseElsewhere = playerSessionInUseElsewhere.current.has(operationId);
        const authoritativeFailure = authoritativeConnectionFailures.current.get(operationId);
        dispatch({
          type: "failed",
          operationId,
          message: authoritativeFailure ?? (inUseElsewhere
            ? "This reserved role is active in another tab. Continue there or return to base here."
            : queueErrorMessage(error)),
          retryable: !inUseElsewhere && !authoritativeFailure,
          connection: true,
        });
      }
    }
  }

  async function cancel(returnToBase: boolean): Promise<void> {
    const current = stateRef.current;
    if (!current.operationId) {
      leaveBase();
      return;
    }
    if (playerSessionInUseElsewhere.current.has(current.operationId)) {
      leaveBaseLocally();
      return;
    }
    if (current.phase !== "claiming" && current.phase !== "connecting" && current.phase !== "assembling"
      && current.phase !== "cancelling" && !(current.phase === "error" && current.allocation && !current.matchId)) {
      leaveBase();
      return;
    }
    cancellationRequests.current.add(current.operationId);
    if (current.phase !== "cancelling") dispatch({ type: "cancel", operationId: current.operationId, returnToBase });
    setMessage("CANCELLING WHOLE PARTY RESERVATION");
    sessionRef.current?.dispose();
    let token: string;
    try {
      token = localStorage.getItem(deviceTokenKey) ?? await ensureAccountToken(name);
    } catch (error) {
      dispatch({ type: "failed", operationId: current.operationId, message: queueErrorMessage(error), retryable: true });
      return;
    }
    await finishCancellation(
      current.operationId,
      publicQuickPlayCancellationTicket(current) ?? current.operationId,
      token,
    );
  }

  async function finishCancellation(operationId: string, queueTicket: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < 5 && !disposed.current; attempt += 1) {
      try {
        await cancelPublicPartyAllocation({
          matchmakerUrl,
          token,
          queueTicket,
          signal: AbortSignal.timeout(5_000),
        });
        finishLocalCancellation(operationId);
        return;
      } catch (error) {
        try {
          const status = await getPublicPartyAllocationStatus({
            matchmakerUrl,
            token,
            queueTicket,
            signal: AbortSignal.timeout(5_000),
          });
          if (status.status === "cancelled" || status.status === "expired") {
            finishLocalCancellation(operationId);
            return;
          }
          if (status.status === "completed") {
            if (authoritativeConnectionFailures.current.has(operationId)) {
              // The run won the cancel/start race, but this exact role has
              // already been rejected (for example after run-long AI
              // takeover). Reconnecting would loop forever; only this stale
              // tab exits, while the authoritative run continues untouched.
              leaveBaseLocally();
              return;
            }
            const reconnectAllocation = stateRef.current.allocation ?? status.allocation;
            if (reconnectAllocation) {
              dispatch({ type: "reconnect", operationId, allocation: reconnectAllocation });
              setMessage("THE RUN STARTED · RECONNECTING TO YOUR RESERVED ROLE");
              await connect(operationId, reconnectAllocation, token);
              return;
            }
            dispatch({
              type: "failed",
              operationId,
              message: "The run started before cancellation completed. Return to base; your role will hand off to AI.",
              retryable: false,
              connection: true,
            });
            return;
          }
        } catch {
          // Retry the idempotent cancellation below; uncertain cleanup never
          // unlocks the UI or pretends the whole-party reservation is gone.
        }
        if (stateRef.current.operationId === operationId) setMessage("CANCELLATION IS RECONCILING · RETRYING");
        if (attempt < 4) await delay(500 * 2 ** attempt);
        else dispatch({ type: "failed", operationId, message: queueErrorMessage(error), retryable: true });
      }
    }
  }

  function finishLocalCancellation(operationId: string): void {
    if (stateRef.current.operationId !== operationId) return;
    const returnToBase = stateRef.current.returnToBase === true;
    clearOperationRefs(operationId);
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    setPlaying(false);
    setMessage("");
    clearResume();
    dispatch({ type: "cancelled", operationId });
    if (returnToBase) leaveBase();
  }

  function leaveBase(): void {
    clearOperationRefs(stateRef.current.operationId);
    clearResume();
    sessionRef.current?.leaveRun();
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    setPlaying(false);
    setMessage("");
    dispatch({ type: "base" });
    onReturnToBase?.();
  }

  function leaveBaseLocally(): void {
    clearOperationRefs(stateRef.current.operationId);
    clearResume();
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    setPlaying(false);
    setMessage("");
    dispatch({ type: "base" });
    onReturnToBase?.();
  }

  function clearOperationRefs(operationId: string | undefined): void {
    if (!operationId) return;
    cancellationRequests.current.delete(operationId);
    playerSessionInUseElsewhere.current.delete(operationId);
    authoritativeConnectionFailures.current.delete(operationId);
  }

  function returnToBaseSafely(): void {
    const current = stateRef.current;
    const inUseElsewhere = Boolean(current.operationId && playerSessionInUseElsewhere.current.has(current.operationId));
    if (shouldCancelBeforeBaseReturn(current, inUseElsewhere)) {
      void cancel(true);
      return;
    }
    if (inUseElsewhere) leaveBaseLocally();
    else leaveBase();
  }

  function deployAgain(): void {
    if (stateRef.current.phase !== "results") return;
    clearResume();
    sessionRef.current?.leaveRun();
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    setPlaying(false);
    setMessage("CREATING A FRESH PARTY CLAIM");
    void claim("redeploy");
  }

  function retry(): void {
    const current = stateRef.current;
    if (current.phase === "cancelling") {
      void cancel(current.returnToBase === true);
      return;
    }
    if (current.phase === "error" && current.connection === "failed" && current.operationId && current.allocation) {
      dispatch({ type: "reconnect", operationId: current.operationId });
      setMessage("RECONNECTING TO YOUR RESERVED ROLE");
      void connect(current.operationId, current.allocation);
      return;
    }
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    setPlaying(false);
    clearResume();
    void claim(current.intent ?? "initial");
  }

  if (playing && session) {
    const aiRoleCount = state.roles?.filter((role) => role.controller === "ai").length ?? 0;
    return (
      <NetGameView
        session={session}
        roomCode={state.allocation?.arenaId ?? session.playerId}
        roomLabel={`PUBLIC ARENA · AI ROLES ${aiRoleCount}`}
        hideRoomCode
        connectionMessage={state.connection === "reconnecting" || state.connection === "failed" ? message : ""}
        connectionActionLabel="RETURN TO BASE"
        onConnectionAction={leaveBase}
        returnLabel="DEPLOY AGAIN"
        onReturnToLobby={deployAgain}
        secondaryActionLabel="SET LOADOUT / RETURN TO BASE"
        onSecondaryAction={leaveBase}
      />
    );
  }

  const assemblyMembers = state.arena?.members ?? [];
  const countdown = assemblySecondsRemaining(state.arena?.assemblyDeadlineAt, clock);
  const cancellable = state.phase === "claiming" || state.phase === "connecting" || state.phase === "assembling";
  const heading = state.phase === "assembling" ? `${countdown}`
    : state.phase === "cancelling" ? "Hold."
      : state.phase === "error" ? "Retry."
        : "Deploy.";

  return (
    <main className={embedded ? "deployment-shell" : "lobby-shell"}>
      <section className="lobby-card public-queue-card" aria-label="Public quick-play deployment">
        {embedded ? <button type="button" className="deployment-close" aria-label="Close deployment" onClick={() => void cancel(true)}>×</button> : null}
        <header>
          <span className="lobby-kicker">Public deployment</span>
          <h1>{heading}</h1>
          <p>{state.phase === "assembling"
            ? "Assembly starts automatically. Open roles deploy as labelled AI."
            : "Your current party and loadout are claimed together."}</p>
        </header>

        <PartyStatus party={party} isLeader={isPartyLeader} allocationSize={state.allocation?.partySize} />
        {state.phase === "assembling" ? <AssemblyRoster members={assemblyMembers} /> : null}

        <DeploymentProgress state={state} clock={clock} waitingForCapacity={waitingForCapacity} />

        <p className={state.error ? "lobby-error public-queue-status" : "public-queue-status"} role={state.error ? "alert" : "status"} aria-live="polite">
          {state.error?.message.toUpperCase() || message || phaseMessage(state)}
        </p>

        <div className="public-queue-actions">
          {cancellable ? <button type="button" onClick={() => void cancel(true)}>CANCEL DEPLOYMENT</button> : null}
          {state.phase === "cancelling" && state.error?.retryable ? <button type="button" onClick={retry}>RETRY CANCELLATION</button> : null}
          {state.phase === "error" && state.error?.retryable ? (
            <button type="button" className="lobby-primary" onClick={retry}>
              {state.connection === "failed" && state.allocation ? "RECONNECT TO RUN" : "RETRY DEPLOYMENT"}
            </button>
          ) : null}
          {state.phase === "error" ? <button type="button" onClick={returnToBaseSafely}>SET LOADOUT / RETURN TO BASE</button> : null}
        </div>
      </section>
    </main>
  );
}

function DeploymentProgress({
  state,
  clock,
  waitingForCapacity,
}: {
  state: PublicQuickPlayState;
  clock: number;
  waitingForCapacity: boolean;
}) {
  if (state.phase !== "claiming" && state.phase !== "connecting" && state.phase !== "assembling") return null;

  if (state.phase === "assembling") {
    const seconds = assemblySecondsRemaining(state.arena?.assemblyDeadlineAt, clock);
    const percent = assemblyProgressPercent(
      state.arena?.assemblyStartedAt,
      state.arena?.assemblyDeadlineAt,
      clock,
    );
    return (
      <div
        className="public-deployment-progress"
        role="progressbar"
        aria-label="Deployment countdown"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`Deploying in ${seconds} seconds`}
      >
        <div className="public-deployment-progress-track"><span style={{ width: `${percent}%` }} /></div>
        <strong>DEPLOYING IN {seconds}</strong>
      </div>
    );
  }

  const elapsed = publicQueueSecondsElapsed(state.startedAt, clock);
  const label = waitingForCapacity
    ? "SERVER WAKING"
    : state.phase === "connecting"
      ? "CONNECTING TO ARENA"
      : "FINDING PUBLIC ARENA";
  return (
    <div
      className="public-deployment-progress is-indeterminate"
      role="progressbar"
      aria-label={label.toLowerCase()}
      aria-valuetext={`${label}, ${elapsed} seconds elapsed`}
    >
      <div className="public-deployment-progress-track"><span /></div>
      <strong>{label} · {elapsed}S</strong>
    </div>
  );
}

function PartyStatus({ party, isLeader, allocationSize }: { party: PartyState | null; isLeader: boolean | null; allocationSize?: number }) {
  const size = allocationSize ?? party?.members.length ?? 1;
  return (
    <aside className="public-party-status" aria-label="Party status">
      <strong>{publicPartyStatusLabel(size, isLeader)}</strong>
      <span>LOADOUT LOCKS AT CLAIM · PARTY PERSISTS AFTER RESULTS</span>
    </aside>
  );
}

function AssemblyRoster({ members }: { members: PublicArenaMember[] }) {
  return (
    <section className="public-assembly-roster" aria-label="Public assembly roster">
      <header><strong>ASSEMBLY</strong><span>{Math.min(18, members.length)} HUMAN · {Math.max(0, 18 - members.length)} AI</span></header>
      <ol>
        {members.map((member, index) => <li key={`${member.name}-${index}`}><span>{member.name}</span><em>HUMAN</em></li>)}
        {members.length < 18 ? <li className="lobby-ai"><span>OPEN PLAYER ROLES</span><em>AI</em></li> : null}
      </ol>
    </section>
  );
}

function phaseMessage(state: PublicQuickPlayState): string {
  switch (state.phase) {
    case "claiming": return "LOCKING PARTY LOADOUT";
    case "connecting": return "CONNECTING TO PUBLIC ASSEMBLY";
    case "assembling": return "ASSEMBLING 18 PLAYER ROLES";
    case "cancelling": return "CANCELLING WHOLE PARTY RESERVATION";
    case "idle": return "READY";
    default: return "";
  }
}

function initialState(): PublicQuickPlayState {
  try {
    const raw = sessionStorage.getItem(resumeKey);
    const resume = raw ? parsePublicQuickPlayResume(JSON.parse(raw)) : null;
    if (resume) return publicQuickPlayStateFromResume(resume);
  } catch {
    // Invalid or unavailable session storage falls back to a fresh claim.
  }
  clearResume();
  return initialPublicQuickPlayState;
}

function writeResume(resume: ReturnType<typeof publicQuickPlayResume>): void {
  try {
    if (resume) sessionStorage.setItem(resumeKey, JSON.stringify(resume));
    else sessionStorage.removeItem(resumeKey);
  } catch {
    // A private-mode storage failure must not prevent this live session.
  }
}

function clearResume(): void {
  try { sessionStorage.removeItem(resumeKey); } catch { /* Storage is optional. */ }
}

function queueErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Public quick play is unavailable.";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
