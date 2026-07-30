import { describe, expect, it } from "vitest";
import { objectSolids } from "./collision";
import { worldMap } from "./content/world";
import {
  applyOutdoorEdit,
  objects,
  outdoorSourceOf,
  type OutdoorRule,
} from "./outdoorSource";

const FILE = "packages/game/src/content/example.ts";

describe("outdoor source ownership", () => {
  it("keeps a literal object editable without changing its runtime data", () => {
    const obj = objects("demo", FILE);
    const object = obj("bench", 100, 120, 80, 24, {
      facing: "N",
      angle: 0.25,
      collisionParts: [{ x: 0, y: 0, w: 20, h: 24 }],
      solid: false,
    });

    expect(object).toMatchObject({
      id: "demo-o0",
      kind: "bench",
      x: 100,
      y: 120,
      w: 80,
      h: 24,
      facing: "N",
      angle: 0.25,
      collisionParts: [{ x: 0, y: 0, w: 20, h: 24 }],
    });
    expect(outdoorSourceOf(object)).toEqual({
      kind: "authored",
      file: FILE,
      ordinal: 0,
      call: "obj",
    });
  });

  it("marks every expanded rhythm object as derived and names the exact rule", () => {
    const obj = objects("demo", FILE);
    const rule: OutdoorRule = {
      id: "north-trees",
      label: "north-side tree rhythm",
      expression: "rhythm(180, MAP_W - 180, 200, MAIN_N_GAPS)",
      axis: "x",
      from: 180,
      to: 2220,
      spacing: 200,
      gaps: [[330, 590]],
      parameters: [
        { name: "from", source: "180", value: "180" },
        { name: "to", source: "MAP_W - 180", value: "2220" },
        { name: "spacing", source: "200", value: "200" },
        { name: "gaps", source: "MAIN_N_GAPS", value: "[[330, 590]]" },
      ],
    };
    const placed = obj.derived(rule, () => [180, 780].map((x) => obj("tree", x, 80, 36, 36)));

    expect(placed.map((object) => outdoorSourceOf(object))).toEqual([
      { kind: "derived", file: FILE, rule },
      { kind: "derived", file: FILE, rule },
    ]);
  });
});

describe("outdoor source patches", () => {
  const source = `const obj = objects("demo", "packages/game/src/content/example.ts");
const objects = [
  obj("bench", 100, 120, 80, 24, { facing: "N", angle: 0.25, collisionParts: [{ x: 0, y: 0, w: 20, h: 24 }] }),
  ...obj.derived(RULE, () => rhythm(0, 20, 10).map((x) => obj("tree", x, 40, 20, 20))),
  obj("crateStack", ORIGIN_X + 20, 220, 34, 34, { scannable: true }),
];`;

  it("moves and resizes a direct call while preserving rotation, shape and collision metadata", () => {
    const moved = applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-o0",
      source: { kind: "authored", file: FILE, ordinal: 0, call: "obj" },
      x: 108,
      y: 132,
    });
    const resized = applyOutdoorEdit(moved, {
      op: "resizeOutdoorObject",
      id: "demo-o0",
      source: { kind: "authored", file: FILE, ordinal: 0, call: "obj" },
      w: 92,
      h: 28,
    });

    expect(resized).toContain('obj("bench", 108, 132, 92, 28, { facing: "N", angle: 0.25, collisionParts: [{ x: 0, y: 0, w: 20, h: 24 }] })');
    expect(resized).toContain("...obj.derived(RULE");
    expect(resized).toContain("ORIGIN_X + 20");
  });

  it("uses authored-call ownership rather than a computed runtime id", () => {
    const moved = applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-o4",
      source: { kind: "authored", file: FILE, ordinal: 1, call: "obj" },
      x: 444,
      y: 222,
    });
    expect(moved).toContain('obj("crateStack", 444, 222, 34, 34, { scannable: true })');
    expect(moved).toContain('obj("bench", 100, 120, 80, 24');
  });

  it("refuses to patch a computed id with no source locator", () => {
    expect(() => applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-o1",
      x: 1,
      y: 2,
    } as never)).toThrow(/computed runtime id/i);
  });

  it("refuses a stale locator instead of moving a different call", () => {
    expect(() => applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-o99",
      source: { kind: "authored", file: FILE, ordinal: 8, call: "obj" },
      x: 1,
      y: 2,
    })).toThrow(/authored object 8/i);
  });
});

describe("moved outdoor geometry", () => {
  it("moves the collider with the same authored rectangle", () => {
    const obj = objects("demo", FILE);
    const before = obj("crateStack", 100, 120, 34, 34);
    const after = { ...before, x: 148, y: 172 };

    expect(objectSolids(before)[0]).toMatchObject({ x: 100, y: 120, w: 34, h: 34 });
    expect(objectSolids(after)[0]).toMatchObject({ x: 148, y: 172, w: 34, h: 34 });
    expect(after).toMatchObject({ kind: before.kind, w: before.w, h: before.h });
  });
});

describe("against shipped outdoor source files", () => {
  const shipped = (import.meta as unknown as {
    glob: (pattern: string, options: Record<string, unknown>) => Record<string, string>;
  }).glob("./content/*.ts", { query: "?raw", import: "default", eager: true });

  for (const file of [
    "packages/game/src/content/downtown.ts",
    "packages/game/src/content/fairground.ts",
    "packages/game/src/content/railYard.ts",
    "packages/game/src/content/templeRegion.ts",
  ]) {
    it(`patches one direct object in ${file.split("/").pop()} by its authored locator`, () => {
      const object = worldMap.outdoor.objects.find((candidate) =>
        candidate.source?.kind === "authored" && candidate.source.file === file)!;
      expect(object, `an authored object owned by ${file}`).toBeDefined();
      const text = shipped[`./content/${file.split("/").pop()}`];
      const next = applyOutdoorEdit(text, {
        op: "moveOutdoorObject",
        id: object.id,
        source: object.source as Extract<NonNullable<typeof object.source>, { kind: "authored" }>,
        x: object.x + 7,
        y: object.y + 9,
      });
      expect(next).not.toBe(text);
      expect(next).toContain(String(object.x + 7));
      expect(next).toContain(String(object.y + 9));
    });
  }
});
