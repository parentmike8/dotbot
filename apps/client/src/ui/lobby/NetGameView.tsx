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
  const { hostRef, snapshot, events, runResult, spectating, legendVisible, toggleLegend, queueDash, cycleSpectator, giveUp, selectDownedVerb, plea } = useDotBotGame({ session, spectate: true });
  const player = snapshot?.bots.find((bot) => bot.id === session.playerId);
  const reviveInProgress = snapshot?.coverages.some((coverage) => coverage.kind === "revive" && coverage.targetId === session.playerId) ?? false;
  const remainingRunMs = Math.max(0, session.config.runDurationMs - (snapshot?.timeMs ?? 0));
  const hostileDowned = player?.state === "alive" ? snapshot?.bots.find((bot) =>
    bot.state === "downed" && !bot.isAmbient && bot.squadId !== player.squadId && bot.floorId === player.floorId
      && Math.hypot(bot.position.x - player.position.x, bot.position.y - player.position.y) <= player.radius * 2.2,
  ) : undefined;
  const hostileChannel = hostileDowned ? snapshot?.coverages.find((coverage) => coverage.actorId === player?.id && coverage.targetId === hostileDowned.id) : undefined;
  const mineRotated = [...events].reverse().find((event) => event.type === "mineRotated");
  const spectateMode = runResult?.outcome === "died";
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
        <button type="button" onClick={toggleLegend}>L / KEY</button>
        {snapshot && snapshot.timeMs < 5_000 ? <b className="insertion-banner">INSERTED: {session.insertionName}</b> : null}
        {snapshot && snapshot.timeMs < 5_000 && session.intel?.greyDensity ? (
          <dl className="intel-density" aria-label="Listening post grey density">
            {session.intel.greyDensity.map((row) => <div key={row.buildingId}><dt>{row.buildingName}</dt><dd>{row.count}</dd></div>)}
          </dl>
        ) : null}
      </aside>
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
            <div><dt>×</dt><dd>Squad mine / radar-revealed mine</dd></div>
            <div><dt className="powerup-mark">◜</dt><dd>Some dots are not dots — watch for the hairline seam</dd></div>
          </dl>
          {session.intel?.greyDensity ? (
            <section className="intel-density"><strong>LISTENING POST / GREYS</strong>
              <dl>{session.intel.greyDensity.map((row) => <div key={row.buildingId}><dt>{row.buildingName}</dt><dd>{row.count}</dd></div>)}</dl>
            </section>
          ) : null}
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
      {runResult && !spectateMode ? (
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
