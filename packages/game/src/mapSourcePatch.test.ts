import { describe, expect, it } from "vitest";

import { applyEdit, applyEdits, PatchError, printLiteral } from "./mapSourcePatch";

/**
 * The editor writes back into files people and LLMs read, so the thing that
 * matters most is what a patch leaves *alone*. Every test here checks the
 * untouched bytes as hard as the changed ones.
 */

const FILE = `import { compileBuilding, type SourceBuilding } from "../mapSource";

const INT = 8;

/** A helper, so not every object is written out. */
function wcFixtures(floor: string) {
  return [{ id: \`x-\${floor}-pan\`, kind: "toilet" as const, x: 10, y: 20, w: 26, h: 34 }];
}

export const SOURCE: SourceBuilding = {
  id: "demo",
  kind: "warehouse",
  name: "DEMO",
  shellThickness: 12,
  outline: { shape: "rect", x: 0, y: 0, w: 400, h: 300 },
  stairs: [
    { id: "demo-stair", rect: { x: 40, y: 40, w: 88, h: 148 }, from: "GROUND", to: "B1", bottom: "S" },
  ],
  floors: [
    {
      label: "GROUND",
      walls: [
        {
          id: "demo-partition",
          thickness: INT,
          // A comment that must survive.
          path: [{ x: 40, y: 100 }, { x: 300, y: 100 }],
          openings: [{ kind: "door", width: 56, near: { x: 120, y: 100 } }],
        },
        { id: "demo-bare", thickness: INT, path: [{ x: 40, y: 200 }, { x: 300, y: 200 }] },
      ],
      objects: [
        ...wcFixtures("g"),
        // The rack run is the hero of the floor.
        { id: "demo-rack", kind: "shelf", x: 100, y: 120, w: 26, h: 220, scannable: true },
        { id: "demo-crate", kind: "crateStack", x: 200, y: 120, w: 34, h: 34 },
      ],
      dots: [
        { id: "demo-dot", item: { kind: "powerup", type: "health" }, x: 150, y: 200 },
      ],
    },
    {
      label: "B1",
      objects: [
        { id: "demo-cellar-rack", kind: "shelf", x: 100, y: 120, w: 26, h: 220 },
      ],
      dots: [],
    },
  ],
};

export const demo = compileBuilding(SOURCE);
`;

/** Everything except the one line an edit is meant to touch. */
function otherLines(text: string, marker: string): string[] {
  return text.split("\n").filter((line) => !line.includes(marker));
}

describe("printing a literal", () => {
  it("writes bare keys, double quotes and one line", () => {
    expect(printLiteral({ id: "a", kind: "shelf", x: 1, y: 2 }))
      .toBe('{ id: "a", kind: "shelf", x: 1, y: 2 }');
  });

  it("drops undefined rather than writing it", () => {
    expect(printLiteral({ id: "a", facing: undefined })).toBe('{ id: "a" }');
  });

  it("nests objects and arrays", () => {
    expect(printLiteral({ path: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }))
      .toBe("{ path: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }");
  });

  it("rounds a fraction rather than emitting a long float", () => {
    expect(printLiteral({ x: 1 / 3 })).toBe("{ x: 0.3333 }");
  });
});

describe("moving an entry", () => {
  it("changes only that object's coordinates", () => {
    const next = applyEdit(FILE, { op: "moveObject", floor: "GROUND", id: "demo-rack", x: 108, y: 132 });
    expect(next).toContain('{ id: "demo-rack", kind: "shelf", x: 108, y: 132, w: 26, h: 220, scannable: true }');
    expect(otherLines(next, "demo-rack")).toEqual(otherLines(FILE, "demo-rack"));
  });

  it("keeps the comment above it", () => {
    const next = applyEdit(FILE, { op: "moveObject", floor: "GROUND", id: "demo-rack", x: 1, y: 2 });
    expect(next).toContain("// The rack run is the hero of the floor.");
  });

  it("moves a dot", () => {
    const next = applyEdit(FILE, { op: "moveDot", floor: "GROUND", id: "demo-dot", x: 160, y: 210 });
    expect(next).toContain('{ id: "demo-dot", item: { kind: "powerup", type: "health" }, x: 160, y: 210 }');
  });

  it("finds the right floor when two floors hold the same shape", () => {
    const next = applyEdit(FILE, { op: "moveObject", floor: "B1", id: "demo-cellar-rack", x: 9, y: 9 });
    expect(next).toContain('{ id: "demo-cellar-rack", kind: "shelf", x: 9, y: 9, w: 26, h: 220 }');
    // GROUND's rack, same coordinates, must not have moved.
    expect(next).toContain('{ id: "demo-rack", kind: "shelf", x: 100, y: 120, w: 26, h: 220, scannable: true }');
  });

  it("takes a negative coordinate", () => {
    const next = applyEdit(FILE, { op: "moveObject", floor: "GROUND", id: "demo-crate", x: -20, y: 4 });
    expect(next).toContain('{ id: "demo-crate", kind: "crateStack", x: -20, y: 4, w: 34, h: 34 }');
  });
});

describe("deleting an entry", () => {
  it("removes the line and nothing else", () => {
    const next = applyEdit(FILE, { op: "deleteObject", floor: "GROUND", id: "demo-crate" });
    expect(next).not.toContain("demo-crate");
    expect(next.split("\n")).toEqual(FILE.split("\n").filter((line) => !line.includes("demo-crate")));
  });

  it("leaves the array valid when it empties out", () => {
    const next = applyEdit(FILE, { op: "deleteDot", floor: "GROUND", id: "demo-dot" });
    expect(next).toContain("dots: [\n      ],");
  });
});

describe("adding an entry", () => {
  it("appends an object at the array's own indentation", () => {
    const next = applyEdit(FILE, {
      op: "addObject",
      floor: "GROUND",
      object: { id: "demo-new", kind: "drum", x: 300, y: 250, w: 24, h: 24 },
    });
    expect(next).toContain('        { id: "demo-new", kind: "drum", x: 300, y: 250, w: 24, h: 24 },\n      ],');
    // The entries already there are untouched.
    expect(next).toContain('{ id: "demo-crate", kind: "crateStack", x: 200, y: 120, w: 34, h: 34 },');
  });

  it("appends into an empty array, keeping it on one line", () => {
    const next = applyEdit(FILE, {
      op: "addDot",
      floor: "B1",
      dot: { id: "demo-cellar-dot", item: { kind: "powerup", type: "radar" }, x: 50, y: 60 },
    });
    expect(next).toContain('dots: [{ id: "demo-cellar-dot", item: { kind: "powerup", type: "radar" }, x: 50, y: 60 }],');
  });

  it("appends a wall", () => {
    const next = applyEdit(FILE, {
      op: "addWall",
      floor: "GROUND",
      wall: { id: "demo-new-wall", thickness: 8, path: [{ x: 40, y: 250 }, { x: 200, y: 250 }] },
    });
    expect(next).toContain('{ id: "demo-new-wall", thickness: 8, path: [{ x: 40, y: 250 }, { x: 200, y: 250 }] },');
    expect(next).toContain("// A comment that must survive.");
  });

  it("appends a stair to the building", () => {
    const next = applyEdit(FILE, {
      op: "addStair",
      stair: { id: "demo-stair-b", rect: { x: 200, y: 40, w: 88, h: 148 }, from: "GROUND", to: "B1", bottom: "N" },
    });
    expect(next).toContain('{ id: "demo-stair-b", rect: { x: 200, y: 40, w: 88, h: 148 }, from: "GROUND", to: "B1", bottom: "N" },');
  });
});

describe("adding an opening to a wall", () => {
  it("extends an openings array that already exists, inline", () => {
    const next = applyEdit(FILE, {
      op: "addOpening",
      floor: "GROUND",
      wall: "demo-partition",
      opening: { kind: "window", width: 44, near: { x: 240, y: 100 } },
    });
    expect(next).toContain('openings: [{ kind: "door", width: 56, near: { x: 120, y: 100 } }, { kind: "window", width: 44, near: { x: 240, y: 100 } }],');
  });

  it("gives a wall with no openings its first one", () => {
    const next = applyEdit(FILE, {
      op: "addOpening",
      floor: "GROUND",
      wall: "demo-bare",
      opening: { kind: "door", width: 56, near: { x: 100, y: 200 } },
    });
    expect(next).toContain('openings: [{ kind: "door", width: 56, near: { x: 100, y: 200 } }],');
    expect(next).toContain('id: "demo-bare"');
  });
});

describe("what it refuses to guess at", () => {
  it("names a helper-produced object instead of silently doing nothing", () => {
    expect(() => applyEdit(FILE, { op: "moveObject", floor: "GROUND", id: "x-g-pan", x: 1, y: 1 }))
      .toThrow(PatchError);
    expect(() => applyEdit(FILE, { op: "moveObject", floor: "GROUND", id: "x-g-pan", x: 1, y: 1 }))
      .toThrow(/produced by a helper/);
  });

  it("rejects an unknown floor", () => {
    expect(() => applyEdit(FILE, { op: "moveObject", floor: "F9", id: "demo-rack", x: 1, y: 1 }))
      .toThrow(/No floor labelled F9/);
  });

  it("rejects an unknown object", () => {
    expect(() => applyEdit(FILE, { op: "deleteObject", floor: "GROUND", id: "nope" })).toThrow(PatchError);
  });
});

describe("a run of edits", () => {
  it("applies in order and stays parseable-looking", () => {
    const next = applyEdits(FILE, [
      { op: "moveObject", floor: "GROUND", id: "demo-rack", x: 104, y: 124 },
      { op: "deleteObject", floor: "GROUND", id: "demo-crate" },
      { op: "addObject", floor: "GROUND", object: { id: "demo-bench", kind: "workbench", x: 60, y: 260, w: 112, h: 34 } },
    ]);
    expect(next).toContain('{ id: "demo-rack", kind: "shelf", x: 104, y: 124, w: 26, h: 220, scannable: true }');
    expect(next).not.toContain("demo-crate");
    expect(next).toContain('{ id: "demo-bench", kind: "workbench", x: 60, y: 260, w: 112, h: 34 },');
    // Brackets still balance.
    for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
      const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
      expect(count(next, open)).toBe(count(next, close));
    }
  });
});

/**
 * The real files, not a fixture. A patch that works on a toy and mangles Civic
 * Tower is worthless, and this is the cheapest way to keep them honest.
 */
describe("against the shipped source files", () => {
  /**
   * The real files, read through Vite so this needs no node typings. A patch that
   * works on the fixture above and mangles Civic Tower would be worthless.
   */
  const shipped = (import.meta as unknown as {
    glob: (pattern: string, options: Record<string, unknown>) => Record<string, string>;
  }).glob("./content/*.ts", { query: "?raw", import: "default", eager: true });
  const files = [
    ["lot6Depot", "GROUND", "lot6-rack-a"],
    ["mercyClinic", "GROUND", "mercy-reception"],
    ["civicTower", "F3", "civic-board-table"],
    ["beaconHouse", "F1", "beacon-nw-bed"],
  ] as const;

  for (const [name, floor, id] of files) {
    it(`moves ${id} in ${name}.ts and changes one line`, () => {
      const text = shipped[`./content/${name}.ts`];
      expect(text, `${name}.ts should be readable`).toBeTypeOf("string");
      const next = applyEdit(text, { op: "moveObject", floor, id, x: 1234, y: 5678 });
      const before = text.split("\n");
      const after = next.split("\n");
      expect(after).toHaveLength(before.length);
      const changed = after.filter((line, index) => line !== before[index]);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toContain("x: 1234, y: 5678");
    });
  }
});
