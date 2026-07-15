import { useMemo } from "react";
import { useDotBotGame } from "../../game/useDotBotGame";
import type { NetSession } from "../../game/session/NetSession";
import { ManifestScreen } from "../ManifestScreen";

type NetGameViewProps = {
  session: NetSession;
  roomCode: string;
  onReturnToLobby: () => void;
  returnLabel?: string;
};

export function NetGameView({ session, roomCode, onReturnToLobby, returnLabel = "RETURN TO LOBBY" }: NetGameViewProps) {
  const { hostRef, snapshot, events, runResult, spectating, queueDash, cycleSpectator, giveUp, selectDownedVerb, plea } = useDotBotGame({ session, spectate: true });
  const player = snapshot?.bots.find((bot) => bot.id === session.playerId);
  const reviveInProgress = snapshot?.coverages.some((coverage) => coverage.kind === "revive" && coverage.targetId === session.playerId) ?? false;
  const remainingRunMs = Math.max(0, session.config.runDurationMs - (snapshot?.timeMs ?? 0));
  const hostileDowned = player?.state === "alive" ? snapshot?.bots.find((bot) =>
    bot.state === "downed" && !bot.isAmbient && bot.squadId !== player.squadId && bot.floorId === player.floorId
      && Math.hypot(bot.position.x - player.position.x, bot.position.y - player.position.y) <= player.radius * 2.2,
  ) : undefined;
  const hostileChannel = hostileDowned ? snapshot?.coverages.find((coverage) => coverage.actorId === player?.id && coverage.targetId === hostileDowned.id) : undefined;
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
        {snapshot && snapshot.timeMs < 5_000 ? <b className="insertion-banner">INSERTED: {session.insertionName}</b> : null}
      </aside>
      <aside className="net-game-bays" aria-label="In-run bays">
        <span>BAYS</span>
        <div>{(player?.bays ?? [null, null, null, null]).map((item, index) => (
          <b key={index} aria-label={item ? item.kind === "blueprint" ? `${item.blueprintId} blueprint` : item.type : `Empty bay ${index + 1}`}>
            {item?.kind === "blueprint" ? "⌑" : item?.type === "health" ? "+" : item?.type === "radar" ? "◎" : item?.type === "dashOvercharge" ? "›" : item?.type === "incognito" ? "◌" : "·"}
          </b>
        ))}</div>
      </aside>
      {spectating ? (
        <button className="spectating-chip" type="button" onPointerDown={cycleSpectator}>
          SPECTATING {spectating.name.toUpperCase()}
        </button>
      ) : null}
      <button className="net-dash-button" type="button" disabled={runResult !== null} onPointerDown={queueDash}>
        Dash
      </button>
      {player?.state === "downed" && !reviveInProgress && !runResult ? (
        <div className="downed-actions">
          <button type="button" className="plea-button" onClick={plea}>PLEA · P</button>
          <button type="button" className="give-up-button" onClick={giveUp}>GIVE UP</button>
        </div>
      ) : null}
      {hostileDowned && !runResult ? (
        <div className="hostile-verb-strip" aria-label="Downed hostile actions">
          <strong>{hostileChannel ? verbLabel(hostileChannel.kind) : "DOWNED HOSTILE"}</strong>
          <button type="button" onClick={() => selectDownedVerb("consume")}>C · CONSUME</button>
          <button type="button" onClick={() => selectDownedVerb("reviveClean")}>R · REVIVE CLEAN</button>
          <button type="button" onClick={() => selectDownedVerb("lootThenRevive")}>F · LOOT + REVIVE</button>
        </div>
      ) : null}
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
          actionLabel={returnLabel}
        />
      ) : null}
    </main>
  );
}

function verbLabel(kind: string): string {
  return kind === "consume" ? "CONSUMING" : kind === "reviveClean" ? "REVIVING CLEAN" : kind === "lootThenRevive" ? "LOOTING + REVIVING" : "DOWNED HOSTILE";
}

function formatRunTime(timeMs: number): string {
  const seconds = Math.max(0, Math.floor(timeMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
