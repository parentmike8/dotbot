import { describe, expect, it } from "vitest";
import { worldMap } from "@dotbot/game/content/world";
import { outdoorSourceOf } from "@dotbot/game/outdoorSource";
import {
  beginSession,
  commitOutdoor,
  editedSources,
  outdoorHandles,
  pendingCount,
  rebuildMap,
  reloadSession,
  saveSession,
  undo,
} from "./editing";

const DOWNTOWN = { x: 0, y: 0, w: 2400, h: 1600 };

describe("outdoor Studio handles", () => {
  it("makes authored objects movable and derived rule output inspection-only", () => {
    const handles = outdoorHandles(worldMap, DOWNTOWN);
    const authored = handles.find((handle) =>
      handle.kind === "outdoorObject" && outdoorSourceOf(worldMap.outdoor.objects.find((object) => object.id === handle.id)!)?.kind === "authored");
    const derived = handles.find((handle) =>
      handle.kind === "outdoorObject" && handle.source?.kind === "derived");

    expect(authored).toMatchObject({ movable: true, resizable: true });
    expect(derived).toMatchObject({ movable: false, resizable: false });
    expect(derived?.source).toMatchObject({
      kind: "derived",
      rule: { label: expect.any(String), spacing: expect.any(Number), gaps: expect.any(Array) },
    });
  });

  it("shows insertion, extraction and bot spawns honestly without implying drag support", () => {
    const handles = outdoorHandles(worldMap, DOWNTOWN);
    expect(handles.some((handle) => handle.kind === "insertion" && !handle.movable)).toBe(true);
    expect(handles.some((handle) => handle.kind === "extraction" && !handle.movable)).toBe(true);
    expect(handles.some((handle) => handle.kind === "botSpawn" && !handle.movable)).toBe(true);
  });
});

describe("outdoor edit session", () => {
  it("moves an authored object, rebuilds the production map, undoes, and reloads cleanly", () => {
    const session = beginSession(
      worldMap.buildings.filter((building) => building.id === "mercy").map((building) => building.id),
      worldMap,
    );
    const handle = outdoorHandles(worldMap, DOWNTOWN)
      .find((candidate) => candidate.kind === "outdoorObject" && candidate.source?.kind === "authored")!;
    const before = worldMap.outdoor.objects.find((object) => object.id === handle.id)!;

    commitOutdoor(session, {
      op: "moveOutdoorObject",
      id: handle.id,
      source: handle.source as Extract<NonNullable<typeof handle.source>, { kind: "authored" }>,
      x: before.x + 8,
      y: before.y + 4,
    });
    const moved = rebuildMap(worldMap, session).outdoor.objects.find((object) => object.id === handle.id)!;
    expect(moved).toMatchObject({ x: before.x + 8, y: before.y + 4 });
    expect(pendingCount(session)).toBe(1);
    expect(editedSources(session)).toEqual([handle.source!.file.split("/").at(-1)]);

    undo(session);
    expect(rebuildMap(worldMap, session).outdoor.objects.find((object) => object.id === handle.id))
      .toEqual(before);

    commitOutdoor(session, {
      op: "moveOutdoorObject",
      id: handle.id,
      source: handle.source as Extract<NonNullable<typeof handle.source>, { kind: "authored" }>,
      x: before.x + 8,
      y: before.y + 4,
    });
    reloadSession(session);
    expect(pendingCount(session)).toBe(0);
    expect(rebuildMap(worldMap, session).outdoor.objects.find((object) => object.id === handle.id))
      .toEqual(before);
  });

  it("refuses to commit a derived object move", () => {
    const session = beginSession([], worldMap);
    const derived = outdoorHandles(worldMap, DOWNTOWN)
      .find((candidate) => candidate.kind === "outdoorObject" && candidate.source?.kind === "derived")!;
    expect(() => commitOutdoor(session, {
      op: "moveOutdoorObject",
      id: derived.id,
      source: derived.source as never,
      x: derived.rect.x + 8,
      y: derived.rect.y,
    })).toThrow(/placing rule/i);
  });

  it("refuses a dirty source file and keeps the edit pending for reload", async () => {
    const session = beginSession([], worldMap);
    const handle = outdoorHandles(worldMap, DOWNTOWN)
      .find((candidate) => candidate.kind === "outdoorObject" && candidate.source?.kind === "authored")!;
    session.fileBases[handle.source!.file] = "the source Studio loaded";
    commitOutdoor(session, {
      op: "moveOutdoorObject",
      id: handle.id,
      source: handle.source as Extract<NonNullable<typeof handle.source>, { kind: "authored" }>,
      x: handle.rect.x + 4,
      y: handle.rect.y,
    });
    const before = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, text: "someone else changed it" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await saveSession(session);
      expect(result).toEqual([expect.objectContaining({
        ok: false,
        detail: expect.stringMatching(/changed on disk/i),
      })]);
      expect(calls).toHaveLength(1);
      expect(pendingCount(session)).toBe(1);
    } finally {
      globalThis.fetch = before;
    }
  });

  it("refuses to save before the source baseline has loaded", async () => {
    const session = beginSession([], worldMap);
    const handle = outdoorHandles(worldMap, DOWNTOWN)
      .find((candidate) => candidate.kind === "outdoorObject" && candidate.source?.kind === "authored")!;
    commitOutdoor(session, {
      op: "moveOutdoorObject",
      id: handle.id,
      source: handle.source as Extract<NonNullable<typeof handle.source>, { kind: "authored" }>,
      x: handle.rect.x + 4,
      y: handle.rect.y,
    });
    const before = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      text: "source read after editing began",
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const result = await saveSession(session);
      expect(result).toEqual([expect.objectContaining({
        ok: false,
        detail: expect.stringMatching(/no loaded source baseline/i),
      })]);
      expect(pendingCount(session)).toBe(1);
    } finally {
      globalThis.fetch = before;
    }
  });
});
