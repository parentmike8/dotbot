/**
 * Directional shield geometry, shared by the simulation (hit resolution) and
 * the renderer (arc drawing) so what you see is exactly what gets hit.
 *
 * A bot's shields are ablative plates: `maxShields` arcs spaced evenly around
 * the body, anchored to the bot's facing, with plate 0 centered dead ahead.
 * Each plate is 1 (intact), 0.5 (cracked), or 0 (broken).
 *
 * Damage model: a qualifying hit landing ON a live plate shatters it outright;
 * a hit landing on bare body (a gap, or a broken plate's zone) rattles the
 * frame and cracks the nearest surviving plate by half. No posture grants
 * immunity — angling plates away from a threat halves damage, never voids it.
 *
 * After every hit the surviving plating re-seats best-first, so the strongest
 * plate always leads the direction of travel and the weakest trails. Players
 * steer their protection purely by moving: face a threat to block with your
 * best plate, turn away to protect it.
 */

/** Angular gap between adjacent plates, in radians. */
export const SHIELD_ARC_GAP = 0.24;

const TWO_PI = Math.PI * 2;

/** Normalize an angle to [-PI, PI). */
export function normalizeAngle(angle: number): number {
  const wrapped = ((angle + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
  return wrapped - Math.PI;
}

/** Angular width of one plate. */
export function shieldArcSpan(maxShields: number): number {
  return TWO_PI / maxShields - SHIELD_ARC_GAP;
}

/** Start angle of plate `index` for a bot facing `facing`. */
export function shieldArcStart(facing: number, index: number, maxShields: number): number {
  return facing + (index * TWO_PI) / maxShields - shieldArcSpan(maxShields) / 2;
}

/**
 * Which plate's angular zone the impact direction falls in, or null for bare
 * body (a gap between plates). `impactAngle` points from the bot toward
 * where the hit came from.
 */
export function shieldZoneAt(facing: number, maxShields: number, impactAngle: number): number | null {
  const halfSpan = shieldArcSpan(maxShields) / 2;
  const delta = normalizeAngle(impactAngle - facing);

  for (let index = 0; index < maxShields; index += 1) {
    const center = normalizeAngle((index * TWO_PI) / maxShields);

    if (Math.abs(normalizeAngle(delta - center)) <= halfSpan) {
      return index;
    }
  }

  return null;
}

/** The surviving plate angularly nearest to the impact, or null if none live. */
export function nearestLivePlate(facing: number, segments: number[], impactAngle: number): number | null {
  const delta = normalizeAngle(impactAngle - facing);
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] <= 0) {
      continue;
    }

    const center = normalizeAngle((index * TWO_PI) / segments.length);
    const distance = Math.abs(normalizeAngle(delta - center));

    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  return best;
}

/** Fresh plate array with the first `count` plates intact. */
export function platesForCount(maxShields: number, count: number): number[] {
  return Array.from({ length: maxShields }, (_, index) => (index < count ? 1 : 0));
}

export function plateSum(segments: number[]): number {
  return segments.reduce((total, value) => total + value, 0);
}

export type ShieldHit = {
  /** Position that absorbed the damage (pre-re-seat). Null when none survive. */
  plate: number | null;
  /** True when the hit shattered a plate outright (landed on it). */
  direct: boolean;
};

/** Re-seat plates best-first so the strongest always leads the facing. */
export function reseatPlates(segments: number[]): void {
  segments.sort((a, b) => b - a);
}

/**
 * Apply one qualifying hit to a plate array, mutating it. The surviving
 * plating re-seats best-first afterward. Returns what happened so callers
 * can drive effects/telemetry.
 */
export function applyShieldHit(facing: number, segments: number[], impactAngle: number): ShieldHit {
  const zone = shieldZoneAt(facing, segments.length, impactAngle);

  if (zone !== null && segments[zone] > 0) {
    segments[zone] = 0;
    reseatPlates(segments);
    return { plate: zone, direct: true };
  }

  const nearest = nearestLivePlate(facing, segments, impactAngle);

  if (nearest !== null) {
    segments[nearest] = Math.max(0, segments[nearest] - 0.5);
  }

  reseatPlates(segments);
  return { plate: nearest, direct: false };
}
