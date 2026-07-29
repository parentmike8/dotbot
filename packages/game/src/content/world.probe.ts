/**
 * Why a blueprint has nowhere to go.
 *
 * `pnpm --filter @dotbot/game exec tsx src/content/world.probe.ts [buildingId]`
 *
 * `addBlueprintSpawns` throws with the object's name and nothing else, which tells you
 * where the symptom is and never why. Four things can rule a candidate out — outside the
 * footprint, inside a solid, unreachable, or too close to a Dot already placed — and
 * knowing which one it was is the difference between moving a chair and redesigning a
 * floor. Diagnostic only; the tests assert the ledger.
 */
import { pointToSolidDistanceSquared, rectSolid } from "../geometry";
import { defaultGameConfig } from "../config";
import { isGroundFloor, MIN_DOT_SEPARATION, objectCollisionRects } from "../mapModel";
import { downtownRegion } from "./downtown";
import { fairground } from "./fairground";
import { railYard } from "./railYard";
import { templeRegion } from "./templeRegion";
import type { RegionParts } from "./regionKit";
import type { Solid, Vec2 } from "../types";

const RADIUS = defaultGameConfig.botRadius;
const PUSH = 10;
const only = (globalThis as { process?: { argv: string[] } }).process?.argv[2];

const regions: RegionParts[] = [downtownRegion, railYard, fairground, templeRegion];
const outdoorSolids: Solid[] = [
  ...regions.flatMap((r) => (r.objects ?? []).flatMap(objectCollisionRects).map(rectSolid)),
  ...regions.flatMap((r) => r.barriers ?? []).flatMap((b) => b.solids),
];

for (const region of regions) {
  for (const building of region.buildings ?? []) {
    if (only && building.id !== only) continue;
    for (const floor of building.floors) {
      const scannable = floor.objects.filter((o) => o.scannable);
      if (!scannable.length) continue;
      const placed: Vec2[] = floor.dotSpawns.map((d) => d.position);
      for (const o of scannable) {
        const solids: Solid[] = [
          ...floor.walls.map(rectSolid),
          ...(floor.barriers ?? []).flatMap((b) => b.solids),
          ...floor.objects.filter((c) => c.id !== o.id).flatMap(objectCollisionRects).map(rectSolid),
          ...(isGroundFloor(floor) ? outdoorSolids : []),
        ];
        const fp = building.footprint;
        const d = RADIUS + PUSH;
        const cands: Array<[string, Vec2]> = [
          ["N", { x: o.x + o.w / 2, y: o.y - d }],
          ["E", { x: o.x + o.w + d, y: o.y + o.h / 2 }],
          ["S", { x: o.x + o.w / 2, y: o.y + o.h + d }],
          ["W", { x: o.x - d, y: o.y + o.h / 2 }],
        ];
        // eslint-disable-next-line no-console
        console.log(`\n${building.id}/${floor.label}/${o.kind} @${o.x},${o.y} ${o.w}x${o.h}`);
        for (const [side, p] of cands) {
          const inFp = p.x >= fp.x + RADIUS && p.x <= fp.x + fp.w - RADIUS
            && p.y >= fp.y + RADIUS && p.y <= fp.y + fp.h - RADIUS;
          let clear = Infinity;
          let worst = "";
          for (const s of solids) {
            const c = Math.sqrt(pointToSolidDistanceSquared(p, s));
            if (c < clear) { clear = c; worst = JSON.stringify(s).slice(0, 80); }
          }
          const nearestDot = Math.min(...placed.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
          const why = [
            inFp ? "" : "outside-footprint",
            clear >= RADIUS ? "" : `in-solid ${worst}`,
            nearestDot >= MIN_DOT_SEPARATION ? "" : `dot-${Math.round(nearestDot)}u`,
          ].filter(Boolean).join(" + ");
          // eslint-disable-next-line no-console
          console.log(`   ${side} (${Math.round(p.x)},${Math.round(p.y)}) clear=${clear.toFixed(0)} dot=${Math.round(nearestDot)}  ${why || "OK"}`);
        }
      }
    }
  }
}
