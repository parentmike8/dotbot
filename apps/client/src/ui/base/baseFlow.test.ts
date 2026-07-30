import { describe, expect, it } from "vitest";
import { createBaseMap, starterBaseLayout } from "@dotbot/game/content/base";
import type { BaseTutorialState } from "@dotbot/game/baseTutorial";
import { defaultGameConfig } from "@dotbot/game/config";
import { interactionDotReach } from "@dotbot/game/interactions";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import { selectClientSurface } from "../../routing";
import { advanceBaseChannel, findBaseTarget } from "./baseFlow";

describe("base boot and deployment seams", () => {
  const tutorial = (phase: BaseTutorialState["phase"], revision: number): BaseTutorialState => ({ phase, revision });

  it("boots to the base while preserving explicit solo and studio development surfaces", () => {
    expect(selectClientSurface("")).toBe("base");
    expect(selectClientSurface("?solo")).toBe("solo");
    expect(selectClientSurface("?studio")).toBe("studio");
    expect(selectClientSurface("?studio&solo")).toBe("studio");
  });

  it("channels the deployment threshold for one stationary second and movement cancels", () => {
    const map = createBaseMap(starterBaseLayout, "workshop", { tutorial: tutorial("complete", 4) });
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

  it("keeps the bounded tutorial fabricator and completed item/deployment stations addressable on one map", () => {
    const incomplete = createBaseMap(starterBaseLayout, "workshop", { tutorial: tutorial("fabricator", 2) });
    const tutorialDot = incomplete.interactionDots!.find((dot) => dot.targetId === "base-intro-fabricator")!;
    expect(findBaseTarget(incomplete, tutorialDot.position)?.type).toBe("tutorialFabricator");

    const complete = createBaseMap(starterBaseLayout, "workshop", { tutorial: tutorial("complete", 4) });
    const deployment = complete.interactionDots!.find((dot) => dot.kind === "deployment")!;
    const locker = complete.interactionDots!.find((dot) => dot.kind === "object")!;
    expect(complete.interactionDots!.some((dot) => dot.targetId === "base-intro-fabricator")).toBe(false);
    expect(findBaseTarget(complete, deployment.position)?.type).toBe("deployment");
    expect(findBaseTarget(complete, locker.position)?.type).toBe("object");
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
    const map = createBaseMap(starterBaseLayout);
    const [first, second] = map.interactionDots!.filter((dot) => dot.kind === "object").slice(0, 2);
    const position = { x: 400, y: 400 };
    const reach = interactionDotReach(defaultGameConfig.botRadius, defaultGameConfig.dotRadius);
    first.position = { x: position.x + reach, y: position.y };
    second.position = { x: position.x - reach, y: position.y };

    const expected = [first, second].sort((a, b) => a.id.localeCompare(b.id))[0].id;
    expect(findBaseTarget(map, position)?.id).toBe(expected);
    map.interactionDots!.reverse();
    expect(findBaseTarget(map, position)?.id).toBe(expected);

    first.position = { x: position.x + reach + 0.01, y: position.y };
    second.position = { x: position.x - reach - 0.01, y: position.y };
    expect(findBaseTarget(map, position)).toBeNull();
  });
});
