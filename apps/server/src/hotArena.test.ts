import { describe, expect, it } from "vitest";
import { PUBLIC_EXTRACTION_SQUADS } from "@dotbot/protocol";
import { assignPublicPlayerRoles } from "./hotArena";

describe("public hot-arena role assignment", () => {
  it("keeps parties together and fills all six squads of three with labelled roles", () => {
    const roles = assignPublicPlayerRoles([
      { playerId: "a", name: "A", partyId: "friends" },
      { playerId: "b", name: "B", partyId: "friends" },
      { playerId: "c", name: "C", partyId: "solo-c" },
      { playerId: "d", name: "D", partyId: "solo-d" },
    ], "00000000-0000-4000-8000-000000000001");

    expect(roles).toHaveLength(18);
    for (const squadId of PUBLIC_EXTRACTION_SQUADS) {
      expect(roles.filter((role) => role.squadId === squadId)).toHaveLength(3);
    }
    expect(roles.filter((role) => role.controller === "human")).toHaveLength(4);
    expect(roles.filter((role) => role.controller === "ai")).toHaveLength(14);
    const friends = roles.filter((role) => role.partyId === "friends");
    expect(new Set(friends.map((role) => role.squadId))).toHaveLength(1);
    expect(roles.every((role) => role.roleId && Number.isInteger(role.slot))).toBe(true);
  });

  it("rejects parties larger than three instead of splitting them", () => {
    expect(() => assignPublicPlayerRoles([
      { playerId: "a", name: "A", partyId: "oversized" },
      { playerId: "b", name: "B", partyId: "oversized" },
      { playerId: "c", name: "C", partyId: "oversized" },
      { playerId: "d", name: "D", partyId: "oversized" },
    ], "00000000-0000-4000-8000-000000000002")).toThrow(/party.*three/i);
  });

  it("packs every feasible mix and rejects every impossible party composition", () => {
    for (let threes = 0; threes <= 6; threes += 1) {
      for (let twos = 0; twos <= 9; twos += 1) {
        for (let ones = 0; ones <= 18; ones += 1) {
          if (threes * 3 + twos * 2 + ones > 18) continue;
          const sizes = [...Array(threes).fill(3), ...Array(twos).fill(2), ...Array(ones).fill(1)] as number[];
          const humans = sizes.flatMap((size, partyIndex) => Array.from({ length: size }, (_, memberIndex) => ({
            playerId: `p-${partyIndex}-${memberIndex}`,
            name: `P${partyIndex}-${memberIndex}`,
            partyId: `party-${partyIndex}`,
          })));
          if (!canPack(sizes)) {
            expect(() => assignPublicPlayerRoles(humans, `mix-${threes}-${twos}-${ones}`)).toThrow(/could not fit/i);
            continue;
          }
          const roles = assignPublicPlayerRoles(humans, `mix-${threes}-${twos}-${ones}`);
          expect(roles).toHaveLength(18);
          for (const partyId of new Set(humans.map((human) => human.partyId))) {
            expect(new Set(roles.filter((role) => role.partyId === partyId).map((role) => role.squadId))).toHaveLength(1);
          }
        }
      }
    }
  });
});

function canPack(sizes: readonly number[], capacities = [3, 3, 3, 3, 3, 3]): boolean {
  if (sizes.length === 0) return true;
  const [size, ...rest] = [...sizes].sort((left, right) => right - left);
  const tried = new Set<number>();
  for (let index = 0; index < capacities.length; index += 1) {
    if (capacities[index] < size || tried.has(capacities[index])) continue;
    tried.add(capacities[index]);
    const next = [...capacities];
    next[index] -= size;
    if (canPack(rest, next)) return true;
  }
  return false;
}
