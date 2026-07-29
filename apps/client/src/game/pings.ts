import type { PingKind, SimEvent, Vec2 } from "@dotbot/game/types";

/**
 * Squad marks, held on the client.
 *
 * The simulation emits a `pinged` event and keeps nothing — a mark has no authority, cannot
 * be shot, blocks nothing and decides nothing, so putting it in the world state would be
 * more machinery than it earns. Everything it needs is in the event, so this holds it for a
 * few seconds and forgets it. The trade is that a reconnecting player does not inherit marks
 * placed while they were away, which for something whose entire value is "look here NOW" is
 * the better failure.
 *
 * Pure, so the parts with rules in them — expiry, replacement, which type a bare click
 * sends — are testable without a running match. That matters more than usual here: the
 * interaction is left-click versus right-click versus long-press, and none of those can be
 * exercised in the headless suite.
 */

/**
 * How long a mark lives.
 *
 * Long enough to walk toward, short enough that a mark you find still means something. A
 * stale mark is worse than none: it sends a squadmate to where a rival WAS, confidently.
 */
export const PING_TTL_MS = 9_000;

/** How many marks one squad can have up at once, newest kept. */
export const MAX_LIVE_PINGS = 4;

export type LiveMark = {
  id: string;
  kind: PingKind;
  position: Vec2;
  floorId: string;
  /** Client clock, so age does not depend on the server's tick timeline. */
  placedAtMs: number;
  /** Who put it there, so a mark can name its sender if that ever helps. */
  botId: string;
};

/** Plain words for each kind, in the order the picker shows them. */
export const PING_LABEL: Record<PingKind, string> = {
  here: "Here",
  enemy: "Enemy",
  loot: "Loot",
};

/**
 * Fold this frame's events into the live marks and drop what has expired.
 *
 * Newest-first, and capped by dropping the oldest rather than refusing the newest. A mark
 * you sent and cannot see is a worse outcome than one that pushed an old mark off — the
 * newest is by definition the one carrying current information.
 *
 * Replaces by id rather than appending, because the same event can arrive twice: the input
 * that produced it ships redundantly across datagrams, and a reconnect can replay a frame.
 */
export function collectPings(
  marks: readonly LiveMark[],
  events: readonly SimEvent[],
  nowMs: number,
): LiveMark[] {
  const byId = new Map<string, LiveMark>();
  for (const mark of marks) {
    if (nowMs - mark.placedAtMs < PING_TTL_MS) byId.set(mark.id, mark);
  }
  for (const event of events) {
    if (event.type !== "pinged") continue;
    byId.set(event.pingId, {
      id: event.pingId,
      kind: event.kind,
      position: { ...event.position },
      floorId: event.floorId,
      placedAtMs: nowMs,
      botId: event.botId,
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.placedAtMs - a.placedAtMs)
    .slice(0, MAX_LIVE_PINGS);
}

/** How faded a mark is, 0 fresh to 1 gone. */
export function markAge(mark: LiveMark, nowMs: number): number {
  return Math.max(0, Math.min(1, (nowMs - mark.placedAtMs) / PING_TTL_MS));
}

/**
 * Left-click is ALWAYS "here". Right-click chooses.
 *
 * The first version made left-click repeat whatever you last picked, which is what was asked
 * for and then reconsidered: "i think maybe left click should always be 'here'. Whereas
 * right click allows you to select. Aka don't take the last selected one." The reasoning is
 * good and worth keeping — "'here' is quite a universal indicator so it works well as the
 * default left click" — and a sticky default has a real cost besides: you pick "enemy" once
 * in a fight and then every casual click for the next ten minutes cries wolf.
 *
 * So there is no mutable default any more, which is why this is a constant and not a
 * function. Deleting `chooseKind` was the whole change.
 */
export const CLICK_PING_KIND: PingKind = "here";
