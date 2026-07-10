import { useMemo } from "react";
import { defaultGameConfig } from "../game";
import { clamp01 } from "../game/math";
import { useDotBotGame } from "../game/useDotBotGame";

export function App() {
  const { hostRef, snapshot, debugVisible, joystick, joystickHandlers, queueDash } = useDotBotGame();
  const player = snapshot?.bots.find((bot) => bot.id === snapshot.playerId);
  const playerCoverage = snapshot?.coverages.find((coverage) => coverage.actorId === snapshot.playerId || coverage.targetId === snapshot.playerId);
  const dashProgress = player ? 1 - clamp01(player.dashCooldownMs / defaultGameConfig.dashCooldownMs) : 1;
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
          {snapshot.locationLabel}
        </div>
      ) : null}

      <section className="hud hud-top-left" aria-label="Run status">
        <div className="bot-readout">
          <div className="shield-row" aria-label={`${player?.shields ?? 0} shields`}>
            {Array.from({ length: player?.maxShields ?? 3 }).map((_, index) => (
              <span key={index} className={`shield ${index < (player?.shields ?? 0) ? "filled" : ""}`} />
            ))}
          </div>
          <div className="status-line">{statusText}</div>
        </div>
      </section>

      <section className="hud hud-top-right" aria-label="Inventory">
        <div className="dot-count">
          <span className="dot-count-mark" />
          <span>{player?.inventoryDots ?? 0}</span>
        </div>
        <div className="dot-count banked" aria-label="Banked dots">
          <span className="dot-count-mark banked-mark" />
          <span>{snapshot?.bankedDots ?? 0}</span>
        </div>
      </section>

      {playerCoverage ? (
        <div className="coverage-meter" aria-label="Coverage progress">
          <span style={{ width: `${clamp01(playerCoverage.progressMs / playerCoverage.durationMs) * 100}%` }} />
        </div>
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
          disabled={!player || player.state !== "alive" || player.dashCooldownMs > 0}
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
    </main>
  );
}
