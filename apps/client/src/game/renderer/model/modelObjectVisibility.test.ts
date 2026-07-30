import { describe, expect, it } from "vitest";
import {
  BASE_TUTORIAL_FABRICATOR_ID,
  type BaseTutorialState,
} from "@dotbot/game/baseTutorial";
import { createBaseMap, starterBaseLayout } from "@dotbot/game/content/base";
import { buildFloorModel, setFloorObjectViewEnabled } from "./modelFloor";

describe("floor object visual and collision parity", () => {
  const movement: BaseTutorialState = { phase: "movement", revision: 0 };

  it("keeps a disabled object's ink, shadows, and ambient occlusion invisible together", () => {
    const map = createBaseMap(starterBaseLayout, "workshop", { tutorial: movement });
    const building = map.buildings[0];
    const floor = building.floors[0];
    const model = buildFloorModel(building, floor);
    const handle = model.objectViews.get(BASE_TUTORIAL_FABRICATOR_ID)!;

    expect(handle.object.enabled).toBe(false);
    expect(handle.view.visible).toBe(false);
    expect(handle.effects!.length).toBeGreaterThan(0);
    expect(handle.effects!.every((effect) => effect.visible === false)).toBe(true);
  });

  it("toggles every visual contribution idempotently with the authored enabled state", () => {
    const map = createBaseMap(starterBaseLayout, "workshop", { tutorial: movement });
    const building = map.buildings[0];
    const floor = building.floors[0];
    const model = buildFloorModel(building, floor);
    const handle = model.objectViews.get(BASE_TUTORIAL_FABRICATOR_ID)!;
    const furnitureChildCount = model.furniture.children.length;

    expect(setFloorObjectViewEnabled(handle, true)).toBe(true);
    expect(setFloorObjectViewEnabled(handle, true)).toBe(false);
    expect(handle.object.enabled).toBe(true);
    expect(handle.view.visible).toBe(true);
    expect(handle.effects!.every((effect) => effect.visible)).toBe(true);
    expect(model.furniture.children).toHaveLength(furnitureChildCount);

    expect(setFloorObjectViewEnabled(handle, false)).toBe(true);
    expect(setFloorObjectViewEnabled(handle, false)).toBe(false);
    expect(handle.object.enabled).toBe(false);
    expect(handle.view.visible).toBe(false);
    expect(handle.effects!.every((effect) => effect.visible === false)).toBe(true);
    expect(model.furniture.children).toHaveLength(furnitureChildCount);
  });
});
