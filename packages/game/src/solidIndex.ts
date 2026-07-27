import { solidBounds } from "./geometry";
import type { Solid, Vec2 } from "./types";

/**
 * A uniform grid over one physics plane's solids.
 *
 * `resolveAgainstSolids` is the hottest loop in the game: it runs three
 * iterations over every solid on the plane, per movement substep, per bot, per
 * tick, on the server *and* again in client prediction. Downtown's outdoor plane
 * carries 214 solids, so that is on the order of 300,000 distance tests a second
 * for a handful of bots that are each within reach of about four things.
 *
 * ## Why this cannot change behaviour
 *
 * Two properties make the narrowed set produce bit-identical results, which
 * matters more here than the speed does — client prediction and the server must
 * agree exactly or the player sees rubber-banding.
 *
 * **Order is preserved.** `resolveAgainstSolids` accumulates a position across
 * solids in array order, so two solids in a corner give a different answer if
 * visited in a different order. `near` therefore returns candidates sorted by
 * their index in the original array, never in grid order.
 *
 * **Omissions are provably no-ops.** `separateCircleFromSolid` returns its input
 * unchanged for any solid further than `radius` away, so dropping a distant solid
 * cannot change the result. The query radius is inflated by `QUERY_SLACK` because
 * the position moves *during* resolution, and `solidIndex.test.ts` proves the
 * equivalence by sampling every plane densely and comparing against the linear
 * scan rather than trusting that argument.
 */

/**
 * How far beyond the bot radius to gather candidates.
 *
 * Resolution walks the circle out of whatever it overlaps, so a solid that is out
 * of range at the query position can come into range a step later. Three radii is
 * far more slack than a single separation can consume, and it still narrows 214
 * solids to a handful.
 */
const QUERY_SLACK = 3;

/** Big enough that most solids land in one or two cells, small enough to filter. */
const DEFAULT_CELL = 128;

export type SolidIndex = {
  /** The plane's solids, in their authored order. */
  readonly all: readonly Solid[];
  /** Solids that could touch a circle at `center`, in the plane's own order. */
  near(center: Vec2, radius: number): readonly Solid[];
};

/** Either works as a source of solids; the array form is the unaccelerated path. */
export type SolidSource = readonly Solid[] | SolidIndex;

export function isSolidIndex(source: SolidSource): source is SolidIndex {
  return !Array.isArray(source);
}

/**
 * Candidates from either source.
 *
 * An array is returned as-is, so every existing caller keeps the exact behaviour
 * it had, and only the hot paths opt in to the index.
 */
export function nearbySolids(source: SolidSource, center: Vec2, radius: number): readonly Solid[] {
  return isSolidIndex(source) ? source.near(center, radius) : source;
}

export function buildSolidIndex(solids: readonly Solid[], cell = DEFAULT_CELL): SolidIndex {
  const buckets = new Map<number, number[]>();
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;

  const key = (col: number, row: number): number => row * 100_003 + col;

  solids.forEach((solid, index) => {
    const bounds = solidBounds(solid);
    const c0 = Math.floor(bounds.x / cell);
    const r0 = Math.floor(bounds.y / cell);
    const c1 = Math.floor((bounds.x + bounds.w) / cell);
    const r1 = Math.floor((bounds.y + bounds.h) / cell);
    minCol = Math.min(minCol, c0);
    minRow = Math.min(minRow, r0);
    maxCol = Math.max(maxCol, c1);
    maxRow = Math.max(maxRow, r1);
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        const at = key(col, row);
        const bucket = buckets.get(at);
        if (bucket) bucket.push(index);
        else buckets.set(at, [index]);
      }
    }
  });

  /**
   * Reused across queries so a hot loop does not allocate a `Set` per call. An
   * epoch stamp marks membership, which is cheaper than clearing the array.
   */
  const stamp = new Int32Array(solids.length);
  let epoch = 0;

  return {
    all: solids,
    near(center: Vec2, radius: number): readonly Solid[] {
      const reach = radius * QUERY_SLACK;
      const c0 = Math.max(minCol, Math.floor((center.x - reach) / cell));
      const r0 = Math.max(minRow, Math.floor((center.y - reach) / cell));
      const c1 = Math.min(maxCol, Math.floor((center.x + reach) / cell));
      const r1 = Math.min(maxRow, Math.floor((center.y + reach) / cell));
      if (c1 < c0 || r1 < r0) return [];

      epoch += 1;
      const found: number[] = [];
      for (let row = r0; row <= r1; row += 1) {
        for (let col = c0; col <= c1; col += 1) {
          const bucket = buckets.get(key(col, row));
          if (!bucket) continue;
          for (const index of bucket) {
            if (stamp[index] === epoch) continue;
            stamp[index] = epoch;
            found.push(index);
          }
        }
      }
      // Back into the plane's own order: resolution is order-dependent.
      found.sort((a, b) => a - b);
      const out: Solid[] = new Array(found.length);
      for (let i = 0; i < found.length; i += 1) out[i] = solids[found[i]];
      return out;
    },
  };
}

/**
 * An index plus a few extra solids that change every tick — the open doors.
 *
 * The extras keep their position *after* the static geometry, which is where they
 * sat when the whole plane was one array, so resolution order is unchanged.
 */
export function withExtraSolids(index: SolidIndex, extra: readonly Solid[]): SolidSource {
  if (extra.length === 0) return index;
  return {
    all: index.all,
    near(center: Vec2, radius: number): readonly Solid[] {
      return [...index.near(center, radius), ...extra];
    },
  };
}
