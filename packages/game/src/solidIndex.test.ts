import { describe, expect, it } from "vitest";

import { collectSolids } from "./collision";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { integrateWithWalls, resolveAgainstSolids } from "./kinematics";
import { physicsFloorId } from "./mapModel";
import { buildSolidIndex } from "./solidIndex";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Solid } from "./types";

/**
 * The index is an optimisation, so the only interesting property is that it
 * changes nothing.
 *
 * Client prediction and the server run the same resolver and must agree to the
 * bit, or the player sees their bot snap back. So this compares the indexed path
 * against the linear scan across a dense sample of every physics plane in the
 * shipped map — including deep inside walls, where separation moves the circle
 * furthest and a too-small query radius would show up.
 *
 * `toBe` on each coordinate, not `toBeCloseTo`: "almost the same position" is the
 * failure this exists to catch.
 */

const RADIUS = defaultGameConfig.botRadius;

function planes(): Array<{ id: string; solids: Solid[] }> {
  const ids = new Set<string>([OUTDOOR_FLOOR_ID]);
  for (const building of downtownMap.buildings) {
    for (const floor of building.floors) ids.add(physicsFloorId(downtownMap, floor.id));
  }
  return [...ids].map((id) => ({ id, solids: collectSolids(downtownMap, id) }));
}

describe("the gridded solid index", () => {
  it("resolves every sampled position exactly as the linear scan does", () => {
    let sampled = 0;
    let contacts = 0;
    for (const { id, solids } of planes()) {
      const index = buildSolidIndex(solids);
      // 24 units: fine enough that a bot-sized circle cannot slip between samples.
      for (let y = 8; y < downtownMap.height; y += 24) {
        for (let x = 8; x < downtownMap.width; x += 24) {
          const at = { x, y };
          const linear = resolveAgainstSolids(at, RADIUS, solids);
          const indexed = resolveAgainstSolids(at, RADIUS, index);
          sampled += 1;
          if (linear.x !== at.x || linear.y !== at.y) contacts += 1;
          if (indexed.x !== linear.x || indexed.y !== linear.y) {
            throw new Error(
              `${id} at ${x},${y}: indexed ${indexed.x},${indexed.y} != linear ${linear.x},${linear.y}`,
            );
          }
        }
      }
    }
    // Guard the guard: a sample that never touched anything would prove nothing.
    expect(sampled).toBeGreaterThan(50_000);
    expect(contacts).toBeGreaterThan(1_000);
  });

  it("integrates a full move identically, including along and into walls", () => {
    for (const { id, solids } of planes()) {
      const index = buildSolidIndex(solids);
      for (let y = 40; y < downtownMap.height; y += 120) {
        for (let x = 40; x < downtownMap.width; x += 120) {
          for (const velocity of [
            { x: 900, y: 0 }, { x: -900, y: 0 }, { x: 0, y: 900 }, { x: 0, y: -900 },
            { x: 640, y: 640 }, { x: -640, y: 640 },
          ]) {
            const at = { x, y };
            const linear = integrateWithWalls(at, velocity, 33, RADIUS, solids);
            const indexed = integrateWithWalls(at, velocity, 33, RADIUS, index);
            if (indexed.x !== linear.x || indexed.y !== linear.y) {
              throw new Error(
                `${id} at ${x},${y} v${velocity.x},${velocity.y}: `
                + `indexed ${indexed.x},${indexed.y} != linear ${linear.x},${linear.y}`,
              );
            }
          }
        }
      }
    }
  });

  it("narrows the outdoor plane to a handful of candidates", () => {
    const solids = collectSolids(downtownMap, OUTDOOR_FLOOR_ID);
    const index = buildSolidIndex(solids);
    let worst = 0;
    let total = 0;
    let queries = 0;
    for (let y = 40; y < downtownMap.height; y += 40) {
      for (let x = 40; x < downtownMap.width; x += 40) {
        const count = index.near({ x, y }, RADIUS).length;
        worst = Math.max(worst, count);
        total += count;
        queries += 1;
      }
    }
    // The point of the exercise: the linear path tests all of them, every time.
    expect(solids.length).toBeGreaterThan(150);
    expect(total / queries).toBeLessThan(solids.length / 20);
    expect(worst).toBeLessThan(solids.length / 3);
  });

  it("keeps the plane's own order, which resolution depends on", () => {
    const solids = collectSolids(downtownMap, OUTDOOR_FLOOR_ID);
    const index = buildSolidIndex(solids);
    for (let y = 100; y < downtownMap.height; y += 260) {
      for (let x = 100; x < downtownMap.width; x += 260) {
        const near = index.near({ x, y }, RADIUS);
        const positions = near.map((solid) => solids.indexOf(solid));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
      }
    }
  });
});
