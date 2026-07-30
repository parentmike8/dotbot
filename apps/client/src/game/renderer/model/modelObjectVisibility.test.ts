import { describe, expect, it } from "vitest";
import {
  BASE_TUTORIAL_FABRICATOR_ID,
  type BaseTutorialState,
} from "@dotbot/game/baseTutorial";
import { createBaseMap, starterBaseLayout } from "@dotbot/game/content/base";
import { downtownMap } from "@dotbot/game/content/downtown";
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
    expect(model.furniture.children.length - 1).toBe(32);
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

  it("retires the dynamic effect island with the completed tutorial fixture", () => {
    const complete = createBaseMap(starterBaseLayout, "workshop", {
      tutorial: { phase: "complete", revision: 4 },
    });
    const building = complete.buildings[0];
    const model = buildFloorModel(building, building.floors[0]);

    expect(model.objectViews.has(BASE_TUTORIAL_FABRICATOR_ID)).toBe(false);
    expect(model.furniture.children.length - 1).toBe(16);
    expect([...model.objectViews.values()].every((handle) => handle.effects === undefined)).toBe(true);
    expect(building.floors[0].objects.every((object) => object.enabled === undefined)).toBe(true);
  });

  it("keeps production indoor effects at the shared-floor baseline", () => {
    const floors = downtownMap.buildings.flatMap((building) =>
      building.floors.map((floor) => ({ building, floor })));
    const indoorObjectCount = floors.reduce((total, { floor }) => total + floor.objects.length, 0);
    const productionObjectCount = indoorObjectCount + downtownMap.outdoor.objects.length;
    const effectNodeCount = floors.reduce((total, { building, floor }) => {
      const model = buildFloorModel(building, floor);
      return total + model.furniture.children.length - 1;
    }, 0);
    const priorPerObjectEffectNodeCount = indoorObjectCount * 16;

    expect(downtownMap.outdoor.objects).toHaveLength(104);
    expect(productionObjectCount).toBe(383);
    expect(floors).toHaveLength(16);
    expect(indoorObjectCount).toBe(279);
    expect(priorPerObjectEffectNodeCount).toBe(4_464);
    expect(effectNodeCount).toBe(256);
  });
});
