import { useMemo, useState } from "react";
import { clamp01 } from "@dotbot/game/math";
import { useDotBotGame } from "../../game/useDotBotGame";
import type { NetSession } from "../../game/session/NetSession";
import { ManifestScreen } from "../ManifestScreen";
import { FeedbackControls } from "../FeedbackControls";
import { BodyPromptView, DownedSelfView } from "../downed/DownedPrompts";
import { useDownedPrompts } from "../downed/useDownedPrompts";
import {
  BayBank, DebugPanel, FloorRail, HoldPicker, PingPicker, RunReadout, SettingsPanel, TouchControls,
} from "../hud/Overlay";
import { hudSkinClass } from "../hud/overlaySkins";
import { floorColumn, formatRunClock, rivalsAlive, squadDownCounts } from "../hud/hud";
import { WorldMapOverlay } from "../WorldMapOverlay";

type NetGameViewProps = {
  session: NetSession;
  roomCode: string;
  onReturnToLobby: () => void;
  returnLabel?: string;
  connectionMessage?: string;
};

/**
 * A real match, on the same overlay the sandbox uses.
 *
 * This file used to draw a second HUD. It had its own run clock, its own bay strip with
 * a hardcoded four slots and its own inline copy of the item glyphs, its own debug
 * panel, and a verbatim duplicate of the item key — so the surface people actually play
 * on was the one furthest from whatever the sandbox had most recently been tuned to.
 * What is left here is only what a networked match has and a sandbox does not: a room
 * to be in, other people's cameras to borrow, and a lobby to go back to.
 */
export function NetGameView({ session, roomCode, onReturnToLobby, returnLabel = "Return to lobby", connectionMessage = "" }: NetGameViewProps) {
  const {
    hostRef, snapshot, events, runResult, spectating, debugVisible, networkDebug, map,
    settingsVisible, toggleSettings, joystick, joystickHandlers, queueDash, cycleSpectator, leaveRun,
    selectDownedVerb, plea, useBay, swapBayItem, takeFromBody, setBodyAction,
    pingHandlers, pingPicker, choosePingKind, clearPings, closePingPicker,
    worldMapVisible, toggleWorldMap, closeWorldMap, markExterior, chooseExteriorMark, squadMarks,
    feedbackPreferences, audioStatus, toggleSound, toggleHaptics, toggleReducedMotion, testSound,
  } = useDotBotGame({ session, spectate: true });
  const [swapBay, setSwapBay] = useState<number | null>(null);
  const player = snapshot?.bots.find((bot) => bot.id === session.playerId);
  const remainingRunMs = Math.max(0, session.config.runDurationMs - (snapshot?.timeMs ?? 0));
  const { prompt, self: downed, onVerb } = useDownedPrompts({
    snapshot, events, playerId: session.playerId, spectating, runOver: runResult !== null,
    selectDownedVerb, takeFromBody, setBodyAction,
  });
  const mineRotated = [...events].reverse().find((event) => event.type === "mineRotated");
  const spectateMode = runResult?.outcome === "died";
  const playing = !spectating && !spectateMode;
  const dashProgress = player ? 1 - clamp01(player.dashCooldownMs / session.config.dashCooldownMs) : 1;
  const column = useMemo(
    () => (player ? floorColumn(map, player.floorId, player.position) : null),
    [map, player],
  );
  const downCounts = useMemo(
    () => squadDownCounts(events, (botId) => session.getEntityMeta(botId), session.playerId),
    [events, session],
  );

  return (
    <main
      className={`app-shell net-game ${hudSkinClass()}`}
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
      <div ref={hostRef} className="game-canvas" {...pingHandlers} />

      {connectionMessage ? (
        <aside className="net-game-connection" role="status" aria-live="polite">
          <strong>{connectionMessage}</strong>
          <button type="button" onClick={onReturnToLobby}>{returnLabel}</button>
        </aside>
      ) : null}

      <RunReadout
        remainingRunMs={remainingRunMs}
        rivals={rivalsAlive(snapshot?.bots, player?.squadId)}
        onSettings={toggleSettings}
      >
        <button type="button" className="map-button" onClick={toggleWorldMap}>Map <kbd>M</kbd></button>
        <span className="room-chip">Room {roomCode}</span>
      </RunReadout>

      {playing ? (
        <BayBank
          player={player}
          slots={session.config.baySlots}
          holdSlots={session.config.holdSlots}
          onUse={useBay}
          onSwapRequest={setSwapBay}
        />
      ) : null}

      {swapBay !== null && player?.hold.length ? (
        <HoldPicker
          bay={swapBay}
          hold={player.hold}
          onClose={() => setSwapBay(null)}
          onChoose={(holdIndex) => {
            swapBayItem(swapBay, holdIndex);
            setSwapBay(null);
          }}
        />
      ) : null}

      {settingsVisible ? (
        <SettingsPanel onClose={toggleSettings}>
          <FeedbackControls
            preferences={feedbackPreferences}
            audioStatus={audioStatus}
            onToggleSound={toggleSound}
            onToggleHaptics={toggleHaptics}
            onToggleReducedMotion={toggleReducedMotion}
            onTestSound={testSound}
          />
        </SettingsPanel>
      ) : null}

      {column && !worldMapVisible ? <FloorRail column={column} /> : null}

      {worldMapVisible && snapshot ? (
        <WorldMapOverlay
          map={map}
          snapshot={snapshot}
          viewerId={session.playerId}
          marks={squadMarks}
          onPing={markExterior}
          onChoosePing={chooseExteriorMark}
          onClose={closeWorldMap}
        />
      ) : null}

      {/*
        The first few seconds of a match: where you came in, and how many neutral bots
        each building is holding. It expires on its own, like the quick-start card —
        insertion intel is only intel while you are still deciding where to go.
      */}
      {snapshot && snapshot.timeMs < 5_000 ? (
        <aside className="insertion-card" aria-label="Insertion">
          <strong>Inserted at {session.insertionName}</strong>
          {session.intel?.greyDensity ? (
            <dl aria-label="Bots by building">
              {session.intel.greyDensity.map((row) => (
                <div key={row.buildingId}><dt>{row.buildingName}</dt><dd>{row.count}</dd></div>
              ))}
            </dl>
          ) : null}
        </aside>
      ) : null}

      {mineRotated ? <div className="spectating-chip" aria-live="polite">Mine rotated</div> : null}

      {spectating ? (
        <button className="spectating-chip" type="button" onPointerDown={cycleSpectator}>
          Watching {spectating.name}
        </button>
      ) : spectateMode ? <div className="spectating-chip">Squad down · map overview</div> : null}

      {spectateMode ? (
        <button className="leave-to-base" type="button" onClick={() => {
          session.leaveRun();
          onReturnToLobby();
        }}>Leave to base</button>
      ) : null}

      {playing ? (
        <TouchControls
          joystick={joystick}
          joystickHandlers={joystickHandlers}
          onDash={queueDash}
          dashProgress={dashProgress}
          dashDisabled={
            runResult !== null || !player || player.state !== "alive"
            || (player.dashCooldownMs > 0 && player.dashOverchargeCharges <= 0)
          }
        />
      ) : null}

      {pingPicker ? (
        <PingPicker
          at={pingPicker.screen}
          onChoose={choosePingKind}
          onClear={clearPings}
          onClose={closePingPicker}
        />
      ) : null}

      {downed ? <DownedSelfView self={downed} onPlea={plea} onLeave={leaveRun} /> : null}

      <BodyPromptView prompt={prompt} onVerb={onVerb} onTake={takeFromBody} onTakeAll={(bodyId) => takeFromBody(bodyId, "all")} />

      {debugVisible && snapshot ? (
        <DebugPanel snapshot={snapshot} config={session.config} networkDebug={networkDebug} />
      ) : null}

      {runResult && !spectateMode ? (
        <ManifestScreen
          result={runResult}
          aiKills={downCounts.ai}
          playerKills={downCounts.players}
          runTime={formatRunClock(runResult.runTimeMs)}
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
