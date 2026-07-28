/**
 * Directional shield geometry, shared by the simulation (hit resolution) and
 * the renderer (arc drawing) so what you see is exactly what gets hit.
 *
 * A bot's shields are ablative plates: `maxShields` arcs spaced evenly around
 * the body, anchored to the bot's facing, with plate 0 centered dead ahead.
 * Each plate is 1 (intact), 0.5 (cracked), or 0 (broken).
 *
 * Damage model: every hit lands in exactly one plate's arc. A live plate takes it
 * and breaks. A plate that has already broken is not there any more, so the hit
 * reaches the core — and a hit on the core puts the bot down, however many plates
 * are still standing elsewhere.
 *
 * Losing your plates is therefore not the same as going down. A bot with nothing
 * left is naked and one hit from anywhere ends it, but it can still run, still
 * extract, and still be saved. And a bot with two good plates can be dropped by
 * one hit through the arc where its third used to be: hard to land, and meant to
 * be — it is the closest thing this game has to a headshot.
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

/**
 * Which plate's arc this impact belongs to — seams included.
 *
 * `shieldZoneAt` returns null between plates, and those gaps are a drawing seam
 * rather than a hole in the armour. Under the core rule that distinction stops
 * being cosmetic: treating a seam as bare body would let a fully plated bot be
 * dropped through fourteen degrees of nothing. A seam belongs to its nearer plate.
 */
export function coveringPlate(facing: number, maxShields: number, impactAngle: number): number {
  const delta = normalizeAngle(impactAngle - facing);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < maxShields; index += 1) {
    const center = normalizeAngle((index * TWO_PI) / maxShields);
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

export type ArmourHit = {
  /** The plate whose arc the hit landed in, before any re-seat. */
  plate: number;
  /** That arc was already broken, so the hit reached the core. */
  core: boolean;
};

/** Re-seat plates best-first so the strongest always leads the facing. */
export function reseatPlates(segments: number[]): void {
  segments.sort((a, b) => b - a);
}

/** Restore one plate's worth of protection without exceeding capacity. */
export function restoreShieldPlate(segments: number[]): void {
  let remaining = 1;
  for (let index = 0; index < segments.length && remaining > 0; index += 1) {
    const restored = Math.min(1 - segments[index], remaining);
    segments[index] += restored;
    remaining -= restored;
  }
  reseatPlates(segments);
}

/**
 * Apply one qualifying hit, mutating the plate array. The surviving plating
 * re-seats best-first afterward, so a broken arc drifts to the back of a bot that
 * keeps moving toward the threat — which is what makes facing a defence and makes
 * running away expose the side you cannot afford to show.
 *
 * A core hit changes nothing here. There is nothing left in that arc to damage;
 * the caller puts the bot down.
 */
export function applyArmourHit(facing: number, segments: number[], impactAngle: number): ArmourHit {
  const plate = coveringPlate(facing, segments.length, impactAngle);

  if (segments[plate] <= 0) {
    return { plate, core: true };
  }

  segments[plate] = 0;
  reseatPlates(segments);
  return { plate, core: false };
}
