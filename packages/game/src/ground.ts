import { polygonContains } from "./geometry";
import { rectContains } from "./mapModel";
import type { MapDocument, SurfaceKind, Vec2 } from "./types";

/**
 * WHAT IS UNDERFOOT at a point, and whether it takes a mark.
 *
 * `water.ts` answers the same shape of question for one kind and explains why the answer
 * belongs in `packages/game` rather than in the renderer: it is a fact about the MAP, and
 * the first consumer that is not cosmetic — footstep audio, a bot preferring a made path,
 * anything that slows a crossing — may not import the client.
 *
 * The renderer asks so it can scuff soft ground under a moving DotBot. Reported while the
 * trails were being built: "movement trails should only appear on surfaces where it makes
 * sense." Which surfaces those are is not a renderer opinion — the map already names every
 * piece of ground by its use, so the honest place for the answer is next to the map.
 */

/**
 * The ground uses, plus the two things that are ground without being a `Surface`.
 *
 * A carriageway is a `Road` rather than a surface kind, and it has to be in this union or
 * every caller has to remember to veto roads itself — which is exactly the bug shape this
 * repo keeps paying for, a consumer asking a narrower question than it needs the answer to.
 */
export type GroundUse = SurfaceKind | "road" | "unmade";

/**
 * Resolved IN DRAWING ORDER, because the drawing order is the authored answer to "which
 * ground wins here".
 *
 * `modelOutdoor` fills the site, then the rect surfaces, then the polygon regions, then cuts
 * the carriageway in over all of it. So the road is asked first, regions before surfaces, and
 * bare site last — read bottom-up, that is the same stack in reverse.
 *
 * AND WITHIN EACH LIST, BACKWARDS. This was wrong in the first version and the map caught it:
 * `drawRegions` fills in array order, so a later region paints over an earlier one, and the
 * ground you can SEE is the last match rather than the first. The temple stacks four regions on
 * one spot — a forest, a plaza, the observatory's own court and a patch of moss — and asking
 * forwards answered `undergrowth` where the sheet plainly shows dressed stone. Trails were
 * being scuffed onto the temple's paving because of it, which is the one thing they must never
 * do. Overlap is deliberate here: `Surface`'s own doc note says a region may lap over a rect
 * surface — weeds through a midway, ballast across a yard — so this is the normal case.
 */
export function groundAt(map: MapDocument, at: Vec2): GroundUse {
  for (const road of map.outdoor.roads) {
    if (rectContains(road, at)) return "road";
  }
  const regions = map.outdoor.regions ?? [];
  for (let i = regions.length - 1; i >= 0; i -= 1) {
    if (polygonContains(regions[i].points, at)) return regions[i].kind;
  }
  const surfaces = map.outdoor.surfaces ?? [];
  for (let i = surfaces.length - 1; i >= 0; i -= 1) {
    if (rectContains(surfaces[i], at)) return surfaces[i].kind;
  }
  return "unmade";
}

/**
 * Ground that keeps an impression of something crossing it.
 *
 * The test is whether the surface has anything loose or living on top to disturb — growth to
 * flatten, earth to scuff, stone to turn over. Everything laid, poured or dressed is out: a
 * DotBot crossing a footway leaves nothing on it, and drawing a smudge there would be a claim
 * about the world that is false.
 *
 * `unmade` is deliberately hard. `auditCity` fails a map for leaving any, so it only ever
 * appears on a broken one, and a mark that only shows up on ground the plan forgot would
 * dress the defect rather than expose it.
 */
const SOFT: ReadonlySet<GroundUse> = new Set<GroundUse>([
  /** Planted setback: growth to flatten. */
  "verge",
  /** Wild vegetation: the same, deeper. */
  "undergrowth",
  /** Bare trodden earth — already a path, and it shows the next crossing too. */
  "clearing",
  /** Crushed stone, sitting loose on a bed: it turns underfoot. */
  "ballast",
]);

export function isSoftGround(use: GroundUse): boolean {
  return SOFT.has(use);
}
