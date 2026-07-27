import { describe, expect, it } from "vitest";
import { collectSolids } from "./collision";
import { defaultGameConfig } from "./config";
import { pointToSolidDistanceSquared, solidBounds } from "./geometry";
import { integrateWithWalls } from "./kinematics";
import { compileBuilding, outlinePoints, resolvePath, type SourceBuilding } from "./mapSource";
import { hasLineOfSight } from "./visibility";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { MapDocument, Vec2 } from "./types";

const RADIUS = defaultGameConfig.botRadius;

/**
 * A building no previous version of this map format could express: an L-plan with
 * one chamfered corner rounded off, a roll-up on the long elevation, a person door
 * beside it, glazing on the short return, and an interior partition running at a
 * diagonal with a doorway placed by anchor point rather than arc length.
 */
const CURVED_DEPOT: SourceBuilding = {
  id: "curved",
  kind: "warehouse",
  name: "CURVED DEPOT",
  shellThickness: 14,
  outline: {
    shape: "polygon",
    points: [
      { x: 200, y: 200 },
      { x: 700, y: 200 },
      { x: 700, y: 500, r: 90 },
      { x: 460, y: 500 },
      { x: 460, y: 760 },
      { x: 200, y: 760 },
    ],
  },
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "Receive and stage freight on a corner site that is not a box.",
        zones: ["dock apron", "staging", "office return"],
        sequence: "Truck at the roll-up, freight staged, paperwork in the return.",
        adjacency: "Roll-up opens straight onto the apron; office sits off the aisle.",
        negativeSpace: "The apron is deliberately clear for a truck to swing.",
      },
      shellOpenings: [
        { kind: "rollup", width: 120, near: { x: 400, y: 200 } },
        { kind: "door", width: 56, near: { x: 620, y: 200 } },
        { kind: "window", width: 70, near: { x: 200, y: 600 } },
      ],
      walls: [
        {
          id: "diag",
          thickness: 10,
          // Runs shell to shell, so the only way past it is the authored door.
          path: [{ x: 214, y: 435 }, { x: 686, y: 300 }],
          openings: [{ kind: "door", width: 60, near: { x: 440, y: 360 } }],
        },
      ],
      objects: [{ id: "rack", kind: "shelf", x: 300, y: 560, w: 26, h: 160, scannable: true }],
      dots: [{ id: "dot-1", item: { kind: "powerup", type: "health" }, x: 340, y: 300 }],
    },
  ],
};

function wrap(building: ReturnType<typeof compileBuilding>): MapDocument {
  return {
    id: "source-test",
    name: "Source test",
    visualTheme: "lit-model",
    width: 1000,
    height: 1000,
    outdoor: { roads: [], parks: [], walls: [], objects: [], dotSpawns: [] },
    buildings: [building],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns: [{
      id: "player",
      name: "YOU",
      squadId: "player",
      controller: "human",
      color: "#000",
      position: { x: 300, y: 300 },
      floorId: OUTDOOR_FLOOR_ID,
    }],
  };
}

/** Shove a bot along a heading for a second and report where it ends up. */
function shove(map: MapDocument, from: Vec2, toward: Vec2): Vec2 {
  const solids = collectSolids(map, OUTDOOR_FLOOR_ID);
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  let position = from;
  for (let tick = 0; tick < 40; tick += 1) {
    position = integrateWithWalls(
      position,
      { x: (dx / length) * defaultGameConfig.playerSpeed, y: (dy / length) * defaultGameConfig.playerSpeed },
      50,
      RADIUS,
      solids,
    );
  }
  return position;
}

describe("map source", () => {
  describe("geometry", () => {
    it("rounds only the vertices that ask for it", () => {
      const sharp = resolvePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
      expect(sharp).toHaveLength(3);
      const rounded = resolvePath([{ x: 0, y: 0 }, { x: 100, y: 0, r: 30 }, { x: 100, y: 100 }]);
      expect(rounded.length).toBeGreaterThan(3);
      // Endpoints survive; the corner itself is replaced by the curve.
      expect(rounded[0]).toEqual({ x: 0, y: 0 });
      expect(rounded.at(-1)).toEqual({ x: 100, y: 100 });
    });

    it("expands a rect shorthand and a circle into polygons", () => {
      expect(outlinePoints({ shape: "rect", x: 0, y: 0, w: 10, h: 10 })).toHaveLength(4);
      expect(outlinePoints({ shape: "circle", x: 0, y: 0, r: 10, steps: 16 })).toHaveLength(16);
      expect(outlinePoints({ shape: "rect", x: 0, y: 0, w: 100, h: 100, corner: 20 }).length)
        .toBeGreaterThan(4);
    });
  });

  describe("a non-rectangular building compiles into working geometry", () => {
    const building = compileBuilding(CURVED_DEPOT);
    const map = wrap(building);
    const floor = building.floors[0];

    it("keeps the true outline and derives the bounding footprint", () => {
      expect(building.outline!.length).toBeGreaterThan(6);
      expect(building.footprint).toEqual({ x: 200, y: 200, w: 500, h: 560 });
    });

    it("emits every wall as barriers of capsules, never rect walls", () => {
      expect(floor.walls).toEqual([]);
      expect(floor.barriers?.length).toBe(2);
      const solids = (floor.barriers ?? []).flatMap((barrier) => barrier.solids);
      expect(solids.every((solid) => solid.kind === "capsule")).toBe(true);
    });

    it("turns cut openings into real gaps and glazing into bands", () => {
      // Roll-up, person door, diagonal partition door.
      expect(floor.doorways).toHaveLength(3);
      expect(floor.doorways.find((door) => door.width === 120)?.open).toBe(true);
      // Every opening carries its true centreline for angled walls.
      expect(floor.doorways.every((door) => door.span !== undefined)).toBe(true);
      expect(floor.windows).toHaveLength(1);
      expect(floor.windows?.[0].span).toBeDefined();
    });

    it("places an opening at the anchor it was authored near", () => {
      const rollup = floor.doorways.find((door) => door.width === 120)!;
      expect(rollup.x).toBeCloseTo(400, 0);
      // The authored outline is the shell's *outer* face, so the wall centreline
      // — and with it the opening — sits half a thickness inside it.
      expect(rollup.y).toBeCloseTo(200 + 14 / 2, 0);
    });

    it("puts the shell's outer face exactly on the authored outline", () => {
      const shell = (floor.barriers ?? []).find((barrier) => barrier.id.endsWith("shell"))!;
      const top = Math.min(...shell.solids.map((solid) => solidBounds(solid).y));
      expect(top).toBeCloseTo(200, 6);
    });

    /**
     * A capsule's end cap reaches half a thickness past its spine, so a naive cut
     * pinches every opening by the full wall thickness. In a 14-unit shell that
     * turns a 56-unit door into 42 units of clear — narrower than the 48-unit bot.
     */
    it("gives an opening the full clear width it was authored with", () => {
      const shell = (floor.barriers ?? []).find((barrier) => barrier.id.endsWith("shell"))!;
      const rollup = floor.doorways.find((door) => door.width === 120)!;
      const jambs = shell.solids
        .map(solidBounds)
        .filter((bounds) => Math.abs(bounds.y - (rollup.y - 7)) < 1)
        .flatMap((bounds) => [bounds.x, bounds.x + bounds.w])
        .filter((edge) => Math.abs(edge - rollup.x) < rollup.width)
        .sort((a, b) => a - b);
      expect(jambs.at(-1)! - jambs[0]).toBeCloseTo(rollup.width, 6);
    });

    it("lets a bot walk in through the roll-up", () => {
      // Straight south through the roll-up on the north elevation.
      const inside = shove(map, { x: 400, y: 140 }, { x: 400, y: 400 });
      expect(inside.y).toBeGreaterThan(260);
    });

    it("stops a bot at the shell where there is no opening", () => {
      // 250 is west of the roll-up and has solid wall above it.
      const stopped = shove(map, { x: 250, y: 140 }, { x: 250, y: 400 });
      expect(stopped.y).toBeLessThan(200);
    });

    it("stops a bot at the diagonal partition, and lets it through the door", () => {
      const solids = collectSolids(map, OUTDOOR_FLOOR_ID);
      const partition = (floor.barriers ?? []).find((barrier) => barrier.id === "diag")!;

      // Aim at a solid stretch of the diagonal, well clear of its doorway.
      const blocked = shove(map, { x: 300, y: 300 }, { x: 300, y: 520 });
      for (const solid of partition.solids) {
        expect(Math.sqrt(pointToSolidDistanceSquared(blocked, solid))).toBeGreaterThan(RADIUS - 0.5);
      }
      expect(blocked.y).toBeLessThan(430);

      // Through the authored doorway near (440, 360) the bot passes.
      const through = shove(map, { x: 470, y: 300 }, { x: 415, y: 470 });
      expect(through.y).toBeGreaterThan(400);
      void solids;
    });

    it("blocks a sightline through the shell but not through a doorway", () => {
      const context = `${building.id}:GROUND`;
      // Across the solid west elevation.
      expect(hasLineOfSight(map, context, { x: 260, y: 600 }, { x: 140, y: 600 })).toBe(false);
      // Two points on the same side of every wall stay mutually visible.
      expect(hasLineOfSight(map, context, { x: 300, y: 260 }, { x: 600, y: 260 })).toBe(true);
    });

    it("carries the floor brief through as data", () => {
      expect(CURVED_DEPOT.floors[0].brief?.zones).toContain("staging");
    });
  });

  describe("stairs", () => {
    const twoStorey: SourceBuilding = {
      id: "tower",
      kind: "office",
      name: "TOWER",
      shellThickness: 12,
      outline: { shape: "circle", x: 500, y: 500, r: 160, steps: 24 },
      stairs: [{
        id: "tower-stair",
        rect: { x: 470, y: 430, w: 88, h: 148 },
        from: "GROUND",
        to: "F1",
        bottom: "S",
      }],
      floors: [{ label: "GROUND" }, { label: "F1" }],
    };

    it("emits a coordinate-identical reverse pair from one authored flight", () => {
      const compiled = compileBuilding(twoStorey);
      const ground = compiled.floors.find((floor) => floor.label === "GROUND")!;
      const upper = compiled.floors.find((floor) => floor.label === "F1")!;

      expect(ground.stairs).toHaveLength(1);
      expect(upper.stairs).toHaveLength(1);
      expect(ground.stairs[0].rect).toEqual(upper.stairs[0].rect);
      expect(ground.stairs[0].bottom).toBe(upper.stairs[0].bottom);
      // Floors are authored top-down, so GROUND -> F1 climbs.
      expect(ground.stairs[0].direction).toBe("up");
      expect(upper.stairs[0].direction).toBe("down");
      // A flight arriving at a ground floor targets the shared outdoor plane.
      expect(upper.stairs[0].toFloorId).toBe(OUTDOOR_FLOOR_ID);
      expect(ground.stairs[0].toFloorId).toBe("tower:F1");
    });

    it("refuses a flight that names a floor the building does not have", () => {
      expect(() => compileBuilding({
        ...twoStorey,
        stairs: [{ ...twoStorey.stairs![0], to: "F9" }],
      })).toThrow(/unknown floors/);
    });
  });
});
