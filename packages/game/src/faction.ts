import type { BotFactionKind, BotSpawn } from "./types";

/**
 * Resolve authored faction data with the explicit field as authority.
 *
 * `isAmbient` remains optional for legacy content and wire presentation, but a
 * contradictory legacy flag must never override `faction`.
 */
export function botSpawnFaction(
  spawn: Pick<BotSpawn, "faction" | "isAmbient">,
): BotFactionKind {
  return spawn.faction ?? (spawn.isAmbient ? "ambient" : "squad");
}

export function isAmbientBotSpawn(
  spawn: Pick<BotSpawn, "faction" | "isAmbient">,
): boolean {
  return botSpawnFaction(spawn) === "ambient";
}
