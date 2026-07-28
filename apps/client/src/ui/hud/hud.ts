import { floorHeight, resolvePlan } from "@dotbot/game/mapModel";
import type { Building, FloorPlan, Item, MapDocument, SimEvent, Vec2 } from "@dotbot/game/types";

/**
 * Everything the overlay computes, with no React and no markup.
 *
 * There were two HUDs. `App` drew one for the solo sandbox and `NetGameView` drew
 * another for a real match, and between them they carried two run clocks, two bay
 * strips, two kill tallies and two item-glyph tables — every one a separate copy of
 * the same rule. They had already drifted: the net bay strip hardcoded four slots
 * where `baySlots` is three, and inlined a sixth spelling of the item glyphs that
 * `ui/items.ts` already owns.
 *
 * So the readouts are one component set now, and this is the arithmetic underneath
 * it. Nothing here touches the DOM, which is the point — the pieces most worth
 * pinning are the ones that were silently disagreeing.
 */

/** `MM:SS`, floored, never negative — a clock that has run out reads `00:00`. */
export function formatRunClock(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The bank always shows every bay, so an empty one still reads as a slot.
 *
 * `slots` comes from config at the call site rather than being read here, because the
 * net surface's config arrives with the session and the solo one is the default — and
 * hardcoding it is exactly how the two strips came to disagree.
 */
export function bayStrip(bays: (Item | null)[] | undefined, slots: number): (Item | null)[] {
  return Array.from({ length: Math.max(0, slots) }, (_, index) => bays?.[index] ?? null);
}

/** Enemies still standing — the one number the world genuinely cannot show you. */
export function rivalsAlive(
  bots: readonly { squadId: string; state: string }[] | undefined,
  viewerSquadId: string | undefined,
): number {
  if (!bots || viewerSquadId === undefined) return 0;
  return bots.filter((bot) => bot.squadId !== viewerSquadId && bot.state === "alive").length;
}

/** Who a bot belongs to, however the surface happens to know it. */
export type BotMeta = { squadId?: string; isAmbient?: boolean } | undefined;

/**
 * Downs credited to the viewer's squad, split by whether the victim was a person.
 *
 * The two surfaces resolve a bot's squad differently — one from `map.botSpawns`, the
 * other from the session's entity table — so the lookup is a parameter and the
 * counting rule is shared. It counts `byBotId`, so an unattributed down (a mine with
 * no owner, a fall) is nobody's credit rather than everybody's.
 */
export function squadDownCounts(
  events: readonly SimEvent[],
  metaOf: (botId: string) => BotMeta,
  viewerId: string,
): { ai: number; players: number } {
  const viewerSquadId = metaOf(viewerId)?.squadId;
  let ai = 0;
  let players = 0;

  for (const event of events) {
    if (event.type !== "downed" || !event.byBotId) continue;
    if (metaOf(event.byBotId)?.squadId !== viewerSquadId) continue;
    if (metaOf(event.botId)?.isAmbient) ai += 1;
    else players += 1;
  }

  return { ai, players };
}

export type FloorColumn = {
  building: Building;
  activeFloorId: string;
  /** Top floor first, so the column reads the way the building stands. */
  floors: FloorPlan[];
};

/**
 * Which building you are in and where in its stack, or nothing outdoors.
 *
 * Sorted by `floorHeight` rather than by authoring order: the rail is a picture of a
 * section through the building, so ROOF has to be at the top even when the source
 * lists GROUND first.
 */
export function floorColumn(map: MapDocument, floorId: string, position: Vec2): FloorColumn | null {
  const activePlan = resolvePlan(map, floorId, position);
  if (!activePlan) return null;

  const building = map.buildings.find((candidate) => candidate.id === activePlan.buildingId);
  if (!building) return null;

  return {
    building,
    activeFloorId: activePlan.planId,
    floors: [...building.floors].sort((a, b) => floorHeight(b.label) - floorHeight(a.label)),
  };
}
