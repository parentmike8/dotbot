import { describe, expect, it } from "vitest";
import { createBaseMap, starterBaseLayout } from "@dotbot/game/content/base";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
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
    const position = map.interactionDots!.find((dot) => dot.kind === "deployment")!.position;
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

  it("resolves objects and empty slots only from the bot's active base floor", () => {
    const map = createBaseMap({ ...starterBaseLayout, "up-wall-a": "locker" }, "workshop", { expanded: true });
    const groundDot = map.interactionDots!.find((dot) => dot.kind === "object" && dot.floorId === "player-base:GROUND")!;
    const upperDot = map.interactionDots!.find((dot) => dot.kind === "object" && dot.floorId === "player-base:F1")!;
    upperDot.position = { ...groundDot.position };
    const position = groundDot.position;

    expect(findBaseTarget(map, position, OUTDOOR_FLOOR_ID)).toMatchObject({ id: groundDot.id, type: "object" });
    expect(findBaseTarget(map, position, "player-base:F1")).toMatchObject({ id: upperDot.id, type: "object", object: { slotId: "up-wall-a" } });

    const deploymentDot = map.interactionDots!.find((dot) => dot.kind === "deployment")!;
    expect(findBaseTarget(map, deploymentDot.position, "player-base:F1")?.type).not.toBe("deployment");
  });

  it("uses world-dot capture range and resolves nearest ties by stable dot id", () => {
    const map = createBaseMap({});
    const [first, second] = map.interactionDots!.filter((dot) => dot.kind === "emptySlot").slice(0, 2);
    const position = { x: 400, y: 400 };
    first.position = { x: position.x + 12, y: position.y };
    second.position = { x: position.x - 12, y: position.y };

    const expected = [first, second].sort((a, b) => a.id.localeCompare(b.id))[0].id;
    expect(findBaseTarget(map, position)?.id).toBe(expected);
    map.interactionDots!.reverse();
    expect(findBaseTarget(map, position)?.id).toBe(expected);

    first.position = { x: position.x + 12.01, y: position.y };
    second.position = { x: position.x - 12.01, y: position.y };
    expect(findBaseTarget(map, position)).toBeNull();
  });
});
