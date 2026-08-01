import {
  PUBLIC_EXTRACTION_ROLE_COUNT,
  PUBLIC_EXTRACTION_SQUADS,
  type PlayerRole,
  type PublicExtractionSquadId,
} from "@dotbot/protocol";

export type PublicHuman = {
  playerId: string;
  name: string;
  partyId: string;
};

/**
 * Deterministic launch-role assignment. Parties are atomic bins of at most
 * three; each goes into the least-populated squad that can hold it. Empty
 * roles are explicit player-role AI, not ambient map AI.
 */
export function assignPublicPlayerRoles(humans: readonly PublicHuman[], matchId: string): PlayerRole[] {
  if (humans.length > PUBLIC_EXTRACTION_ROLE_COUNT) throw new Error("A public arena supports at most 18 humans.");
  const parties = new Map<string, PublicHuman[]>();
  for (const human of humans) {
    const party = parties.get(human.partyId) ?? [];
    party.push(human);
    parties.set(human.partyId, party);
  }
  if ([...parties.values()].some((party) => party.length > 3)) throw new Error("A public quick-play party cannot exceed three humans.");

  const squadHumans = new Map<PublicExtractionSquadId, PublicHuman[]>(
    PUBLIC_EXTRACTION_SQUADS.map((squadId) => [squadId, []]),
  );
  const orderedParties = [...parties.entries()]
    .map(([partyId, members], index) => ({ partyId, members, index }))
    .sort((left, right) => right.members.length - left.members.length || left.index - right.index || left.partyId.localeCompare(right.partyId));
  for (const party of orderedParties) {
    const target = [...PUBLIC_EXTRACTION_SQUADS]
      .filter((squadId) => squadHumans.get(squadId)!.length + party.members.length <= 3)
      .sort((left, right) => squadHumans.get(left)!.length - squadHumans.get(right)!.length
        || PUBLIC_EXTRACTION_SQUADS.indexOf(left) - PUBLIC_EXTRACTION_SQUADS.indexOf(right))[0];
    if (!target) throw new Error("Party-preserving assignment could not fit the public arena.");
    squadHumans.get(target)!.push(...party.members);
  }

  const seed = matchId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "run";
  return PUBLIC_EXTRACTION_SQUADS.flatMap((squadId) => {
    const members = squadHumans.get(squadId)!;
    return Array.from({ length: 3 }, (_, slot): PlayerRole => {
      const human = members[slot];
      if (human) {
        return {
          roleId: `human-${human.playerId}`,
          squadId,
          slot: slot as 0 | 1 | 2,
          controller: "human",
          name: human.name,
          playerId: human.playerId,
          partyId: human.partyId,
        };
      }
      return {
        roleId: `player-ai-${seed}-${squadId}-${slot + 1}`,
        squadId,
        slot: slot as 0 | 1 | 2,
        controller: "ai",
        name: `AI Rival ${PUBLIC_EXTRACTION_SQUADS.indexOf(squadId) * 3 + slot + 1}`,
      };
    });
  });
}
