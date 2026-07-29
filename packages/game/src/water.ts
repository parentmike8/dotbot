import { polygonContains } from "./geometry";
import { rectContains } from "./mapModel";
import type { MapDocument, Vec2 } from "./types";

/**
 * Whether a point is standing in open water.
 *
 * In `packages/game` rather than in the renderer, even though today only the renderer
 * asks. Two reasons, and the second is the one that decides it:
 *
 *  - it is a fact about the MAP, and the map lives here;
 *  - the moment wading slows a bot down it becomes simulation, and simulation may not
 *    import the client. `docs/world-motion.md` draws that line: ambient motion is a pure
 *    function of the client clock and never replicated, traversal motion moves a DotBot
 *    and has to be deterministic on the server. Putting the query where the second kind
 *    can reach it costs nothing now and is the difference between adding a rule later and
 *    moving a file later.
 *
 * Water can be authored either way round — a rect `Surface` for something laid out, a
 * polygon `GroundRegion` for something that was never laid out at all — so both count. The
 * regions are checked first because they are drawn last, and the drawing order is the
 * authored answer to "which ground wins here".
 */
export function isInWater(map: MapDocument, at: Vec2): boolean {
  for (const region of map.outdoor.regions ?? []) {
    if (region.kind === "water" && polygonContains(region.points, at)) return true;
  }
  for (const surface of map.outdoor.surfaces ?? []) {
    if (surface.kind === "water" && rectContains(surface, at)) return true;
  }
  return false;
}

/** Every water body on the map, as its own closed ring. */
export function waterBodies(map: MapDocument): Array<{ id: string; points: Vec2[] }> {
  const bodies: Array<{ id: string; points: Vec2[] }> = [];
  for (const surface of map.outdoor.surfaces ?? []) {
    if (surface.kind !== "water") continue;
    const { x, y, w, h } = surface;
    bodies.push({
      id: surface.id,
      points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
    });
  }
  for (const region of map.outdoor.regions ?? []) {
    if (region.kind === "water") bodies.push({ id: region.id, points: region.points });
  }
  return bodies;
}
