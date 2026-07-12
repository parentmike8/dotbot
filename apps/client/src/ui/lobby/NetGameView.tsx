import { useMemo } from "react";
import { useDotBotGame } from "../../game/useDotBotGame";
import type { NetSession } from "../../game/session/NetSession";
import { ManifestScreen } from "../ManifestScreen";

type NetGameViewProps = {
  session: NetSession;
  roomCode: string;
  onReturnToLobby: () => void;
};

export function NetGameView({ session, roomCode, onReturnToLobby }: NetGameViewProps) {
  const { hostRef, snapshot, events, runResult, spectating, queueDash, cycleSpectator } = useDotBotGame({ session, spectate: true });
  const player = snapshot?.bots.find((bot) => bot.id === session.playerId);
  const remainingRunMs = Math.max(0, session.config.runDurationMs - (snapshot?.timeMs ?? 0));
  const killCounts = useMemo(() => {
    const viewerSquadId = session.getEntityMeta(session.playerId)?.squadId;
    let ai = 0;
    let players = 0;
    for (const event of events) {
      if (event.type !== "consumed" || session.getEntityMeta(event.byBotId)?.squadId !== viewerSquadId) continue;
      if (session.getEntityMeta(event.botId)?.isAmbient) ai += 1;
      else players += 1;
    }
    return { ai, players };
  }, [events, session]);

  return (
    <main className="app-shell net-game" data-room-code={roomCode} data-player-id={session.playerId}>
      <div ref={hostRef} className="game-canvas" />
      <aside className="net-game-status" aria-label="Network game status">
        <span>Room {roomCode}</span>
        <strong>{player?.name ?? "Connecting"}</strong>
        <span>{player ? `${player.shields}/${player.maxShields} shields` : "Waiting for snapshots"}</span>
        <span>Run {formatRunTime(remainingRunMs)}</span>
      </aside>
      {spectating ? (
        <button className="spectating-chip" type="button" onPointerDown={cycleSpectator}>
          SPECTATING {spectating.name.toUpperCase()}
        </button>
      ) : null}
      <button className="net-dash-button" type="button" disabled={runResult !== null} onPointerDown={queueDash}>
        Dash
      </button>
      {runResult ? (
        <ManifestScreen
          result={runResult}
          aiKills={killCounts.ai}
          playerKills={killCounts.players}
          runTime={formatRunTime(runResult.runTimeMs)}
          onNewRun={() => {
            session.leaveRun();
            onReturnToLobby();
          }}
          actionLabel="RETURN TO LOBBY"
        />
      ) : null}
    </main>
  );
}

function formatRunTime(timeMs: number): string {
  const seconds = Math.max(0, Math.floor(timeMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
