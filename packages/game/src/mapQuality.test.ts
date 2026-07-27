import { describe, expect, it } from "vitest";
import { auditBuildingFloorQuality } from "./mapQuality";
import type { MapDocument, MapObject } from "./types";

function testMap(objects: MapObject[]): MapDocument {
  return {
    id: "quality-test",
    name: "Quality test",
    visualTheme: "lit-model",
    width: 420,
    height: 320,
    outdoor: { roads: [], parks: [], walls: [], objects: [], dotSpawns: [] },
    buildings: [{
      id: "test-building",
      kind: "office",
      name: "TEST",
      footprint: { x: 20, y: 20, w: 380, h: 280 },
      floors: [{
        id: "test:GROUND",
        label: "GROUND",
        walls: [
          { id: "n", x: 20, y: 20, w: 380, h: 8 },
          { id: "s", x: 20, y: 292, w: 380, h: 8 },
          { id: "w", x: 20, y: 20, w: 8, h: 280 },
          { id: "e", x: 392, y: 20, w: 8, h: 280 },
        ],
        doorways: [],
        objects,
        stairs: [],
        dotSpawns: [],
      }],
    }],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns: [{
      id: "player",
      name: "YOU",
      squadId: "player",
      controller: "human",
      color: "#000",
      position: { x: 80, y: 160 },
      floorId: "test:GROUND",
    }],
  };
}

describe("floor authoring quality audit", () => {
  /**
   * Regression: Lot 6 Depot shipped two crates 6 units off the long face of a
   * 220-unit rack run. The gap was too narrow to enter and too deep to read as
   * joined, and the false-aisle rule missed it because a 34-unit crate never
   * reaches the 48-unit corridor threshold.
   */
  it("rejects a small fixture parked off the face of a long run", () => {
    const issues = auditBuildingFloorQuality(testMap([
      { id: "rack", kind: "shelf", x: 120, y: 60, w: 26, h: 220 },
      { id: "crate", kind: "crateStack", x: 152, y: 92, w: 34, h: 34 },
    ]), "test-building");
    expect(issues.map((issue) => issue.kind)).toContain("wedged-fixture");
  });

  it("accepts a fixture whose end stops short of another bank", () => {
    // A bench extending a perimeter run into a locker block: the gap meets the
    // bench's end, which is exactly the attached seam the contract allows.
    const issues = auditBuildingFloorQuality(testMap([
      { id: "bench", kind: "workbench", x: 60, y: 60, w: 210, h: 58 },
      { id: "lockers", kind: "locker", x: 286, y: 46, w: 100, h: 118 },
    ]), "test-building");
    expect(issues.map((issue) => issue.kind)).not.toContain("wedged-fixture");
  });

  it("accepts comparable fixtures separated by a seam", () => {
    // Neither is parked beside the other, so the seam joins rather than traps.
    const issues = auditBuildingFloorQuality(testMap([
      { id: "flight-a", kind: "counter", x: 120, y: 60, w: 90, h: 180 },
      { id: "flight-b", kind: "counter", x: 226, y: 76, w: 90, h: 180 },
    ]), "test-building");
    expect(issues.map((issue) => issue.kind)).not.toContain("wedged-fixture");
  });

  it("rejects overlapping solid fixtures", () => {
    const issues = auditBuildingFloorQuality(testMap([
      { id: "a", kind: "counter", x: 120, y: 80, w: 100, h: 60 },
      { id: "b", kind: "counter", x: 200, y: 100, w: 100, h: 60 },
    ]), "test-building");
    expect(issues.some((issue) => issue.kind === "solid-overlap")).toBe(true);
  });

  it("rejects a visible gap that cannot serve as a comfortable aisle", () => {
    const issues = auditBuildingFloorQuality(testMap([
      { id: "a", kind: "counter", x: 120, y: 80, w: 80, h: 100 },
      { id: "b", kind: "counter", x: 224, y: 80, w: 80, h: 100 },
    ]), "test-building");
    expect(issues.some((issue) => issue.kind === "false-aisle" && issue.message.includes("24-unit"))).toBe(true);
  });

  it("allows a joined bank or a genuinely comfortable aisle", () => {
    for (const x of [216, 264]) {
      const issues = auditBuildingFloorQuality(testMap([
        { id: "a", kind: "counter", x: 120, y: 80, w: 80, h: 100 },
        { id: "b", kind: "counter", x, y: 80, w: 80, h: 100 },
      ]), "test-building");
      expect(issues.filter((issue) => issue.kind === "false-aisle")).toEqual([]);
    }
  });

  it("rejects long fixture banks compressed front-to-back even across an attached seam", () => {
    const issues = auditBuildingFloorQuality(testMap([
      { id: "front", kind: "counter", x: 80, y: 80, w: 220, h: 40 },
      { id: "back", kind: "counter", x: 80, y: 128, w: 220, h: 40 },
    ]), "test-building");
    expect(issues.some((issue) => issue.kind === "parallel-banks")).toBe(true);
  });

  /**
   * Traversal resolves a stair's destination only when a bot crosses it, so a
   * bad `toFloorId` used to be invisible until someone walked it. Previously
   * caught by the editor's JSON save validator; that path is gone, so the
   * invariant lives here with the other map audits.
   */
  it("rejects a stair whose destination floor does not exist", () => {
    const broken = testMap([]);
    broken.buildings[0].floors[0].stairs.push({
      id: "nowhere", rect: { x: 60, y: 60, w: 40, h: 80 },
      direction: "up", bottom: "S", toFloorId: "test:F9",
    });
    const issues = auditBuildingFloorQuality(broken, "test-building");
    expect(issues.some((issue) => issue.kind === "stair-target-missing")).toBe(true);
  });
});

// The shipped map is audited in mapValidation.test.ts, which holds an exact
// per-building debt ledger rather than a pass/fail — paying debt down has to
// edit that ledger, so what is left stays visible. This file tests the rules.
