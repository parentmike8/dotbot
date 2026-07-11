import { useMemo, useState } from "react";
import { defaultGameConfig } from "@dotbot/game";
import { floorHeight, locationLabel, resolvePlan } from "@dotbot/game/mapModel";
import { clamp01 } from "@dotbot/game/math";
import { useDotBotGame } from "../game/useDotBotGame";
import { ManifestScreen } from "./ManifestScreen";

const coachFadeAtMs = 12_000;
const coachDismissAtMs = 15_000;

function formatRunClock(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function App() {
  // Remounting the session tears down and rebuilds the simulation and
  // renderer — a full fresh run without reloading the page.
  const [session, setSession] = useState(0);
  return <GameSession key={session} onRestart={() => setSession((run) => run + 1)} />;
}

function GameSession({ onRestart }: { onRestart: () => void }) {
  const { hostRef, snapshot, events, runResult, map, playerId, debugVisible, joystick, joystickHandlers, queueDash } = useDotBotGame();
  const player = snapshot?.bots.find((bot) => bot.id === playerId);
  const playerCoverage = snapshot?.coverages.find((coverage) => coverage.actorId === playerId || coverage.targetId === playerId);
  const dashProgress = player ? 1 - clamp01(player.dashCooldownMs / defaultGameConfig.dashCooldownMs) : 1;
  const remainingRunMs = Math.max(0, defaultGameConfig.runDurationMs - (snapshot?.timeMs ?? 0));
  const runClock = formatRunClock(remainingRunMs);
  const activeRivalCount = player
    ? (snapshot?.bots.filter((bot) => bot.squadId !== player.squadId && bot.state === "alive").length ?? 0)
    : 0;
  const floorContext = useMemo(() => {
    if (!snapshot || !player) {
      return null;
    }

    const activePlan = resolvePlan(map, player.floorId, player.position);
    const building = activePlan ? map.buildings.find((candidate) => candidate.id === activePlan.buildingId) : undefined;

    if (!activePlan || !building) {
      return null;
    }

    return {
      building,
      activeFloorId: activePlan.planId,
      floors: [...building.floors].sort((a, b) => floorHeight(b.label) - floorHeight(a.label)),
    };
  }, [map, player, snapshot]);
  const currentLocation = player ? locationLabel(map, player.floorId, player.position) : map.name.toUpperCase();
  const killCounts = useMemo(() => {
    const spawnById = new Map(map.botSpawns.map((spawn) => [spawn.id, spawn]));
    const viewerSquadId = spawnById.get(playerId)?.squadId;
    let ai = 0;
    let players = 0;

    for (const event of events) {
      if (event.type !== "consumed" || spawnById.get(event.byBotId)?.squadId !== viewerSquadId) {
        continue;
      }

      if (spawnById.get(event.botId)?.isAmbient) {
        ai += 1;
      } else {
        players += 1;
      }
    }

    return { ai, players };
  }, [events, map, playerId]);
  const coachPhase =
    snapshot && snapshot.timeMs < coachDismissAtMs ? (snapshot.timeMs >= coachFadeAtMs ? "is-leaving" : "") : null;
  const statusText = useMemo(() => {
    if (!snapshot || !player) {
      return "Starting";
    }

    if (player.state === "consumed") {
      return "Respawning";
    }

    if (player.state === "downed") {
      return "Downed";
    }

    if (playerCoverage?.kind === "capture") {
      return "Capturing";
    }

    if (playerCoverage?.kind === "extract") {
      return "Extracting";
    }

    if (playerCoverage?.kind === "consume") {
      return playerCoverage.actorId === player.id ? "Consuming" : "Being consumed";
    }

    if (playerCoverage?.kind === "revive") {
      return playerCoverage.actorId === player.id ? "Reviving" : "Being revived";
    }

    return "Explore";
  }, [player, playerCoverage, snapshot]);

  return (
    <main
      className="app-shell"
      aria-label="DotBot playable sandbox"
      data-player-state={player?.state ?? "loading"}
      data-player-x={player ? Math.round(player.position.x) : undefined}
      data-player-y={player ? Math.round(player.position.y) : undefined}
      data-dash-ready={player ? player.dashCooldownMs <= 0 : false}
    >
      <div ref={hostRef} className="game-canvas" />

      {snapshot ? (
        <div className="hud location-label" aria-label="Current location">
          {currentLocation}
        </div>
      ) : null}

      <section className="hud hud-top-left" aria-label="Run status">
        <div className="bot-readout">
          <div className="status-block">
            <span className="hud-caption">Status</span>
            <div className="status-line">{statusText}</div>
          </div>
          <div className="shield-row" aria-label={`${player?.shields ?? 0} shields`}>
            {(player?.shieldSegments ?? Array.from({ length: 3 }, () => 0)).map((plate, index) => (
              <span key={index} className={`shield ${plate >= 1 ? "filled" : plate > 0 ? "cracked" : ""}`} />
            ))}
          </div>
          <dl className="run-readout">
            <div>
              <dt>Run</dt>
              <dd>
                <time dateTime={`PT${Math.floor(remainingRunMs / 1000)}S`}>{runClock}</time>
              </dd>
            </div>
            <div>
              <dt>Rivals</dt>
              <dd aria-label={`${activeRivalCount} active rivals`}>{activeRivalCount}</dd>
            </div>
          </dl>
        </div>
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
      </section>

      <section className="hud hud-top-right" aria-label="Inventory">
        <div className="inventory-readout">
          <div className="dot-count" aria-label={`${player?.inventoryDots ?? 0} carried dots`}>
            <span className="dot-count-mark" />
            <span className="inventory-value">
              <span className="hud-caption">Carry</span>
              <strong>{player?.inventoryDots ?? 0}</strong>
            </span>
          </div>
        </div>
      </section>

      {floorContext ? (
        <aside className="hud floor-rail" aria-label={`${floorContext.building.name} floor guide`}>
          <span className="floor-rail-name">{floorContext.building.name}</span>
          <ol>
            {floorContext.floors.map((floor) => {
              const isActive = floor.id === floorContext.activeFloorId;
              return (
                <li key={floor.id} className={isActive ? "active" : ""} aria-current={isActive ? "location" : undefined}>
                  <span className="floor-label">{floor.label}</span>
                  <span className="floor-tick" />
                </li>
              );
            })}
          </ol>
        </aside>
      ) : null}

      {playerCoverage ? (
        <div className="coverage-meter" aria-label="Coverage progress">
          <span style={{ width: `${clamp01(playerCoverage.progressMs / playerCoverage.durationMs) * 100}%` }} />
        </div>
      ) : null}

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
              <span>Cover a Dot</span>
            </li>
            <li>
              <strong>Extract</strong>
              <span>Exit on a pad</span>
            </li>
          </ol>
        </section>
      ) : null}

      <div className="touch-controls" aria-label="Touch controls">
        <div className={`joystick ${joystick.active ? "active" : ""}`} {...joystickHandlers}>
          <span
            className="joystick-knob"
            style={{
              transform: `translate(${joystick.knob.x}px, ${joystick.knob.y}px)`,
            }}
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
          disabled={runResult !== null || !player || player.state !== "alive" || player.dashCooldownMs > 0}
          aria-label="Dash"
        >
          Dash
        </button>
      </div>

      {debugVisible && snapshot ? (
        <aside className="debug-panel" aria-label="Debug panel">
          <div>FPS {snapshot.debug.fps}</div>
          <div>Tick {snapshot.debug.tickCount}</div>
          <div>Bodies {snapshot.debug.activeBodies}</div>
          <div>Dots {snapshot.debug.activeDots}</div>
          <div>Capture {defaultGameConfig.dotCaptureDurationMs}ms</div>
          <div>Cover {defaultGameConfig.coverDurationMs}ms</div>
          <div>Damage {defaultGameConfig.damageSpeed}</div>
        </aside>
      ) : null}

      {runResult ? (
        <ManifestScreen
          result={runResult}
          aiKills={killCounts.ai}
          playerKills={killCounts.players}
          runTime={formatRunClock(runResult.runTimeMs)}
          onNewRun={onRestart}
        />
      ) : null}
    </main>
  );
}
