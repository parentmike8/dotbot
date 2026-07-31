import { useMemo, useState, type ReactNode } from "react";
import type { MapDocument } from "@dotbot/game/types";
import { defaultGameConfig } from "@dotbot/game";
import { clamp01 } from "@dotbot/game/math";
import { useDotBotGame } from "../game/useDotBotGame";
import { ManifestScreen } from "./ManifestScreen";
import { FeedbackControls } from "./FeedbackControls";
import { arrivalGroups, selectBaseMap, spawnAt } from "../mapSelection";
import { BodyPromptView, DownedSelfView } from "./downed/DownedPrompts";
import { useDownedPrompts } from "./downed/useDownedPrompts";
import { KillCamOverlay } from "./downed/KillCamOverlay";
import {
  BayBank, DebugPanel, FloorRail, InventoryPanel, PingPicker, RunReadout, SettingsPanel, SpawnPicker, TouchControls,
} from "./hud/Overlay";
import { hudSkinClass } from "./hud/overlaySkins";
import { floorColumn, formatRunClock, rivalsAlive, squadDownCounts } from "./hud/hud";
import { WorldMapOverlay } from "./WorldMapOverlay";
import { GoalIntro, useGoalIntro } from "./GoalIntro";

export function App() {
  // Remounting the session tears down and rebuilds the simulation and
  // renderer — a full fresh run without reloading the page.
  const [session, setSession] = useState(0);
  /**
   * Which arrival point the next run starts at, or null for the map's own spawn.
   *
   * Seeded from `?at=` so a URL and the picker are the same setting rather than two, and
   * held HERE rather than in `GameSession` on purpose: it has to outlive the remount that
   * restarting performs, and `GameSession` is the thing being remounted.
   */
  const [spawnPointId, setSpawnPointId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("at"),
  );
  const [picking, setPicking] = useState(false);
  const goalIntro = useGoalIntro();
  const base = useMemo(() => selectBaseMap(window.location.search), []);
  const map = useMemo(() => spawnAt(base, spawnPointId), [base, spawnPointId]);
  const groups = useMemo(() => arrivalGroups(base), [base]);

  const start = (pointId: string | null): void => {
    setSpawnPointId(pointId);
    setPicking(false);
    setSession((run) => run + 1);
  };

  /**
   * Handed DOWN into the session rather than rendered beside it, so it lands inside
   * `app-shell` and inherits the HUD skin class. Rendered as a sibling it was the one
   * panel in the game that ignored the skin.
   */
  const picker = picking ? (
    <SpawnPicker
      groups={groups}
      current={spawnPointId}
      onChoose={start}
      onDefault={() => start(null)}
      onClose={() => setPicking(false)}
      canCancel
    />
  ) : null;

  return goalIntro.visible ? (
    <main className={`app-shell goal-intro-shell ${hudSkinClass()}`} aria-label="DotBot introduction">
      <GoalIntro onDismiss={goalIntro.dismiss} />
    </main>
  ) : (
    <GameSession key={session} map={map} onRestart={() => setPicking(true)} spawnPicker={picker} />
  );
}

function GameSession({
  map: requestedMap,
  onRestart,
  spawnPicker,
}: {
  map: MapDocument;
  onRestart: () => void;
  spawnPicker: ReactNode;
}) {
  const {
    hostRef, snapshot, events, runResult, map, playerId, debugVisible, networkDebug, settingsVisible, toggleSettings,
    joystick, joystickHandlers, queueDash, useBay, swapBayItem, dropItem, leaveRun, selectDownedVerb, plea,
    killCam, killCamHostRef, skipKillCam, replayKillCam,
    inventoryVisible, toggleInventory, closeInventory,
    takeFromBody, setBodyAction,
    pingHandlers, pingPicker, choosePingKind, clearPings, closePingPicker, spectating,
    worldMapVisible, toggleWorldMap, closeWorldMap, markExterior, chooseExteriorMark, squadMarks,
    feedbackPreferences, audioStatus, toggleSound, toggleHaptics, toggleReducedMotion, testSound,
  } = useDotBotGame({ map: requestedMap, spectate: true });
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
  return (
    <main
      className={`app-shell ${hudSkinClass()}`}
      aria-label="DotBot playable sandbox"
      data-player-state={player?.state ?? "loading"}
      data-player-x={player ? Math.round(player.position.x) : undefined}
      data-player-y={player ? Math.round(player.position.y) : undefined}
      data-player-shields={player?.shields}
      data-dash-ready={player ? player.dashCooldownMs <= 0 : false}
      data-kill-cam={killCam ? "playing" : undefined}
      data-kill-cam-cause={killCam?.clip.cause.kind}
    >
      <div ref={hostRef} className="game-canvas" {...pingHandlers} />

      <RunReadout
        remainingRunMs={remainingRunMs}
        rivals={rivalsAlive(snapshot?.bots, player?.squadId)}
        onSettings={toggleSettings}
      >
        <button type="button" className="map-button" onClick={toggleWorldMap}>Map <kbd>M</kbd></button>
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
        onOpen={toggleInventory}
        open={inventoryVisible}
        disabled={Boolean(killCam)}
      />

      {inventoryVisible && player && runResult === null && !killCam ? (
        <InventoryPanel
          player={player}
          slots={defaultGameConfig.baySlots}
          holdSlots={defaultGameConfig.holdSlots}
          onUse={useBay}
          onSwap={swapBayItem}
          onDrop={dropItem}
          onClose={closeInventory}
        />
      ) : null}

      {settingsVisible && !killCam ? (
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
          viewerId={playerId}
          marks={squadMarks}
          onPing={markExterior}
          onChoosePing={chooseExteriorMark}
          onClose={closeWorldMap}
        />
      ) : null}

      <KillCamOverlay
        open={Boolean(killCam)}
        viewportRef={killCamHostRef}
        label={killCam?.label ?? ""}
        progress={killCam?.progress ?? 0}
        pass={killCam?.pass ?? 1}
        replaysComplete={killCam?.replaysComplete ?? false}
        onReplay={replayKillCam}
        onClose={skipKillCam}
      />

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

      {/* Last, so it sits over the manifest: "new run" from the end-of-run screen is the
          same action as Restart and goes through the same choice. */}
      {spawnPicker}
    </main>
  );
}
