import { classifyNoise, physicsFloorId } from "@dotbot/game/mapModel";
import type { MapDocument, SimEvent, Vec2 } from "@dotbot/game/types";
import type { EntityMeta, WireBot, WireSnapshot } from "./messages";

export type ViewerContext = {
  map: MapDocument;
  squadId: string;
  viewerBotId?: string;
  /** Living physics floors occupied by the viewer's squad. Used after death. */
  squadPhysicsFloorIds: ReadonlySet<string>;
  /** Current spectate focus when known; otherwise the first living squadmate. */
  spectatedBotId?: string;
};

export function filterForViewer(
  wire: WireSnapshot,
  meta: readonly EntityMeta[],
  viewerCtx: ViewerContext,
): WireSnapshot {
  const metaById = new Map(meta.map((entry) => [entry.id, entry]));
  const ownBot = viewerCtx.viewerBotId ? wire.bots.find((bot) => bot.i === viewerCtx.viewerBotId) : undefined;
  const isSpectating = !ownBot || ownBot.s === "consumed";
  const squadBots = wire.bots.filter((bot) => metaById.get(bot.i)?.squadId === viewerCtx.squadId);
  const spectatedBot = isSpectating
    ? squadBots.find((bot) => bot.i === viewerCtx.spectatedBotId && bot.s === "alive")
      ?? squadBots.find((bot) => bot.s === "alive")
    : undefined;
  const observer = isSpectating ? spectatedBot : ownBot;
  const visibleFloors = isSpectating
    ? viewerCtx.squadPhysicsFloorIds
    : new Set(observer ? [physicsFloorId(viewerCtx.map, observer.fl)] : []);

  const bots = wire.bots.filter((bot) =>
    metaById.get(bot.i)?.squadId === viewerCtx.squadId
      || visibleFloors.has(physicsFloorId(viewerCtx.map, bot.fl)),
  ).map((bot) => {
    const squadDetail = metaById.get(bot.i)?.squadId === viewerCtx.squadId;
    return {
      ...bot,
      b: squadDetail ? bot.b : undefined,
      h: squadDetail ? bot.h : undefined,
      r: bot.i === viewerCtx.viewerBotId ? bot.r : undefined,
    };
  });
  const includedBotIds = new Set(bots.map((bot) => bot.i));
  const dots = wire.dots.filter((dot) => visibleFloors.has(physicsFloorId(viewerCtx.map, dot.floorId)));
  const mines = wire.mines
    .filter((mine) => visibleFloors.has(physicsFloorId(viewerCtx.map, mine.floorId)))
    .map((mine) => {
      const squadMine = mine.squadId === viewerCtx.squadId;
      const radarRevealed = Boolean(viewerCtx.viewerBotId && mine.revealedToBotIds.includes(viewerCtx.viewerBotId));
      return {
        ...mine,
        placedByBotId: squadMine ? mine.placedByBotId : "",
        squadId: squadMine ? mine.squadId : "",
        revealedToBotIds: [],
        presentation: squadMine ? "squad" as const : radarRevealed ? "revealed" as const : "disguised" as const,
        disguise: deterministicMineDisguise(mine.id),
        seam: !squadMine && !radarRevealed,
      };
    });
  const coverages = wire.coverages.filter((coverage) =>
    visibleFloors.has(physicsFloorForBot(wire.bots, viewerCtx.map, coverage.actorId))
      || includedBotIds.has(coverage.actorId)
      || includedBotIds.has(coverage.targetId),
  );
  const listeners = isSpectating
    ? squadBots.filter((bot) => bot.s === "alive" && visibleFloors.has(physicsFloorId(viewerCtx.map, bot.fl)))
    : observer ? [observer] : [];
  const noises = wire.noises.filter((noise) => listeners.some((listener) =>
    classifyNoise(
      viewerCtx.map,
      listener.fl,
      wirePosition(listener),
      noise.floorId,
      noise.position,
      noise.loudness,
    ) !== null,
  ));

  return { ...wire, bots, dots, mines, coverages, noises };
}

export function filterEventsForViewer(
  events: readonly SimEvent[],
  meta: readonly EntityMeta[],
  includedBotIds: ReadonlySet<string>,
  squadId: string,
): SimEvent[] {
  const metaById = new Map(meta.map((entry) => [entry.id, entry]));
  const visibleBot = (id: string | undefined) => Boolean(
    id && (includedBotIds.has(id) || metaById.get(id)?.squadId === squadId),
  );
  return events.filter((event) => {
    if (event.type === "mineSensor") return event.squadId === squadId;
    if (event.type === "mineRotated") return metaById.get(event.botId)?.squadId === squadId;
    return event.type === "plea" || visibleBot(event.botId) || ("byBotId" in event && visibleBot(event.byBotId));
  });
}

function deterministicMineDisguise(id: string): "health" | "radar" | "dashOvercharge" | "incognito" {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (["health", "radar", "dashOvercharge", "incognito"] as const)[(hash >>> 0) % 4];
}

function wirePosition(bot: WireBot): Vec2 {
  return { x: bot.p[0], y: bot.p[1] };
}

function physicsFloorForBot(bots: readonly WireBot[], map: MapDocument, botId: string): string {
  const bot = bots.find((candidate) => candidate.i === botId);
  return bot ? physicsFloorId(map, bot.fl) : "";
}
