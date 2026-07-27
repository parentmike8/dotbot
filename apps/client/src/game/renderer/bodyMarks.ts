/**
 * Where the marks on a downed body go.
 *
 * Pixi-free on purpose, like `model/prism.ts`: the arithmetic that decides whether
 * a fan of ticks reads as centred, or a ring reads as broken, is the part that can
 * be wrong in a way a screenshot only hints at.
 */

/** Straight up. Screen y grows downward, so north is negative. */
export const NORTH = -Math.PI / 2;

/** Widest fan the carry ticks may open to, and the spacing they prefer. */
const CARRY_SPAN = Math.PI * 0.62;
const CARRY_STEP = Math.PI * 0.085;

/**
 * One angle per carried item, fanned across the body's north arc and centred on
 * north — so a body with one item left and a body with six read as the same mark
 * getting shorter, not as two different marks.
 *
 * The fan tightens rather than widening past `CARRY_SPAN`: a full hold has to stay
 * inside the north arc, or the ticks run into the ring's own gaps.
 */
export function carryTickAngles(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [NORTH];
  const step = Math.min(CARRY_STEP, CARRY_SPAN / (count - 1));
  const start = NORTH - (step * (count - 1)) / 2;
  return Array.from({ length: count }, (_, index) => start + index * step);
}

/**
 * The footprint ring, broken into arcs.
 *
 * A downed body is walkable — bots pass straight over it — and the contract is
 * blunt about what a closed dark outline promises: solid. So the ring that says
 * "a body is lying here" is drawn open, and the gaps are the part that carries the
 * meaning.
 *
 * The breaks are east, south and west. North stays whole because that is where the
 * body's contents are written, and a gap under the carry fan would read as a
 * missing tick rather than as an opening.
 */
export function brokenRingArcs(gapSpan = Math.PI * 0.16): Array<[number, number]> {
  const gapCenters = [0, Math.PI * 0.5, Math.PI];
  const arcs: Array<[number, number]> = [];
  for (let index = 0; index < gapCenters.length; index += 1) {
    const from = gapCenters[index] + gapSpan / 2;
    const to = gapCenters[(index + 1) % gapCenters.length] - gapSpan / 2;
    arcs.push([from, to < from ? to + Math.PI * 2 : to]);
  }
  return arcs;
}
