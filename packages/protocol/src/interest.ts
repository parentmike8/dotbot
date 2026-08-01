import { classifyNoise, contextKey, doorEntityCollisionRect, physicsFloorId } from "@dotbot/game/mapModel";
import { distance } from "@dotbot/game/math";
import { bodiesTouching } from "@dotbot/game/bodyContact";
import type { MapDocument, SimEvent, Vec2 } from "@dotbot/game/types";
import { hasLineOfSight, OUTDOOR_SIGHT, seesOutdoors } from "@dotbot/game/visibility";
import type { EntityMeta, FullWireSnapshot, MatchIntel, WireBot } from "./messages";

export type ViewerContext = {
  map: MapDocument;
  squadId: string;
  viewerBotId?: string;
  /** Living physics floors occupied by the viewer's squad. Used after death. */
  squadPhysicsFloorIds: ReadonlySet<string>;
  /** Current spectate focus when known; otherwise the first living squadmate. */
  spectatedBotId?: string;
  /** Already authorized for this viewer by the room's persistence lookup. */
  intel?: MatchIntel;
};

export function filterForViewer(
  wire: FullWireSnapshot,
  meta: readonly EntityMeta[],
  viewerCtx: ViewerContext,
): FullWireSnapshot {
  const metaById = new Map(meta.map((entry) => [entry.id, entry]));
  const ownBot = viewerCtx.viewerBotId ? wire.bots.find((bot) => bot.i === viewerCtx.viewerBotId) : undefined;
  /**
   * Downed is when you start watching your squad.
   *
   * This has always been the DMZ shape — a viewer with no live bot of their own
   * gets their squad's floors and follows a squadmate — but it keyed on the
   * `consumed` state, which meant it only engaged once a bot had been finished
   * off. Nothing finishes a bot off any more, so it keys on the state a player is
   * actually in while they wait: down, and watching.
   */
  const isSpectating = !ownBot || ownBot.s === "downed";
  const squadBots = wire.bots.filter((bot) => metaById.get(bot.i)?.squadId === viewerCtx.squadId);
  const spectatedBot = isSpectating
    ? squadBots.find((bot) => bot.i === viewerCtx.spectatedBotId && (bot.s ?? "alive") === "alive")
      ?? squadBots.find((bot) => (bot.s ?? "alive") === "alive")
    : undefined;
  const observer = isSpectating ? spectatedBot : ownBot;
  const visibleFloors = visiblePhysicsFloors(wire, viewerCtx);

  const rivalsAlive = wire.bots.filter((bot) => {
    const botMeta = metaById.get(bot.i);
    return botMeta
      && !botMeta.isAmbient
      && botMeta.squadId !== viewerCtx.squadId
      && (bot.s ?? "alive") === "alive";
  }).length;
  const bots = wire.bots.filter((bot) => {
    const botMeta = metaById.get(bot.i);
    if (botMeta?.squadId === viewerCtx.squadId) return true;
    if (!observer || !visibleFloors.has(physicsFloorId(viewerCtx.map, bot.fl ?? "outdoor"))) return false;
    if ((bot.ic ?? 0) > 0) {
      const observerMeta = metaById.get(observer.i);
      return physicsFloorId(viewerCtx.map, observer.fl ?? "outdoor") === physicsFloorId(viewerCtx.map, bot.fl ?? "outdoor")
        && Boolean(observerMeta && botMeta && botsPhysicallyTouch(observer, observerMeta, bot, botMeta));
    }
    return ordinarilyVisible(wire, viewerCtx.map, observer, wirePosition(bot), bot.fl ?? "outdoor");
  }).map((bot) => {
    /**
     * What a rival carries is private right up until their body is searched.
     *
     * A loot channel is what buys that sight, and the picker cannot offer a slot
     * the viewer was never sent — so the reveal has to happen here, on the same
     * `searched` flag the simulation gates the take on.
     */
    const openBody = bot.sr === true && bot.s === "downed";
    const inventoryVisible = metaById.get(bot.i)?.squadId === viewerCtx.squadId || openBody;
    return {
      ...bot,
      b: inventoryVisible ? bot.b : undefined,
      h: inventoryVisible ? bot.h : undefined,
      bs: inventoryVisible ? bot.bs : undefined,
      hs: inventoryVisible ? bot.hs : undefined,
      ir: inventoryVisible ? bot.ir : undefined,
      r: bot.i === viewerCtx.viewerBotId ? bot.r : undefined,
      o: bot.i === viewerCtx.viewerBotId ? bot.o : undefined,
      ic: bot.i === viewerCtx.viewerBotId ? bot.ic : undefined,
    };
  });
  const includedBotIds = new Set(bots.map((bot) => bot.i));
  const allBotIds = new Set(wire.bots.map((bot) => bot.i));
  const dots = wire.dots.filter((dot) => visibleFloors.has(physicsFloorId(viewerCtx.map, dot.floorId)));
  const mines = wire.mines
    .filter((mine) => {
      if (!visibleFloors.has(physicsFloorId(viewerCtx.map, mine.floorId))) return false;
      if (mine.squadId === viewerCtx.squadId) return true;
      if (viewerCtx.viewerBotId && mine.revealedToBotIds?.includes(viewerCtx.viewerBotId)) return true;
      return Boolean(observer && ordinarilyVisible(wire, viewerCtx.map, observer, mine.position, mine.floorId));
    })
    .map((mine) => {
      const squadMine = mine.squadId === viewerCtx.squadId;
      const radarRevealed = Boolean(viewerCtx.viewerBotId && mine.revealedToBotIds?.includes(viewerCtx.viewerBotId));
      return {
        id: mine.id,
        position: mine.position,
        radius: mine.radius,
        floorId: mine.floorId,
        // Exact placement time is server bookkeeping for owner rotation. A
        // rival does not need a correlation handle back to the placer.
        placedAtMs: squadMine ? mine.placedAtMs : 0,
        ...(squadMine ? { placedByBotId: mine.placedByBotId, squadId: mine.squadId } : {}),
        presentation: squadMine ? "squad" as const : radarRevealed ? "revealed" as const : "disguised" as const,
        ...(!squadMine ? { disguise: deterministicMineDisguise(mine.id) } : {}),
        ...(!squadMine && !radarRevealed ? { seam: true as const } : {}),
      };
    });
  const coverages = wire.coverages.filter((coverage) =>
    // A channel is actor state. Never disclose a hidden actor merely because
    // its target is visible; likewise, a bot target must independently be in
    // this viewer's interest set. Dot/extraction/hold-index targets are not bot
    // identities and remain useful once their actor is authorized.
    includedBotIds.has(coverage.actorId)
      && (!allBotIds.has(coverage.targetId) || includedBotIds.has(coverage.targetId)),
  );
  const listeners = isSpectating
    ? squadBots.filter((bot) => (bot.s ?? "alive") === "alive" && visibleFloors.has(physicsFloorId(viewerCtx.map, bot.fl ?? "outdoor")))
    : observer ? [observer] : [];
  const noises = wire.noises.filter((noise) => listeners.some((listener) =>
    classifyNoise(
      viewerCtx.map,
      listener.fl ?? "outdoor",
      wirePosition(listener),
      noise.floorId,
      noise.position,
      noise.loudness,
    ) !== null,
  ));

  return { ...wire, bots, dots, mines, coverages, noises, rivalsAlive, intel: viewerCtx.intel };
}

export function visiblePhysicsFloors(
  wire: Pick<FullWireSnapshot, "bots">,
  viewerCtx: ViewerContext,
): Set<string> {
  const metaOwn = viewerCtx.viewerBotId ? wire.bots.find((bot) => bot.i === viewerCtx.viewerBotId) : undefined;
  const isSpectating = !metaOwn || metaOwn.s === "downed";
  if (isSpectating) return new Set(viewerCtx.squadPhysicsFloorIds);
  return new Set([physicsFloorId(viewerCtx.map, metaOwn.fl ?? "outdoor")]);
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
    // A mark is for the squad that made it, wherever it points and whoever can see the
    // bot that made it. Leaking one to a rival hands them both the place and the fact
    // that somebody is watching it.
    if (event.type === "pinged") return event.squadId === squadId;
    if (event.type === "mineRotated") return metaById.get(event.botId)?.squadId === squadId;
    return event.type === "plea" || visibleBot(event.botId) || ("byBotId" in event && visibleBot(event.byBotId));
  }).map((event) => event.type === "downed" && event.cause?.kind === "mine"
    ? { ...event, byBotId: undefined }
    : event);
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

function ordinarilyVisible(
  wire: Pick<FullWireSnapshot, "doors">,
  map: MapDocument,
  observer: WireBot,
  targetPosition: Vec2,
  targetFloorId: string,
): boolean {
  const observerFloorId = observer.fl ?? "outdoor";
  if (physicsFloorId(map, observerFloorId) !== physicsFloorId(map, targetFloorId)) return false;
  const dynamicOccluders = (wire.doors ?? [])
    .filter((door) => door.blocking && door.floorId === physicsFloorId(map, observerFloorId))
    .map(doorEntityCollisionRect);
  const observerPosition = wirePosition(observer);
  const observerContext = contextKey(map, observerFloorId, observerPosition);
  const targetContext = contextKey(map, targetFloorId, targetPosition);
  if (observerContext === targetContext) {
    if (physicsFloorId(map, observerFloorId) === "outdoor"
      && distance(observerPosition, targetPosition) > OUTDOOR_SIGHT) return false;
    return hasLineOfSight(map, observerContext, observerPosition, targetPosition, dynamicOccluders);
  }
  return seesOutdoors(map, observerFloorId, observerPosition, targetFloorId, targetPosition, dynamicOccluders);
}

function botsPhysicallyTouch(
  observer: WireBot,
  observerMeta: EntityMeta,
  target: WireBot,
  targetMeta: EntityMeta,
): boolean {
  const observerSegments = observer.sh ?? Array(observerMeta.maxShields).fill(1);
  const targetSegments = target.sh ?? Array(targetMeta.maxShields).fill(1);
  return bodiesTouching({
    position: wirePosition(observer),
    radius: observerMeta.radius,
    facing: observer.f ?? 0,
    shieldSegments: observerSegments,
  }, {
    position: wirePosition(target),
    radius: targetMeta.radius,
    facing: target.f ?? 0,
    shieldSegments: targetSegments,
  }, 1);
}
