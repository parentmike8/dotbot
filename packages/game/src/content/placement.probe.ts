/**
 * How much room a route actually has.
 *
 * `pnpm --filter @dotbot/game exec tsx src/content/placement.probe.ts [buildingId]`
 *
 * Every existing check asks CAN A BOT FIT, which is a yes-or-no question, and passing it by
 * nothing is still passing. That is the gap this measures. Reported from play: "some rooms
 * just don't look like they're clearly well thought out. They don't look like they would
 * necessarily be designed by a human who is placing things around the room for reasons of
 * ease of access and mobility."
 *
 * WHAT THE REAL DEFECTS HAD IN COMMON. Four placement bugs were found by walking into them
 * and each was fixed alone: a lamp post dead centre in a small park leaving 3 units, a sign
 * 50 units in front of a building's only door leaving a 2-unit standable band, a boulder
 * inside a stair's entry half, a drafting table clearing an instrument by exactly 48 units —
 * one bot's width, zero slack. Not one of them is about how a room looks. All four are the
 * same thing: A ROUTE THE PLAYER NEEDS, PASSABLE BY NOTHING.
 *
 * A REJECTED FIRST ATTEMPT, kept here because the reasoning matters more than the result.
 * This probe originally measured the DEAD GAP — floor left between an object and a wall too
 * narrow for a bot to enter — on the theory that nobody slides a bench against a wall and
 * stops 20 units short. It found 291 of them across 25 floors, and the histogram it printed
 * is what killed the idea: the dead band holds 23% of every gap in the world, and its
 * entries are things like a bed 12 units off a wall. A bot is 48 units across, so 12 units
 * is the space behind a headboard. Real rooms are full of them. The rule measured a proxy
 * for care and would have justified a mechanical sweep making the world LESS natural. The
 * histogram is still printed below, as information; it is no longer a verdict.
 *
 * HOW MARGIN IS MEASURED. `findNavigationPath` is the authority on whether a bot can walk
 * somewhere — that was settled when a hand-rolled flood produced two false positives the
 * navigator disagreed with. So rather than build a second flood, this asks the navigator the
 * same question at growing radii and binary-searches the largest bot that still gets there.
 * The margin is how much fatter than a real bot that is. Zero means the route exists because
 * the bot is exactly the size it is.
 *
 * Diagnostic only. `mapValidation.test.ts` asserts the ledger.
 */
import { findNavigationPath } from "../navigation";
import { objectCollisionRects, physicsFloorId } from "../mapModel";
import { solidBounds } from "../geometry";
import { defaultGameConfig } from "../config";
import { worldMap } from "./world";
import type { Building, FloorPlan, Rect, Solid, Vec2 } from "../types";

const RADIUS = defaultGameConfig.botRadius;

/**
 * Margin below which a route is reported.
 *
 * 6 units, a quarter of a bot's radius. Not a comfort standard — a corridor is allowed to be
 * tight, and a dungeon should be. It is the band where the route survives on arithmetic
 * rather than intent, so any later edit to either side of it severs the route and the author
 * gets a connectivity failure with no clue that the margin was one unit to begin with.
 */
const TIGHT = 6;

/** How much fatter than a bot the search will try before it stops caring. */
const GENEROUS = RADIUS * 2;

const only = (globalThis as { process?: { argv: string[] } }).process?.argv[2];

/** Wall rects on a floor. They live in `barriers`; `floor.walls` is empty on all 27 floors. */
function wallRects(floor: FloorPlan): Rect[] {
  const rects: Rect[] = [];
  for (const barrier of floor.barriers ?? []) {
    for (const solid of barrier.solids) {
      if (solid.kind === "rect") rects.push({ x: solid.x, y: solid.y, w: solid.w, h: solid.h });
      else if (solid.kind === "capsule" && (solid.ax === solid.bx || solid.ay === solid.by)) {
        rects.push(solidBounds(solid));
      }
    }
  }
  return rects;
}

/**
 * Where a bot stands when it has just come through a door, on the inside.
 *
 * A doorway's own centre is IN the wall, which is not a navigable point, so probing from it
 * reports every route on every floor as impassable. Stepping in by a bot's diameter along
 * the wall's normal lands in the room.
 */
function insideOf(floor: FloorPlan, door: { x: number; y: number; dir: "h" | "v" }): Vec2[] {
  const step = RADIUS * 2;
  const box = floor.bounds;
  const candidates: Vec2[] = door.dir === "h"
    ? [{ x: door.x, y: door.y + step }, { x: door.x, y: door.y - step }]
    : [{ x: door.x + step, y: door.y }, { x: door.x - step, y: door.y }];
  if (!box) return candidates;
  // Prefer the side that is inside the floor's own extent.
  return candidates.sort((a, b) => Number(!contains(box, a)) - Number(!contains(box, b)));
}

function contains(box: Rect, at: Vec2): boolean {
  return at.x >= box.x && at.x <= box.x + box.w && at.y >= box.y && at.y <= box.y + box.h;
}

/** The largest bot that can still walk from `start` to `goal`, to within a unit. */
function widestBot(map: typeof worldMap, floorId: string, start: Vec2, goal: Vec2): number {
  if (!findNavigationPath(map, floorId, start, goal, RADIUS).length) return 0;
  let low = RADIUS;
  let high = GENEROUS;
  while (high - low > 1) {
    const mid = (low + high) / 2;
    if (findNavigationPath(map, floorId, start, goal, mid).length) low = mid;
    else high = mid;
  }
  return low;
}

/** `limit` is what the route's own entrance allows, which is what `margin` is judged against. */
type Route = { floor: string; from: string; to: string; margin: number; limit: number };

const routes: Route[] = [];
const unreachable: Route[] = [];
const badProbe: Route[] = [];
const spread: number[] = [];

/** Somewhere a player has a reason to walk: a stair head, a Dot, a scannable object. */
function destinations(floor: FloorPlan): Array<{ id: string; at: Vec2 }> {
  const list: Array<{ id: string; at: Vec2 }> = [];
  for (const stair of floor.stairs) {
    list.push({ id: stair.id, at: { x: stair.rect.x + stair.rect.w / 2, y: stair.rect.y + stair.rect.h / 2 } });
  }
  for (const dot of floor.dotSpawns) list.push({ id: dot.id, at: dot.position });
  return list;
}

for (const building of worldMap.buildings as Building[]) {
  if (only && building.id !== only) continue;
  for (const floor of building.floors) {
    const physics = physicsFloorId(worldMap, floor.id);
    const targets = destinations(floor);
    if (!targets.length) continue;

    /**
     * Where the floor is entered. A doorway when it has one, otherwise its stairs — a
     * basement's only way in is the flight down, and probing it from a door it does not
     * have would report the whole floor unreachable.
     */
    const entries: Array<{ id: string; at: Vec2; limit: number }> = floor.doorways.length
      ? floor.doorways.map((door) => ({ id: door.id, at: insideOf(floor, door)[0], limit: door.width / 2 - RADIUS }))
      : floor.stairs.map((stair) => ({
        id: stair.id,
        at: { x: stair.rect.x + stair.rect.w / 2, y: stair.rect.y + stair.rect.h / 2 },
        limit: Math.min(stair.rect.w, stair.rect.h) / 2 - RADIUS,
      }));
    const entry = entries[0];
    if (!entry) continue;

    for (const target of targets) {
      if (target.id === entry.id) continue;
      /**
       * A probe point that is not navigable is a bad probe, not a broken world.
       *
       * Without this the run reported 9 UNREACHABLE routes on floors whose audits are clean,
       * because `insideOf` guesses which side of a door is the inside and a stair core's
       * interior is largely guard rects. "No path" and "I asked from inside a wall" are the
       * same empty array, and only one of them is a finding.
       */
      const reachedAtAll = findNavigationPath(worldMap, physics, entry.at, target.at, RADIUS).length > 0;
      if (!reachedAtAll) {
        const back = findNavigationPath(worldMap, physics, target.at, entry.at, RADIUS).length > 0;
        badProbe.push({ floor: floor.id, from: entry.id, to: target.id, margin: back ? -1 : -2, limit: 0 });
        continue;
      }
      const widest = widestBot(worldMap, physics, entry.at, target.at);
      const route: Route = {
        floor: floor.id,
        from: entry.id,
        to: target.id,
        margin: Math.round(widest - RADIUS),
        limit: Math.round(entry.limit),
      };
      if (widest === 0) unreachable.push(route);
      else {
        spread.push(route.margin);
        /**
         * Tighter than its own front door, which is the only version of this worth reporting.
         *
         * Raw margin is not the signal: the world's commonest doorway is 56 units, so a bot
         * of radius 28 is the widest thing that will ever come through one and EVERY route
         * behind it reads as 4 spare no matter how open the room is. That made the first run
         * report 53 tight routes, most of them describing a door I authored on purpose.
         *
         * A route narrower than the opening it starts at is different in kind: something
         * inside the room pinches harder than the architecture does, and that something is
         * furniture. It is also how this probe found `observatory:F1`'s drafting table on its
         * own — the same object that was moved by hand last session for clearing an
         * instrument by exactly one bot's width.
         */
        if (route.margin < Math.min(TIGHT, route.limit)) routes.push(route);
      }
    }
  }
}

/** Nearest-wall gaps, as context only. See the header for why this is not a verdict. */
const gaps: number[] = [];
for (const building of worldMap.buildings as Building[]) {
  if (only && building.id !== only) continue;
  for (const floor of building.floors) {
    const walls = wallRects(floor);
    for (const object of floor.objects) {
      for (const box of objectCollisionRects(object)) {
        let nearest = Infinity;
        for (const wall of walls) {
          const overlapsX = box.x < wall.x + wall.w && wall.x < box.x + box.w;
          const overlapsY = box.y < wall.y + wall.h && wall.y < box.y + box.h;
          if (overlapsX && wall.y + wall.h <= box.y) nearest = Math.min(nearest, box.y - (wall.y + wall.h));
          if (overlapsX && box.y + box.h <= wall.y) nearest = Math.min(nearest, wall.y - (box.y + box.h));
          if (overlapsY && wall.x + wall.w <= box.x) nearest = Math.min(nearest, box.x - (wall.x + wall.w));
          if (overlapsY && box.x + box.w <= wall.x) nearest = Math.min(nearest, wall.x - (box.x + box.w));
        }
        if (nearest !== Infinity) gaps.push(nearest);
      }
    }
  }
}

const bucket = (test: (g: number) => boolean): number => gaps.filter(test).length;
console.log(`Nearest-wall gaps, as context (a bot is ${RADIUS * 2} units across):`);
console.log(`   flush 0..8      ${String(bucket((g) => g <= 8)).padStart(4)}`);
console.log(`   8..48           ${String(bucket((g) => g > 8 && g < RADIUS * 2)).padStart(4)}   <- 23% of all gaps; NOT a defect band, see header`);
console.log(`   48..120         ${String(bucket((g) => g >= RADIUS * 2 && g < 120)).padStart(4)}`);
console.log(`   120+            ${String(bucket((g) => g >= 120)).padStart(4)}`);

console.log(`\nRoute margin over ${spread.length} routes (how much fatter than a bot still gets there):`);
console.log(`   0..${TIGHT - 1} units TIGHT   ${String(spread.filter((m) => m < TIGHT).length).padStart(4)}`);
console.log(`   ${TIGHT}..23 units       ${String(spread.filter((m) => m >= TIGHT && m < RADIUS).length).padStart(4)}`);
console.log(`   ${RADIUS}+ units        ${String(spread.filter((m) => m >= RADIUS).length).padStart(4)}`);

if (unreachable.length) {
  console.log(`\nUNREACHABLE (${unreachable.length}):`);
  for (const r of unreachable) console.log(`   ${r.floor.padEnd(22)} ${r.from} -> ${r.to}`);
}
if (badProbe.length) {
  console.log(`\nBAD PROBE POINT, not a world defect (${badProbe.length}):`);
  for (const r of badProbe) {
    console.log(`   ${r.floor.padEnd(22)} ${r.from} -> ${r.to}   ${r.margin === -1 ? "reachable in reverse" : "neither direction"}`);
  }
}

/**
 * Ranked by LOST — how much narrower the route is than the opening it starts at.
 *
 * This is the number to act on, and it is not the margin. A route with 2 units of margin
 * behind a core door that only allows 4 is the architecture doing its job; a route with 3
 * behind a 120-wide rollup that allows 36 has 33 units of furniture in the way. Sorting by
 * margin puts those in the wrong order and buries the second one.
 */
console.log(`\nROUTES TIGHTER THAN THEIR OWN DOOR (${routes.length}), worst first:`);
const lost = (r: Route): number => (r.limit ?? 0) - r.margin;
for (const r of routes.sort((a, b) => lost(b) - lost(a))) {
  console.log(
    `   ${String(lost(r)).padStart(2)} lost   ${r.floor.padEnd(20)} ${String(r.margin).padStart(2)} spare of ${String(r.limit).padStart(2)}   ${r.from} -> ${r.to}`,
  );
}
