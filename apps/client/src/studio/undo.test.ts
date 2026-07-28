import { describe, expect, it } from "vitest";
import { BUILDING_SOURCES } from "@dotbot/game/content/sources";
import type { SourceEdit } from "@dotbot/game/mapSourcePatch";
import { beginSession, commit, pendingCount, undo, undoTarget } from "./editing";

/**
 * Taking an edit back.
 *
 * Studio's one invariant is that an edit exists once, as a `SourceEdit`, and is used
 * twice — against an in-memory source so the canvas updates now, and against the file's
 * text on save. Undo has to respect that or it becomes a third representation, which is
 * the bug the whole tool is shaped to avoid.
 *
 * So it replays the log without its last entry rather than applying an inverse. These
 * tests are written against the properties that makes true, because they are the ones an
 * inverse-edit stack would get subtly wrong.
 */

const CIVIC = "civic";
const MERCY = "mercy";

/** A real building and a real floor, so nothing here depends on a fixture. */
function civicGroundFloor() {
  const floor = BUILDING_SOURCES[CIVIC]!.source.floors.find((f) => f.label === "GROUND")!;
  return floor;
}

const addPlant = (id: string, x: number): SourceEdit => ({
  op: "addObject",
  floor: "GROUND",
  object: { id, kind: "plant", x, y: 480, w: 20, h: 20 },
});

describe("undo", () => {
  it("has nothing to take back on a fresh session", () => {
    const session = beginSession([CIVIC]);
    expect(undoTarget(session)).toBeNull();
    expect(undo(session)).toBeNull();
    expect(pendingCount(session)).toBe(0);
  });

  it("returns the source to exactly what it was before the edit", () => {
    /**
     * Deep equality against the pristine registry entry, not just a count. An inverse that
     * leaves an empty `objects: []` where there was no array, or reorders a list, passes a
     * length check and still writes a different file.
     */
    const session = beginSession([CIVIC]);
    const before = structuredClone(session.sources[CIVIC]);

    commit(session, CIVIC, addPlant("civic-undo-probe", 1600));
    expect(session.sources[CIVIC]).not.toEqual(before);

    undo(session);
    expect(session.sources[CIVIC]).toEqual(before);
    expect(session.edits[CIVIC]).toEqual([]);
  });

  it("never touches the registry, however many times it replays", () => {
    // The replay clones `BUILDING_SOURCES` every time. If it ever mutated the registry
    // instead, the second undo would rebuild from an already-edited base.
    const pristine = structuredClone(BUILDING_SOURCES[CIVIC]!.source);
    const session = beginSession([CIVIC]);
    for (let i = 0; i < 4; i += 1) commit(session, CIVIC, addPlant(`probe-${i}`, 1600 + i * 40));
    for (let i = 0; i < 4; i += 1) undo(session);
    expect(BUILDING_SOURCES[CIVIC]!.source).toEqual(pristine);
    expect(session.sources[CIVIC]).toEqual(pristine);
  });

  it("unwinds in the order the edits were made, one at a time", () => {
    const session = beginSession([CIVIC]);
    commit(session, CIVIC, addPlant("first", 1600));
    commit(session, CIVIC, addPlant("second", 1640));
    commit(session, CIVIC, addPlant("third", 1680));

    const ids = () => (session.sources[CIVIC].floors.find((f) => f.label === "GROUND")!.objects ?? [])
      .map((o) => o.id);
    expect(ids()).toContain("third");

    undo(session);
    expect(ids()).not.toContain("third");
    expect(ids()).toContain("second");

    undo(session);
    expect(ids()).not.toContain("second");
    expect(ids()).toContain("first");
  });

  it("takes back the last thing you did, not the last thing you did here", () => {
    /**
     * The reason the session carries an `order` at all. The per-building logs are what the
     * save path replays and they cannot say which building was touched most recently — so
     * with only those, undo after switching buildings would unwind the wrong one, which is
     * the single most confusing thing an undo can do.
     */
    const session = beginSession([CIVIC, MERCY]);
    commit(session, CIVIC, addPlant("civic-one", 1600));
    commit(session, MERCY, { op: "addObject", floor: "GROUND", object: { id: "mercy-one", kind: "plant", x: 300, y: 300, w: 20, h: 20 } });

    expect(undoTarget(session)).toBe(MERCY);
    expect(undo(session)?.building).toBe(MERCY);
    expect(session.edits[CIVIC]).toHaveLength(1);

    expect(undoTarget(session)).toBe(CIVIC);
    expect(undo(session)?.building).toBe(CIVIC);
    expect(pendingCount(session)).toBe(0);
  });

  it("leaves the save log as the single record of what happened", () => {
    /**
     * The property that makes this safe rather than merely convenient. `saveSession`
     * replays `session.edits` against the file text, so an undone edit is undone on disk
     * for free — there is no second place holding a shadow copy that could disagree.
     */
    const session = beginSession([CIVIC]);
    commit(session, CIVIC, addPlant("kept", 1600));
    commit(session, CIVIC, addPlant("dropped", 1640));
    undo(session);
    expect(session.edits[CIVIC].map((edit) => edit.op === "addObject" ? edit.object.id : edit.op))
      .toEqual(["kept"]);
  });

  it("rebuilds a compiled building that reflects the undo", () => {
    // The canvas draws the compiled result, so undo has to hand one back, not just tidy
    // the log. Civic GROUND is authored with objects, so a removal is observable.
    const authored = (civicGroundFloor().objects ?? []).length;
    const session = beginSession([CIVIC]);
    commit(session, CIVIC, addPlant("civic-visible-probe", 1600));
    const result = undo(session);
    expect(result).not.toBeNull();
    const ground = result!.rebuilt.floors.find((floor) => floor.label === "GROUND")!;
    // Compiled floors carry more than the authored objects (stair guards and so on), so
    // the assertion is that the probe is gone rather than an absolute count.
    expect(ground.objects.some((object) => object.id === "civic-visible-probe")).toBe(false);
    expect(authored).toBeGreaterThan(0);
  });
});
