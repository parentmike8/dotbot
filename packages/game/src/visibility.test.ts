import { describe, expect, it } from "vitest";
import { pixelCityBlockMap } from "./content/pixelCityBlock";
import { exteriorVisualVisionContext } from "./visibility";

function includesSegment(
  segments: ReturnType<typeof exteriorVisualVisionContext>["walls"],
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  return segments.some((segment) =>
    (segment.ax === ax && segment.ay === ay && segment.bx === bx && segment.by === by)
    || (segment.ax === bx && segment.ay === by && segment.bx === ax && segment.by === ay),
  );
}

describe("exteriorVisualVisionContext", () => {
  it("exposes a south-facing facade but keeps its far silhouette", () => {
    const building = pixelCityBlockMap.buildings.find((item) => item.id === "pixel-parts")!;
    const { x, y, w, h } = building.footprint;
    const context = exteriorVisualVisionContext(pixelCityBlockMap, { x: x + w / 2, y: y + h + 100 });

    expect(includesSegment(context.walls, x, y + h, x + w, y + h)).toBe(false);
    expect(includesSegment(context.walls, x, y, x + w, y)).toBe(true);
  });
});
