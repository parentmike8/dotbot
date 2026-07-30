import { Container, Graphics } from "pixi.js";
import { describe, expect, it } from "vitest";
import { collectSolids } from "@dotbot/game/collision";
import { downtownMap } from "@dotbot/game/content/downtown";
import { worldMap } from "@dotbot/game/content/world";
import { buildMapArt } from "../game/renderer/mapArt";
import { StudioParallax } from "./parallax";
import {
  replaceStudioMapArt,
  studioFloorId,
  studioOverlaySolids,
} from "./presentation";

describe("Studio building overlay physics ownership", () => {
  for (const [buildingId, label] of [
    ["mercy", "GROUND"],
    ["civic", "F1"],
  ] as const) {
    it(`resolves ${buildingId} ${label} to its compiled floor id`, () => {
      const floor = worldMap.buildings
        .find((building) => building.id === buildingId)!
        .floors.find((candidate) => candidate.label === label)!;

      expect(floor.id).not.toBe(label);
      expect(studioFloorId(worldMap, buildingId, label)).toBe(floor.id);
    });

    it(`draws ${buildingId} ${label} solids in collision and clearance overlays`, () => {
      const floor = worldMap.buildings
        .find((building) => building.id === buildingId)!
        .floors.find((candidate) => candidate.label === label)!;
      const expected = collectSolids(worldMap, floor.id);
      const overlays = studioOverlaySolids({
        map: worldMap,
        building: buildingId,
        floor: label,
        showCollision: true,
        showClearance: true,
      });

      expect(expected.length).toBeGreaterThan(10);
      expect(overlays.collision).toEqual(expected);
      expect(overlays.clearance).toEqual(expected);
    });
  }
});

describe("Studio production map-art lifecycle", () => {
  it("mounts root then production overhead below the editor overlay", () => {
    const world = new Container();
    const overlay = new Graphics();
    world.addChild(overlay);
    const art = buildMapArt(downtownMap);

    replaceStudioMapArt(world, overlay, null, art);

    expect(world.children).toEqual([art.root, art.overhead, overlay]);
    expect(art.overhead.parent).toBe(world);
    expect([...art.outdoorObjectViews.values()]
      .some((handle) => handle.elevated.children.length > 0)).toBe(true);
  });

  it("keeps mounted overhead parts on the shared camera and parallax path", () => {
    const world = new Container();
    const overlay = new Graphics();
    world.addChild(overlay);
    const art = replaceStudioMapArt(world, overlay, null, buildMapArt(downtownMap));
    const handle = [...art.outdoorObjectViews.values()]
      .find((candidate) => candidate.elevated.children.length > 0)!;
    const parallax = new StudioParallax();
    const bounds = { x: 0, y: 0, w: downtownMap.width, h: downtownMap.height };

    world.position.set(41, 73);
    world.scale.set(0.75);
    parallax.update(art, { x: 400, y: 400 }, bounds, 1);
    const before = { x: handle.elevated.position.x, y: handle.elevated.position.y };
    parallax.update(art, { x: 1200, y: 900 }, bounds, 1);

    expect(handle.elevated.parent?.parent).toBe(art.overhead);
    expect(handle.elevated.position).not.toMatchObject(before);
    expect(art.root.parent).toBe(world);
    expect(art.overhead.parent).toBe(world);
  });

  it("destroys root and overhead without accumulating detached art across rebuilds", () => {
    const world = new Container();
    const overlay = new Graphics();
    world.addChild(overlay);
    const first = replaceStudioMapArt(world, overlay, null, buildMapArt(downtownMap));
    const firstElevated = [...first.outdoorObjectViews.values()]
      .find((handle) => handle.elevated.children.length > 0)!.elevated;
    const second = replaceStudioMapArt(world, overlay, first, buildMapArt(downtownMap));
    const third = replaceStudioMapArt(world, overlay, second, buildMapArt(downtownMap));

    expect(first.root.destroyed).toBe(true);
    expect(first.overhead.destroyed).toBe(true);
    expect(first.foreground.destroyed).toBe(true);
    expect(firstElevated.destroyed).toBe(true);
    expect(second.root.destroyed).toBe(true);
    expect(second.overhead.destroyed).toBe(true);
    expect(world.children).toEqual([third.root, third.overhead, overlay]);
  });
});
