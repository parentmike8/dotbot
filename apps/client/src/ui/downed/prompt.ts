import { canTakeFromBody, withinDownedCoverRange } from "@dotbot/game/interactions";
import { carriedItems } from "@dotbot/game/inventory";
import { distance } from "@dotbot/game/math";
import type { CoverageSnapshot, DotBotEntity, DownedVerb, GameConfig, Item } from "@dotbot/game/types";

/**
 * What the overlay is allowed to say about a downed bot — decided here, drawn
 * elsewhere.
 *
 * The verb strip used to be a permanent titled panel that read STAND ON THE BODY
 * whenever a body was anywhere near, offered both verbs whether or not either was
 * possible, and had a third that no longer exists. Every one of those was the
 * overlay guessing. The rules are the simulation's, so they are read from the
 * simulation's own predicates: `canTakeFromBody` and `withinDownedCoverRange`.
 */

export type PromptConfig = Pick<GameConfig, "coverCenterTolerance" | "holdSlots">;

export type BodyPrompt =
  /** No body within reach, or nothing left for the player to decide. */
  | { kind: "none" }
  /** A rival body underfoot, unsearched. Two verbs, and they are both real. */
  | { kind: "verbs"; bodyId: string; bodyName: string; carriedCount: number }
  /** A channel is running. The ring at the body is the display; this is the label. */
  | { kind: "channel"; verb: DownedVerb; bodyName: string; progress: number }
  /** An open body underfoot. `room` is how many more items the player can carry. */
  | { kind: "picker"; bodyId: string; bodyName: string; items: Item[]; room: number };

export type PromptInput = {
  viewer: DotBotEntity | undefined;
  bots: readonly DotBotEntity[];
  coverages: readonly CoverageSnapshot[];
  config: PromptConfig;
};

/** Free bays plus free hold slots: how many items the player could still take. */
export function holdRoom(viewer: DotBotEntity, holdSlots: number): number {
  const freeBays = viewer.bays.filter((item) => item === null).length;
  return freeBays + Math.max(0, holdSlots - viewer.hold.length);
}

export function bodyPrompt({ viewer, bots, coverages, config }: PromptInput): BodyPrompt {
  if (!viewer || viewer.state !== "alive") return { kind: "none" };

  const nameOf = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? "BODY";

  // A running channel outranks everything: it is already the answer to the choice.
  const channel = coverages.find((coverage) =>
    coverage.actorId === viewer.id && (coverage.kind === "loot" || coverage.kind === "revive"),
  );
  if (channel) {
    return {
      kind: "channel",
      verb: channel.kind as DownedVerb,
      bodyName: nameOf(channel.targetId),
      progress: channel.durationMs > 0 ? Math.min(1, channel.progressMs / channel.durationMs) : 0,
    };
  }

  // Nearest first, so two bodies on the same tile cannot hand the player a prompt
  // for the one further away.
  const reachable = bots
    .filter((bot) => bot.id !== viewer.id && bot.state === "downed" && bot.floorId === viewer.floorId)
    .filter((bot) => withinDownedCoverRange(
      viewer.position, viewer.radius, bot.position, bot.radius, config.coverCenterTolerance,
    ))
    .sort((left, right) => distance(viewer.position, left.position) - distance(viewer.position, right.position));

  for (const body of reachable) {
    // An open body is a picker, whoever opened it.
    if (canTakeFromBody(viewer, body, config.coverCenterTolerance)) {
      return {
        kind: "picker",
        bodyId: body.id,
        bodyName: body.name,
        items: carriedItems(body),
        room: holdRoom(viewer, config.holdSlots),
      };
    }
    // A squadmate's body is not a choice — standing on it picks them up. The
    // progress ring at the body says so without a word of overlay.
    if (body.squadId === viewer.squadId) continue;
    return { kind: "verbs", bodyId: body.id, bodyName: body.name, carriedCount: body.carriedCount };
  }

  return { kind: "none" };
}

/**
 * What the player who is *down* can do.
 *
 * Not revive: that is something a squadmate does by standing on you. The screen
 * used to offer PLEA next to GIVE UP, which named the wrong thing — nothing is
 * given up, because nothing can finish you off. You wait, you plea, or you leave.
 */
export type DownedSelf = {
  /** Somebody is picking you up. Nothing to press. */
  beingRevived: boolean;
  /** Squadmates still standing who could come back for you. */
  rescuers: number;
  /** Whose camera you have; null once nobody is left and it falls to your own body. */
  watching: string | null;
  pleaReady: boolean;
  pleaReadyInMs: number;
};

export function downedSelf(input: {
  viewer: DotBotEntity | undefined;
  bots: readonly DotBotEntity[];
  coverages: readonly CoverageSnapshot[];
  spectating: DotBotEntity | null;
  /** Match clock at the player's last plea, from the authoritative event. */
  lastPleaAtMs: number | null;
  nowMs: number;
  pleaCooldownMs: number;
}): DownedSelf | null {
  const { viewer } = input;
  if (!viewer || viewer.state !== "downed") return null;

  const elapsedMs = input.lastPleaAtMs === null ? Infinity : input.nowMs - input.lastPleaAtMs;
  const pleaReadyInMs = Math.max(0, input.pleaCooldownMs - elapsedMs);
  return {
    beingRevived: input.coverages.some((coverage) => coverage.kind === "revive" && coverage.targetId === viewer.id),
    rescuers: input.bots.filter((bot) =>
      bot.id !== viewer.id && bot.squadId === viewer.squadId && bot.state === "alive",
    ).length,
    watching: input.spectating?.name ?? null,
    pleaReady: pleaReadyInMs <= 0,
    pleaReadyInMs,
  };
}
