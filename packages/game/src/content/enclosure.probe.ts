/**
 * Where is there floor a bot can never stand on?
 *
 * `pnpm --filter @dotbot/game exec tsx src/content/enclosure.probe.ts`  (both maps, 27 floors)
 *
 * This exists because of a fixture the eyes found and no test could. Mercy's exam rooms
 * put the clinician's worktop in the south-west corner with the stool flush beside it,
 * boxed in by the bed to the north: 18 units to the bed, 30 to the corridor wall, 4 to
 * the shell. Nobody can stand next to it. The worktop is furniture you can look at and
 * never use, and the comment above it in mercyClinic.ts records the placement as a fix —
 * it WAS one, for circulation. Sliding the stool flush opened the room and stranded the
 * thing the stool belongs to. Every audit stayed silent, and silent correctly:
 *
 *  - `disconnected-area` needs a stranded region of standable floor. There is none here:
 *    the room is fully connected, it is the fixture that is out of reach.
 *  - `dot-unreachable` needs a Dot on it. Neither cabinet is scannable.
 *  - `wedged-fixture` exempts a seam at a run's END, which is exactly where the stool is.
 *
 * So the failure is a fixture that was DESIGNED to be used and cannot be, and the only
 * reason to care is that a person drew it. No threshold finds that.
 *
 * (The first version of this comment claimed Mercy F1's staff WC was sealed — a 44-unit
 * lane between basin and pan against a 48-unit bot. That arithmetic forgot the doorway:
 * a door removes its wall, so a bot standing in the opening reaches well into the room.
 * The probe disagreed with me and the probe was right, which is the argument for having
 * built it rather than reasoning about clearances in my head.)
 *
 * WHAT THIS PRINTS, and what it deliberately does not: connected components of standable
 * space per floor, with area and bounds, plus the floor area that belongs to no component
 * at all. It renders no verdict. A floor that should read as one space showing three
 * components is a place to LOOK; a designed room absent from the list is a place to look
 * harder. The judgement is made by looking at `tmp/lab/map-floor-*.png` at the printed
 * coordinates, which is the whole point — see §4.1 of the map-building contract.
 *
 * Two metrics have already been built for this pass and thrown away for scoring taste
 * instead of measuring fact (a nearest-wall-gap band that held 23% of all gaps, and a
 * route-margin rank that compared against the wrong door). This one reports geometry
 * only: can a disc of radius r sit here, and what is contiguous with what.
 */
import { defaultGameConfig } from "../config";
import { collectSolids } from "../collision";
import { pointToSolidDistanceSquared, polygonContains, rectSolid } from "../geometry";
import { downtownMap } from "./downtown";
import { physicsFloorId } from "../mapModel";
import type { MapDocument, Rect, Solid, Vec2 } from "../types";
import { worldMap } from "./world";

const STEP = 8; // finer than a bot by 6x, so a 44-unit lane cannot hide between samples
const RADIUS = defaultGameConfig.botRadius;

type Component = { cells: number; area: number; bounds: Rect };

/** Standable means a bot's disc fits here, which is the only definition that matters. */
function standable(solids: ReturnType<typeof collectSolids>, at: Vec2): boolean {
  const r2 = RADIUS * RADIUS;
  for (const solid of solids) {
    if (pointToSolidDistanceSquared(at, solid) < r2) return false;
  }
  return true;
}

function componentsOf(
  map: MapDocument,
  floorId: string,
  bounds: Rect,
  outline: Vec2[] | null,
): { components: Component[]; free: Uint8Array; cols: number; rows: number; floorCells: number; standableCells: number } {
  const solids = collectSolids(map, floorId);
  const cols = Math.ceil(bounds.w / STEP);
  const rows = Math.ceil(bounds.h / STEP);
  const at = (index: number): Vec2 => ({
    x: bounds.x + (index % cols) * STEP + STEP / 2,
    y: bounds.y + Math.floor(index / cols) * STEP + STEP / 2,
  });

  const onFloor = new Uint8Array(cols * rows);
  const free = new Uint8Array(cols * rows);
  for (let index = 0; index < cols * rows; index += 1) {
    const point = at(index);
    if (outline && !polygonContains(outline, point)) continue;
    onFloor[index] = 1;
    if (standable(solids, point)) free[index] = 1;
  }

  const seen = new Uint8Array(cols * rows);
  const components: Component[] = [];
  for (let seed = 0; seed < cols * rows; seed += 1) {
    if (!free[seed] || seen[seed]) continue;
    const stack = [seed];
    seen[seed] = 1;
    let cells = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    while (stack.length) {
      const index = stack.pop() as number;
      cells += 1;
      const point = at(index);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      const col = index % cols;
      const row = Math.floor(index / cols);
      const neighbours = [
        col > 0 ? index - 1 : -1,
        col < cols - 1 ? index + 1 : -1,
        row > 0 ? index - cols : -1,
        row < rows - 1 ? index + cols : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || seen[next] || !free[next]) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    components.push({
      cells,
      area: cells * STEP * STEP,
      bounds: { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) },
    });
  }

  components.sort((a, b) => b.area - a.area);
  return {
    components,
    free,
    cols,
    rows,
    floorCells: onFloor.reduce((n, v) => n + v, 0),
    standableCells: free.reduce((n, v) => n + v, 0),
  };
}

/**
 * Can a bot get its body next to this thing?
 *
 * The positive form of the WC finding. A sealed room shows up in the component list only
 * by ABSENCE — nothing to see, which is the hardest kind of report to read across 27
 * floors. A fixture nobody can stand beside is the same fact stated as a presence, and
 * it names the room for you.
 *
 * Reach is `RADIUS + STEP`: a bot's centre has to come within its own radius plus one
 * sample of the object's box, which is as close as this grid can honestly resolve. It
 * asks nothing about whether reaching it is USEFUL — that is a design question, and the
 * answer to a design question is a render, not a number.
 */
function unreachableFixtures(
  map: MapDocument,
  floorId: string,
  bounds: Rect,
  free: Uint8Array,
  cols: number,
  rows: number,
  objects: readonly { id: string; kind: string; x: number; y: number; w: number; h: number }[],
): string[] {
  const reach = RADIUS + STEP;
  const dead: string[] = [];
  /**
   * A fixture wholly inside another is one physical thing, and mapQuality already says so —
   * "a sink in a worktop, a coffee machine standing on a counter: one physical thing, and the
   * host already blocks that space". Beacon's kitchen sink sits inside its worktop, and this
   * check reported it as unreachable: correct about the sink's own rect, and about nothing.
   * You reach the worktop.
   */
  const contained = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
    a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  for (const object of objects) {
    if (objects.some((host) => host !== object && contained(object, host))) continue;
    const lowCol = Math.max(0, Math.floor((object.x - reach - bounds.x) / STEP));
    const highCol = Math.min(cols - 1, Math.ceil((object.x + object.w + reach - bounds.x) / STEP));
    const lowRow = Math.max(0, Math.floor((object.y - reach - bounds.y) / STEP));
    const highRow = Math.min(rows - 1, Math.ceil((object.y + object.h + reach - bounds.y) / STEP));
    let touched = false;
    for (let row = lowRow; row <= highRow && !touched; row += 1) {
      for (let col = lowCol; col <= highCol; col += 1) {
        if (!free[row * cols + col]) continue;
        const px = bounds.x + col * STEP + STEP / 2;
        const py = bounds.y + row * STEP + STEP / 2;
        const dx = Math.max(object.x - px, 0, px - (object.x + object.w));
        const dy = Math.max(object.y - py, 0, py - (object.y + object.h));
        if (dx * dx + dy * dy <= reach * reach) { touched = true; break; }
      }
    }
    if (!touched) dead.push(`${object.id} (${object.kind}) at ${object.x},${object.y}`);
  }
  return dead;
}

/**
 * Fixtures standing inside a wall.
 *
 * `solid-overlap` in mapQuality only fires when BOTH sides are objects — the guard is
 * literally `left.ownerKind === "object" && right.ownerKind === "object"` — so a fixture
 * buried in a partition has always been invisible to it. Found by eye on Mercy F1, where
 * the crash cart sat astride the stair core's north wall with a third of itself in the
 * shaft, and it looks exactly as wrong as it sounds once you zoom in on it.
 *
 * A rect-vs-solid overlap test, not rect-vs-rect: partitions compile to capsules whose end
 * caps reach half a thickness past each endpoint, and that overhang is where this hides.
 */
function fixturesInWalls(
  wallSolids: readonly Solid[],
  objects: readonly { id: string; kind: string; x: number; y: number; w: number; h: number }[],
): string[] {
  const buried: string[] = [];
  const INSET = 2;
  for (const object of objects) {
    /**
     * Sampled INSET units inside the object's own edge, which is the whole difference
     * between this finding and noise. A fixture sitting flush against a wall touches it,
     * and a touching point has distance zero to the wall's area — so the first version of
     * this check reported 29 fixtures across Downtown, most of them things deliberately
     * pushed against a wall two edits ago. Inset, it reports only fixtures that are
     * genuinely standing in the wall's body.
     *
     * Corners plus edge midpoints: a thin partition can slice a wide fixture through the
     * middle without touching a single corner of it.
     */
    if (object.w <= INSET * 2 || object.h <= INSET * 2) continue;
    const xs = [object.x + INSET, object.x + object.w / 2, object.x + object.w - INSET];
    const ys = [object.y + INSET, object.y + object.h / 2, object.y + object.h - INSET];
    const points: Vec2[] = xs.flatMap((x) => ys.map((y) => ({ x, y })));
    for (const solid of wallSolids) {
      if (!points.some((point) => pointToSolidDistanceSquared(point, solid) <= 0)) continue;
      buried.push(`${object.id} (${object.kind}) at ${object.x},${object.y} ${object.w}x${object.h}`);
      break;
    }
  }
  return buried;
}

// Both maps, every run. This package typechecks without node types, so there is no
// `process.argv` to read a selector from — and the two together are 27 floors, which is the
// whole world and the only useful scope for a sweep anyway.
const lines: string[] = [];
for (const map of [downtownMap, worldMap]) {
  lines.push(`=== ${map.name} — standable components at radius ${RADIUS}, step ${STEP} ===`);
  for (const building of map.buildings) {
    for (const floor of building.floors) {
      const bounds = floor.bounds ?? building.footprint;
      // GROUND plans share the outdoor plane, so their solids include the whole street;
      // clip to the floor's own outline or every interior reads as one giant component.
      const outline = floor.outline ?? null;
      const { components, free, cols, rows, floorCells, standableCells } =
        componentsOf(map, floor.id, bounds, outline);
      const dead = floorCells - standableCells;
      const stranded = unreachableFixtures(map, floor.id, bounds, free, cols, rows, floor.objects);
      const wallSolids = [
        ...(floor.barriers ?? []).flatMap((barrier) => barrier.solids),
        ...floor.walls.map((wall) => rectSolid(wall)),
      ];
      const buried = fixturesInWalls(wallSolids, floor.objects);
      lines.push("");
      lines.push(`${building.id}:${floor.label}  bounds ${bounds.w}x${bounds.h}`
        + `  floor ${floorCells} cells  standable ${standableCells}`
        + `  unstandable ${dead} (${Math.round((dead / Math.max(floorCells, 1)) * 100)}%)`);
      for (const [index, component] of components.entries()) {
        const flag = index === 0 ? "main" : "ISLAND";
        lines.push(`   ${flag} area ${component.area}`
          + `  at ${component.bounds.x},${component.bounds.y} ${component.bounds.w}x${component.bounds.h}`);
      }
      if (!components.length) lines.push("   NO STANDABLE FLOOR AT ALL");
      for (const entry of stranded) lines.push(`   NOBODY CAN STAND BESIDE ${entry}`);
      for (const entry of buried) lines.push(`   INSIDE A WALL ${entry}`);
    }
  }
  lines.push("");
}

// eslint-disable-next-line no-console
console.log(lines.join("\n"));
