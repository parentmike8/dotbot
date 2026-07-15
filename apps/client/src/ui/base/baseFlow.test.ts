import { describe, expect, it } from "vitest";
import { createBaseMap, starterBaseLayout } from "@dotbot/game/content/base";
import { selectClientSurface } from "../../routing";
import { advanceBaseChannel, findBaseTarget } from "./baseFlow";

describe("base boot and deployment seams", () => {
  it("boots to the base while preserving explicit solo and studio development surfaces", () => {
    expect(selectClientSurface("")).toBe("base");
    expect(selectClientSurface("?solo")).toBe("solo");
    expect(selectClientSurface("?studio")).toBe("studio");
    expect(selectClientSurface("?studio&solo")).toBe("studio");
  });

  it("channels the deployment threshold for one stationary second and movement cancels", () => {
    const map = createBaseMap(starterBaseLayout);
    const threshold = map.extractionPoints[0].rect;
    const position = { x: threshold.x + threshold.w / 2, y: threshold.y + threshold.h / 2 };
    const target = findBaseTarget(map, position);
    expect(target?.type).toBe("deployment");

    const entered = advanceBaseChannel(null, target, position, 100);
    expect(entered.progress).toBe(0);
    expect(entered.completed).toBeNull();
    const almost = advanceBaseChannel(entered.state, target, position, 1099);
    expect(almost.progress).toBeCloseTo(0.999);
    expect(almost.completed).toBeNull();
    const completed = advanceBaseChannel(almost.state, target, position, 1100);
    expect(completed.progress).toBe(1);
    expect(completed.completed?.type).toBe("deployment");

    const moved = advanceBaseChannel(entered.state, target, { x: position.x + 4, y: position.y }, 1100);
    expect(moved.progress).toBe(0);
    expect(moved.completed).toBeNull();
  });
});
