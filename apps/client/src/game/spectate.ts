export function selectSpectatedBot<T extends { id: string }>(
  livingSquadmates: readonly T[],
  currentId: string | null,
  cycle: boolean,
): T | null {
  if (livingSquadmates.length === 0) return null;
  const current = livingSquadmates.find((bot) => bot.id === currentId) ?? livingSquadmates[0];
  if (!cycle) return current;
  const index = livingSquadmates.findIndex((bot) => bot.id === current.id);
  return livingSquadmates[(index + 1) % livingSquadmates.length];
}
