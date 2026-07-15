import { collectSolidRects } from "./collision";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { InsertionPoint, MapDocument, Vec2 } from "./types";

export type InsertionMemberPreference = {
  playerId: string;
  preference: string | null;
  /** Lower values joined first. Input order breaks equal timestamps. */
  joinedAt?: number;
};

export type InsertionSquad = {
  squadId: string;
  members: InsertionMemberPreference[];
};

export type InsertionAssignment = {
  squadId: string;
  point: InsertionPoint;
  preference: string | null;
};

const MAX_BRUTE_FORCE_POINTS = 10;
const PREFERENCE_HONOR_RATE = 0.8;
const ASSIGNMENT_JITTER = 0.001;

/**
 * Six Downtown points and three squads produce only 120 permutations. Keep
 * this exact search bounded: above ten points a different solver is required.
 */
export function assignSquadInsertions(input: {
  squads: InsertionSquad[];
  points: InsertionPoint[];
  matchId: string;
  minSpacing: number;
}): InsertionAssignment[] {
  const { squads, points, matchId, minSpacing } = input;
  if (points.length > MAX_BRUTE_FORCE_POINTS) {
    throw new Error(`Insertion assignment supports at most ${MAX_BRUTE_FORCE_POINTS} points.`);
  }
  if (points.length < squads.length) throw new Error("Not enough insertion points for active squads.");
  const preferences = new Map(squads.map((squad) => [squad.squadId, squadPreference(squad, points)]));
  let best: { score: number; assignments: InsertionAssignment[] } | null = null;

  const visit = (squadIndex: number, used: Set<string>, chosen: InsertionAssignment[]) => {
    if (squadIndex === squads.length) {
      if (!meetsSpacing(chosen.map((entry) => entry.point.position), minSpacing)) return;
      const signature = chosen.map((entry) => `${entry.squadId}:${entry.point.id}`).join("|");
      let score = hashUnit(`${matchId}|assignment|${signature}`) * ASSIGNMENT_JITTER;
      for (const entry of chosen) {
        if (!entry.preference) continue;
        // A match-seeded 80/20 weight prevents preference from becoming a
        // disguised pick. In the 80 lane a hit is worth +1; in the 20 lane it
        // is worth -1. Tiny assignment jitter resolves all remaining ties.
        const honorsPreference = hashUnit(`${matchId}|preference|${entry.squadId}`) < PREFERENCE_HONOR_RATE;
        if (entry.point.id === entry.preference) score += honorsPreference ? 1 : -1;
      }
      if (!best || score > best.score) best = { score, assignments: chosen.map((entry) => ({ ...entry })) };
      return;
    }

    const squad = squads[squadIndex];
    for (const point of points) {
      if (used.has(point.id)) continue;
      used.add(point.id);
      chosen.push({ squadId: squad.squadId, point, preference: preferences.get(squad.squadId) ?? null });
      visit(squadIndex + 1, used, chosen);
      chosen.pop();
      used.delete(point.id);
    }
  };

  visit(0, new Set(), []);
  if (!best) throw new Error(`No insertion assignment satisfies ${minSpacing}px squad spacing.`);
  return (best as { score: number; assignments: InsertionAssignment[] }).assignments;
}

/** Most votes wins; a tie follows the earliest member who voted for a tied point. */
export function squadPreference(squad: InsertionSquad, points: InsertionPoint[]): string | null {
  const valid = new Set(points.map((point) => point.id));
  const counts = new Map<string, number>();
  const ordered = squad.members
    .map((member, index) => ({ member, index }))
    .sort((left, right) => (left.member.joinedAt ?? left.index) - (right.member.joinedAt ?? right.index) || left.index - right.index);
  for (const { member } of ordered) {
    if (member.preference && valid.has(member.preference)) counts.set(member.preference, (counts.get(member.preference) ?? 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  if (max === 0) return null;
  const tied = new Set([...counts].filter(([, count]) => count === max).map(([pointId]) => pointId));
  return ordered.find(({ member }) => member.preference && tied.has(member.preference))?.member.preference ?? null;
}

export function squadSpawnPosition(point: InsertionPoint, memberIndex: number, botRadius: number): Vec2 {
  const spacing = botRadius * 3;
  const offsets = [{ x: 0, y: 0 }, { x: spacing, y: 0 }, { x: 0, y: spacing }];
  const offset = offsets[memberIndex];
  if (!offset) throw new Error("Insertion points support squads of at most three.");
  return { x: point.position.x + offset.x, y: point.position.y + offset.y };
}

export function validateInsertionMap(map: MapDocument, squadCount: number, botRadius: number): void {
  if (map.insertionPoints.length < squadCount + 2) {
    throw new Error(`Map ${map.id} needs at least squads + 2 insertion points (${squadCount + 2}).`);
  }
  if (new Set(map.insertionPoints.map((point) => point.id)).size !== map.insertionPoints.length) {
    throw new Error(`Map ${map.id} has duplicate insertion point ids.`);
  }
  for (const point of map.insertionPoints) {
    const floorId = point.floorId ?? OUTDOOR_FLOOR_ID;
    const solids = collectSolidRects(map, floorId);
    const positions = [0, 1, 2].map((index) => squadSpawnPosition(point, index, botRadius));
    for (const position of positions) {
      if (position.x < botRadius || position.y < botRadius || position.x > map.width - botRadius || position.y > map.height - botRadius) {
        throw new Error(`Insertion ${point.id} cannot fit a full squad inside map bounds.`);
      }
      if (solids.some((rect) => circleIntersectsRect(position, botRadius, rect))) {
        throw new Error(`Insertion ${point.id} cannot fit a full squad clear of map solids.`);
      }
    }
    if (!meetsSpacing(positions, botRadius * 2)) {
      throw new Error(`Insertion ${point.id} overlaps members of its spawned squad.`);
    }
  }
}

function meetsSpacing(points: Vec2[], minSpacing: number): boolean {
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (Math.hypot(points[left].x - points[right].x, points[left].y - points[right].y) < minSpacing) return false;
    }
  }
  return true;
}

function circleIntersectsRect(center: Vec2, radius: number, rect: { x: number; y: number; w: number; h: number }): boolean {
  const dx = center.x - Math.max(rect.x, Math.min(center.x, rect.x + rect.w));
  const dy = center.y - Math.max(rect.y, Math.min(center.y, rect.y + rect.h));
  return dx * dx + dy * dy < radius * radius;
}

function hashUnit(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}
