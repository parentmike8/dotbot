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
  it("keeps authored ids stable when an unrelated object is inserted before them", () => {
    const withoutInsertion = objects("demo", FILE);
    const benchA = withoutInsertion.authored("front-bench", "bench", 100, 120, 80, 24);
    const hydrantA = withoutInsertion.authored("north-hydrant", "hydrant", 220, 120, 14, 14);

    const withInsertion = objects("demo", FILE) as typeof withoutInsertion;
    withInsertion.authored("new-crate", "crateStack", 40, 40, 34, 34);
    const benchB = withInsertion.authored("front-bench", "bench", 100, 120, 80, 24);
    const hydrantB = withInsertion.authored("north-hydrant", "hydrant", 220, 120, 14, 14);

    expect([benchB.id, hydrantB.id]).toEqual([benchA.id, hydrantA.id]);
    expect(benchA.id).toContain("front-bench");
  });

  it("derives rule member ids from the rule and member geometry, not iteration order", () => {
    const rule: OutdoorRule = {
      id: "north-trees",
      label: "north trees",
      expression: "rhythm(100, 300, 200)",
      axis: "x",
      from: 100,
      to: 300,
      spacing: 200,
      gaps: [],
      parameters: [],
    };
    const build = (xs: number[]) => {
      const obj = objects("demo", FILE);
      return obj.derived(rule, () => xs.map((x) => obj("tree", x, 80, 36, 36)));
    };
    const forward = new Map(build([100, 300]).map((object) => [object.x, object.id]));
    const reversed = new Map(build([300, 100]).map((object) => [object.x, object.id]));
    expect(reversed).toEqual(forward);
    expect(forward.get(100)).toContain("north-trees");
  });

  it("ships only stable authored or rule-member identities in the production world", () => {
    const ids = worldMap.outdoor.objects.map((object) => object.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => /(?:^|-)o\d+$/.test(id))).toBe(false);

    for (const object of worldMap.outdoor.objects) {
      expect(object.source, `${object.id} has no outdoor source identity`).toBeDefined();
      if (object.source?.kind === "authored") {
        expect(object.id).toContain(object.source.key);
        expect(object.source.fingerprint)
          .toBe(`${object.source.key}:${object.source.objectKind}`);
      } else {
        expect(object.id).toContain(object.source!.rule.id);
        expect(object.id).toContain(object.source!.memberKey);
      }
    }
  });

  it("keeps a literal object editable without changing its runtime data", () => {
    const obj = objects("demo", FILE);
    const object = obj.authored("front-bench", "bench", 100, 120, 80, 24, {
      facing: "N",
      angle: 0.25,
      collisionParts: [{ x: 0, y: 0, w: 20, h: 24 }],
      solid: false,
    });

    expect(object).toMatchObject({
      id: "demo-front-bench",
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
      key: "front-bench",
      objectKind: "bench",
      fingerprint: "front-bench:bench",
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
      { kind: "derived", file: FILE, rule, memberKey: "tree-180-80-36x36" },
      { kind: "derived", file: FILE, rule, memberKey: "tree-780-80-36x36" },
    ]);
  });
});

describe("outdoor source patches", () => {
  const source = `const obj = objects("demo", "packages/game/src/content/example.ts");
const objects = [
  obj.authored("front-bench", "bench", 100, 120, 80, 24, { facing: "N", angle: 0.25, collisionParts: [{ x: 0, y: 0, w: 20, h: 24 }] }),
  ...obj.derived(RULE, () => rhythm(0, 20, 10).map((x) => obj("tree", x, 40, 20, 20))),
  obj.authored("loading-crates", "crateStack", ORIGIN_X + 20, 220, 34, 34, { scannable: true }),
];`;

  it("moves and resizes a direct call while preserving rotation, shape and collision metadata", () => {
    const moved = applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-front-bench",
      source: {
        kind: "authored", file: FILE, key: "front-bench", objectKind: "bench",
        fingerprint: "front-bench:bench", call: "obj",
      },
      x: 108,
      y: 132,
    });
    const resized = applyOutdoorEdit(moved, {
      op: "resizeOutdoorObject",
      id: "demo-front-bench",
      source: {
        kind: "authored", file: FILE, key: "front-bench", objectKind: "bench",
        fingerprint: "front-bench:bench", call: "obj",
      },
      w: 92,
      h: 28,
    });

    expect(resized).toContain('obj.authored("front-bench", "bench", 108, 132, 92, 28, { facing: "N", angle: 0.25, collisionParts: [{ x: 0, y: 0, w: 20, h: 24 }] })');
    expect(resized).toContain("...obj.derived(RULE");
    expect(resized).toContain("ORIGIN_X + 20");
  });

  it("uses authored-call ownership rather than a computed runtime id", () => {
    const moved = applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-loading-crates",
      source: {
        kind: "authored", file: FILE, key: "loading-crates", objectKind: "crateStack",
        fingerprint: "loading-crates:crateStack", call: "obj",
      },
      x: 444,
      y: 222,
    });
    expect(moved).toContain('obj.authored("loading-crates", "crateStack", 444, 222, 34, 34, { scannable: true })');
    expect(moved).toContain('obj.authored("front-bench", "bench", 100, 120, 80, 24');
  });

  it("refuses to patch a computed id with no source locator", () => {
    expect(() => applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-o1",
      x: 1,
      y: 2,
    } as never)).toThrow(/computed runtime id/i);
  });

  it("refuses a stale fingerprint instead of moving a different call", () => {
    expect(() => applyOutdoorEdit(source, {
      op: "moveOutdoorObject",
      id: "demo-missing",
      source: {
        kind: "authored", file: FILE, key: "missing", objectKind: "bench",
        fingerprint: "missing:bench", call: "obj",
      },
      x: 1,
      y: 2,
    })).toThrow(/stable call was not found|locator/i);
  });

  it("ignores obj(...) decoys in comments, strings, and templates", () => {
    const decoys = `// obj("line-decoy", "bench", 1, 2, 3, 4)
/* obj("block-decoy", "bench", 5, 6, 7, 8) */
const stringDecoy = 'obj("string-decoy", "bench", 9, 10, 11, 12)';
const templateDecoy = \`obj("template-decoy", "bench", 13, 14, 15, 16)\`;
const objects = [
  obj("front-bench", "bench", 100, 120, 80, 24, { facing: "N" }),
  obj("north-hydrant", "hydrant", 220, 120, 14, 14),
];`;
    const next = applyOutdoorEdit(decoys, {
      op: "moveOutdoorObject",
      id: "demo:front-bench",
      source: {
        kind: "authored",
        file: FILE,
        key: "front-bench",
        objectKind: "bench",
        fingerprint: "front-bench:bench",
        call: "obj",
      },
      x: 108,
      y: 132,
    } as never);

    expect(next).toContain('obj("front-bench", "bench", 108, 132, 80, 24');
    expect(next).toContain('// obj("line-decoy", "bench", 1, 2, 3, 4)');
    expect(next).toContain('obj("template-decoy", "bench", 13, 14, 15, 16)');
    expect(next).toContain('obj("north-hydrant", "hydrant", 220, 120, 14, 14)');
  });

  it("refuses a locator whose stable key or kind fingerprint does not match", () => {
    const authored = 'const objects = [obj("front-bench", "bench", 100, 120, 80, 24)];';
    expect(() => applyOutdoorEdit(authored, {
      op: "moveOutdoorObject",
      id: "demo:front-bench",
      source: {
        kind: "authored",
        file: FILE,
        key: "front-bench",
        objectKind: "hydrant",
        fingerprint: "front-bench:hydrant",
        call: "obj",
      },
      x: 108,
      y: 132,
    } as never)).toThrow(/fingerprint|kind|locator/i);
  });
});

describe("moved outdoor geometry", () => {
  it("moves the collider with the same authored rectangle", () => {
    const obj = objects("demo", FILE);
    const before = obj.authored("loading-crates", "crateStack", 100, 120, 34, 34);
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
