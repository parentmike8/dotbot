import { useMemo, useState } from "react";
import type { MapDocument } from "@dotbot/game/types";
import { defaultGameConfig } from "@dotbot/game";
import { clamp01 } from "@dotbot/game/math";
import { useDotBotGame } from "../game/useDotBotGame";
import { ManifestScreen } from "./ManifestScreen";
import { FeedbackControls } from "./FeedbackControls";
import { selectMapDocument } from "../mapSelection";
import { BodyPromptView, DownedSelfView } from "./downed/DownedPrompts";
import { useDownedPrompts } from "./downed/useDownedPrompts";
import {
  BayBank, DebugPanel, FloorRail, HoldPicker, PingPicker, RunReadout, SettingsPanel, TouchControls,
} from "./hud/Overlay";
import { hudSkinClass } from "./hud/overlaySkins";
import { floorColumn, formatRunClock, rivalsAlive, squadDownCounts } from "./hud/hud";

const coachFadeAtMs = 12_000;
const coachDismissAtMs = 15_000;

export function App() {
  // Remounting the session tears down and rebuilds the simulation and
  // renderer — a full fresh run without reloading the page.
  const [session, setSession] = useState(0);
  const map = useMemo(() => selectMapDocument(window.location.search), []);
  return <GameSession key={session} map={map} onRestart={() => setSession((run) => run + 1)} />;
}

function GameSession({ map: requestedMap, onRestart }: { map: MapDocument; onRestart: () => void }) {
  const {
    hostRef, snapshot, events, runResult, map, playerId, debugVisible, networkDebug, settingsVisible, toggleSettings,
    joystick, joystickHandlers, queueDash, useBay, swapBayItem, leaveRun, selectDownedVerb, plea,
    takeFromBody, setBodyAction,
    pingHandlers, pingPicker, choosePingKind, closePingPicker, spectating,
    feedbackPreferences, audioStatus, toggleSound, toggleHaptics, toggleReducedMotion, testSound,
  } = useDotBotGame({ map: requestedMap, spectate: true });
  const [swapBay, setSwapBay] = useState<number | null>(null);
  const player = snapshot?.bots.find((bot) => bot.id === playerId);
  const { prompt, self: downed, onVerb } = useDownedPrompts({
    snapshot, events, playerId, spectating, runOver: runResult !== null,
    selectDownedVerb, takeFromBody, setBodyAction,
  });
  const dashProgress = player ? 1 - clamp01(player.dashCooldownMs / defaultGameConfig.dashCooldownMs) : 1;
  const remainingRunMs = Math.max(0, defaultGameConfig.runDurationMs - (snapshot?.timeMs ?? 0));
  const column = useMemo(
    () => (player ? floorColumn(map, player.floorId, player.position) : null),
    [map, player],
  );
  const downCounts = useMemo(() => {
    const spawnById = new Map(map.botSpawns.map((spawn) => [spawn.id, spawn]));
    return squadDownCounts(events, (botId) => spawnById.get(botId), playerId);
  }, [events, map, playerId]);
  const coachPhase =
    snapshot && snapshot.timeMs < coachDismissAtMs ? (snapshot.timeMs >= coachFadeAtMs ? "is-leaving" : "") : null;

  return (
    <main
      className={`app-shell ${hudSkinClass()}`}
      aria-label="DotBot playable sandbox"
      data-player-state={player?.state ?? "loading"}
      data-player-x={player ? Math.round(player.position.x) : undefined}
      data-player-y={player ? Math.round(player.position.y) : undefined}
      data-dash-ready={player ? player.dashCooldownMs <= 0 : false}
    >
      <div ref={hostRef} className="game-canvas" {...pingHandlers} />

      <RunReadout
        remainingRunMs={remainingRunMs}
        rivals={rivalsAlive(snapshot?.bots, player?.squadId)}
        onSettings={toggleSettings}
      >
        <button
          type="button"
          className="restart-button"
          onClick={(event) => {
            // Blur so a follow-up Space press dashes instead of re-triggering.
            event.currentTarget.blur();
            onRestart();
          }}
        >
          ↻ Restart run
        </button>
      </RunReadout>

      <BayBank
        player={player}
        slots={defaultGameConfig.baySlots}
        holdSlots={defaultGameConfig.holdSlots}
        onUse={useBay}
        onSwapRequest={setSwapBay}
      />

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

      {column ? <FloorRail column={column} /> : null}

      {pingPicker ? (
        <PingPicker at={pingPicker.screen} onChoose={choosePingKind} onClose={closePingPicker} />
      ) : null}

      {downed ? <DownedSelfView self={downed} onPlea={plea} onLeave={leaveRun} /> : null}

      <BodyPromptView prompt={prompt} onVerb={onVerb} onTake={takeFromBody} onTakeAll={(bodyId) => takeFromBody(bodyId, "all")} />

      {coachPhase !== null ? (
        <section className={`quick-coach ${coachPhase}`} aria-label="Quick start guide">
          <span className="coach-title">Quick start</span>
          <ol>
            <li>
              <strong>Move</strong>
              <span>WASD / arrows</span>
            </li>
            <li>
              <strong>Dash</strong>
              <span>Space / button</span>
            </li>
            <li>
              <strong>Collect</strong>
              <span>Stand on a Dot</span>
            </li>
            <li>
              <strong>Leave</strong>
              <span>Stand on an exit pad</span>
            </li>
          </ol>
        </section>
      ) : null}

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

      {debugVisible && snapshot ? (
        <DebugPanel snapshot={snapshot} config={defaultGameConfig} networkDebug={networkDebug} />
      ) : null}

      {runResult ? (
        <ManifestScreen
          result={runResult}
          aiKills={downCounts.ai}
          playerKills={downCounts.players}
          runTime={formatRunClock(runResult.runTimeMs)}
          onNewRun={onRestart}
        />
      ) : null}
    </main>
  );
}
