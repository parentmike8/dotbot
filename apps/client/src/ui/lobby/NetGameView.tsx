import { useMemo } from "react";
import { clamp01 } from "@dotbot/game/math";
import { useDotBotGame } from "../../game/useDotBotGame";
import type { NetSession } from "../../game/session/NetSession";
import { arrivalSparkline } from "../../game/session/netgraph";
import { ManifestScreen } from "../ManifestScreen";
import { FeedbackControls } from "../FeedbackControls";
import { BodyPromptView, DownedSelfView } from "../downed/DownedPrompts";
import { useDownedPrompts } from "../downed/useDownedPrompts";

type NetGameViewProps = {
  session: NetSession;
  roomCode: string;
  onReturnToLobby: () => void;
  returnLabel?: string;
  connectionMessage?: string;
};

export function NetGameView({ session, roomCode, onReturnToLobby, returnLabel = "RETURN TO LOBBY", connectionMessage = "" }: NetGameViewProps) {
  const {
    hostRef, snapshot, events, runResult, spectating, debugVisible, networkDebug,
    legendVisible, toggleLegend, joystick, joystickHandlers, queueDash, cycleSpectator, leaveRun, selectDownedVerb, plea,
    takeFromBody, setBodyAction,
    feedbackPreferences, audioStatus, toggleSound, toggleHaptics, toggleReducedMotion, testSound,
  } = useDotBotGame({ session, spectate: true });
  const player = snapshot?.bots.find((bot) => bot.id === session.playerId);
  const remainingRunMs = Math.max(0, session.config.runDurationMs - (snapshot?.timeMs ?? 0));
  const { prompt, self: downed, onVerb } = useDownedPrompts({
    snapshot, events, playerId: session.playerId, spectating, runOver: runResult !== null,
    selectDownedVerb, takeFromBody, setBodyAction,
  });
  const mineRotated = [...events].reverse().find((event) => event.type === "mineRotated");
  const spectateMode = runResult?.outcome === "died";
  const dashProgress = player ? 1 - clamp01(player.dashCooldownMs / session.config.dashCooldownMs) : 1;
  const downCounts = useMemo(() => {
    const viewerSquadId = session.getEntityMeta(session.playerId)?.squadId;
    let ai = 0;
    let players = 0;
    for (const event of events) {
      if (event.type !== "downed" || !event.byBotId || session.getEntityMeta(event.byBotId)?.squadId !== viewerSquadId) continue;
      if (session.getEntityMeta(event.botId)?.isAmbient) ai += 1;
      else players += 1;
    }
    return { ai, players };
  }, [events, session]);

  return (
    <main
      className="app-shell net-game"
      data-room-code={roomCode}
      data-player-id={session.playerId}
      data-player-state={player?.state ?? "loading"}
      data-player-x={player ? Math.round(player.position.x) : undefined}
      data-player-y={player ? Math.round(player.position.y) : undefined}
      data-hit-confirm-ms={networkDebug?.hitConfirmationMs === null ? undefined : networkDebug?.hitConfirmationMs}
      data-hit-predicted={networkDebug?.hitPredictedCount}
      data-hit-confirmed={networkDebug?.hitConfirmedCount}
      data-hit-unconfirmed={networkDebug?.hitUnconfirmedCount}
      data-hit-pending={networkDebug?.hitPendingCount}
      data-hit-present-p90={networkDebug?.hitPresentationP90Ms}
      data-hit-confirm-p90={networkDebug?.hitConfirmationP90Ms}
      data-frame-p99={networkDebug?.frameP99Ms}
      data-buffer-ms={networkDebug?.interpolationDelayMs}
    >
      <div ref={hostRef} className="game-canvas" />
      {connectionMessage ? (
        <aside className="net-game-connection" role="status" aria-live="polite">
          <strong>{connectionMessage}</strong>
          <button type="button" onClick={onReturnToLobby}>{returnLabel}</button>
        </aside>
      ) : null}
      <aside className="net-game-status" aria-label="Network game status">
        <span>Room {roomCode}</span>
        <strong>{player?.name ?? "Connecting"}</strong>
        <span>{player ? `${player.shields}/${player.maxShields} shields` : "Waiting for snapshots"}</span>
        <span>Run {formatRunTime(remainingRunMs)}</span>
        <button type="button" onClick={toggleLegend}>L / KEY</button>
        {snapshot && snapshot.timeMs < 5_000 ? <b className="insertion-banner">INSERTED: {session.insertionName}</b> : null}
        {snapshot && snapshot.timeMs < 5_000 && session.intel?.greyDensity ? (
          <dl className="intel-density" aria-label="Listening post grey density">
            {session.intel.greyDensity.map((row) => <div key={row.buildingId}><dt>{row.buildingName}</dt><dd>{row.count}</dd></div>)}
          </dl>
        ) : null}
      </aside>
      {debugVisible && snapshot ? (
        <aside className="debug-panel" aria-label="Debug panel">
          <div>
            FPS{" "}
            {networkDebug?.frameP50Ms
              ? Math.round(1_000 / networkDebug.frameP50Ms)
              : snapshot.debug.fps}
          </div>
          <div>Tick {snapshot.debug.tickCount}</div>
          <div>Bodies {snapshot.debug.activeBodies}</div>
          <div>Dots {snapshot.debug.activeDots}</div>
          {networkDebug ? (
            <div className="netgraph" aria-label="Network graph">
              <div className="netgraph-spark" aria-label="Snapshot inter-arrival sparkline">
                {arrivalSparkline(networkDebug.snapshotIntervalsMs)}
              </div>
              <div>Snap {Math.round(networkDebug.snapshotP50Ms)}/{Math.round(networkDebug.snapshotP90Ms)}/{Math.round(networkDebug.snapshotP99Ms)}ms p50/90/99</div>
              <div>RTT {networkDebug.rttMs === null ? "—" : `${Math.round(networkDebug.rttMs)}ms`}</div>
              <div>Buffer {networkDebug.bufferDepthSnapshots} @ {networkDebug.interpolationDelayMs}→{networkDebug.interpolationTargetMs}ms</div>
              <div>Error {networkDebug.predictionErrorPx.toFixed(1)}px</div>
              <div>Corrections {networkDebug.correctionsPerSecond}/s</div>
              <div>Hit confirm {networkDebug.hitConfirmationMs === null ? "—" : `${Math.round(networkDebug.hitConfirmationMs)}ms`}</div>
              <div>Frame {Math.round(networkDebug.frameP50Ms)}/{Math.round(networkDebug.frameP90Ms)}/{Math.round(networkDebug.frameP99Ms)}ms p50/90/99 · max {Math.round(networkDebug.frameMaxMs)}</div>
              <div>Work {networkDebug.frameWorkP90Ms.toFixed(1)}ms p90 · max {networkDebug.frameWorkMaxMs.toFixed(1)} · long {networkDebug.longFrameCount}</div>
              <div>Hit draw {networkDebug.hitPresentationP50Ms.toFixed(1)}/{networkDebug.hitPresentationP90Ms.toFixed(1)}/{networkDebug.hitPresentationP99Ms.toFixed(1)}ms p50/90/99</div>
              <div>Hit ack {Math.round(networkDebug.hitConfirmationP50Ms)}/{Math.round(networkDebug.hitConfirmationP90Ms)}/{Math.round(networkDebug.hitConfirmationP99Ms)}ms p50/90/99 · max {Math.round(networkDebug.hitConfirmationMaxMs)}</div>
              <div>Contacts {networkDebug.hitPredictedCount} predicted · {networkDebug.hitConfirmedCount} confirmed · {networkDebug.hitUnconfirmedCount} unconfirmed · {networkDebug.hitPendingCount} pending</div>
            </div>
          ) : null}
        </aside>
      ) : null}
      {mineRotated ? <div className="spectating-chip" aria-live="polite">MINE ROTATED</div> : null}
      {legendVisible ? (
        <aside className="item-legend" aria-label="Item legend">
          <header><strong>DOTBOT / ITEM KEY</strong><button type="button" onClick={toggleLegend}>×</button></header>
          <dl>
            <div><dt className="powerup-mark">+</dt><dd>Health</dd></div>
            <div><dt className="powerup-mark">◎</dt><dd>Radar</dd></div>
            <div><dt className="powerup-mark">›</dt><dd>Dash overcharge</dd></div>
            <div><dt className="powerup-mark">◌</dt><dd>Incognito</dd></div>
            <div><dt className="blueprint-mark">⌑</dt><dd>Blueprint</dd></div>
            <div><dt className="interaction-mark">○</dt><dd>INTERACTION — STAND ON</dd></div>
            <div><dt>×</dt><dd>Squad mine / radar-revealed mine</dd></div>
            <div><dt className="powerup-mark">◜</dt><dd>Some dots are not dots — watch for the hairline seam</dd></div>
          </dl>
          {session.intel?.greyDensity ? (
            <section className="intel-density"><strong>LISTENING POST / GREYS</strong>
              <dl>{session.intel.greyDensity.map((row) => <div key={row.buildingId}><dt>{row.buildingName}</dt><dd>{row.count}</dd></div>)}</dl>
            </section>
          ) : null}
          <FeedbackControls
            preferences={feedbackPreferences}
            audioStatus={audioStatus}
            onToggleSound={toggleSound}
            onToggleHaptics={toggleHaptics}
            onToggleReducedMotion={toggleReducedMotion}
            onTestSound={testSound}
          />
        </aside>
      ) : null}
      <aside className="net-game-bays" aria-label="In-run bays">
        <span>BAYS</span>
        <div>{(player?.bays ?? [null, null, null, null]).map((item, index) => (
          <b key={index} aria-label={item ? item.kind === "blueprint" ? `${item.blueprintId} blueprint` : item.kind === "mine" ? "mine" : item.type : `Empty bay ${index + 1}`}>
            {item?.kind === "blueprint" ? "⌑" : item?.kind === "mine" ? "×" : item?.type === "health" ? "+" : item?.type === "radar" ? "◎" : item?.type === "dashOvercharge" ? "›" : item?.type === "incognito" ? "◌" : "·"}
          </b>
        ))}</div>
      </aside>
      {spectating ? (
        <button className="spectating-chip" type="button" onPointerDown={cycleSpectator}>
          SPECTATING {spectating.name.toUpperCase()}
        </button>
      ) : spectateMode ? <div className="spectating-chip">SQUAD WIPED · MAP OVERVIEW</div> : null}
      {spectateMode ? <button className="leave-to-base" type="button" onClick={() => {
        session.leaveRun();
        onReturnToLobby();
      }}>LEAVE TO BASE</button> : null}
      {!spectating && !spectateMode ? (
        <div className="touch-controls" aria-label="Touch controls">
          <div
            className={`joystick ${joystick.active ? "active" : ""}`}
            role="application"
            aria-label="Movement joystick"
            {...joystickHandlers}
          >
            <span
              className="joystick-knob"
              style={{ transform: `translate(${joystick.knob.x}px, ${joystick.knob.y}px)` }}
            />
          </div>
          <button
            className="dash-button"
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              queueDash();
            }}
            style={{ "--dash-progress": dashProgress } as React.CSSProperties}
            disabled={runResult !== null || !player || player.state !== "alive" || (player.dashCooldownMs > 0 && player.dashOverchargeCharges <= 0)}
            aria-label="Dash"
          >
            Dash
          </button>
        </div>
      ) : null}
      {downed ? <DownedSelfView self={downed} onPlea={plea} onLeave={leaveRun} /> : null}
      <BodyPromptView prompt={prompt} onVerb={onVerb} onTake={takeFromBody} onTakeAll={(bodyId) => takeFromBody(bodyId, "all")} />
      {runResult && !spectateMode ? (
        <ManifestScreen
          result={runResult}
          aiKills={downCounts.ai}
          playerKills={downCounts.players}
          runTime={formatRunTime(runResult.runTimeMs)}
          onNewRun={() => {
            session.leaveRun();
            onReturnToLobby();
          }}
          actionLabel={returnLabel}
        />
      ) : null}
    </main>
  );
}

function formatRunTime(timeMs: number): string {
  const seconds = Math.max(0, Math.floor(timeMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
