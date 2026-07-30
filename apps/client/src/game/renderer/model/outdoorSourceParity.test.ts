import { describe, expect, it } from "vitest";
import { worldMap } from "@dotbot/game/content/world";
import { objectSolids } from "@dotbot/game/collision";
import { solidBounds } from "@dotbot/game/geometry";
import { buildOutdoorModel } from "./modelOutdoor";

describe("authored outdoor visible/collision parity", () => {
  it("rebuilds the production glyph and collider from the same moved rectangle", () => {
    const original = worldMap.outdoor.objects.find((object) =>
      object.source?.kind === "authored" && object.kind === "crateStack")!;
    const moved = { ...original, x: original.x + 64, y: original.y + 40 };
    const map = {
      id: "parity",
      name: "Parity",
      width: 600,
      height: 600,
      outdoor: {
        roads: [],
        parks: [],
        walls: [],
        objects: [moved],
        dotSpawns: [],
      },
      buildings: [],
      extractionPoints: [],
      insertionPoints: [],
      botSpawns: [],
    };

    const visible = buildOutdoorModel(map).objectViews.get(moved.id)!;
    const collision = solidBounds(objectSolids(moved)[0]);
    const bounds = visible.view.getBounds();

    expect(visible.object).toBe(moved);
    expect(collision).toEqual({ x: moved.x, y: moved.y, w: moved.w, h: moved.h });
    expect(bounds.x).toBeLessThanOrEqual(collision.x);
    expect(bounds.y).toBeLessThanOrEqual(collision.y);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(collision.x + collision.w);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(collision.y + collision.h);
    expect(bounds.x).toBeGreaterThan(original.x);
    expect(bounds.y).toBeGreaterThan(original.y);
  });
});
