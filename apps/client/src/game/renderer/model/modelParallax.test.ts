import { Container, Graphics } from "pixi.js";
import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { worldMap } from "@dotbot/game/content/world";
import type { Rect } from "@dotbot/game/types";
import { buildOutdoorModel } from "./modelOutdoor";
import {
  MAX_OBJECT_PARALLAX_STRENGTH,
  objectViewPull,
  parseObjectParallaxStrength,
  redrawOutdoorObjects,
} from "./modelParallax";

function instructionCount(root: Container): number {
  let count = root instanceof Graphics ? root.context.instructions.length : 0;
  for (const child of root.children) count += instructionCount(child);
  return count;
}

function containsNumber(value: unknown, wanted: number, seen = new Set<unknown>()): boolean {
  if (value === wanted) return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => containsNumber(child, wanted, seen));
}

describe("object parallax rule", () => {
  it("keeps the temple's ground-contact serpent heads in their authored shape", () => {
    const head = worldMap.outdoor.objects.find((object) => object.kind === "serpentHead")!;
    const viewCentre = { x: head.x - 600, y: head.y + 400 };

    expect(objectViewPull(head, viewCentre, 1)).toEqual({ x: 0, y: -1, scale: 1 });
  });

  it("gives every outdoor object one addressable redraw handle", () => {
    const outdoors = buildOutdoorModel(downtownMap);
    expect(outdoors.objectViews.size).toBe(downtownMap.outdoor.objects.length);
    for (const object of downtownMap.outdoor.objects) {
      expect(outdoors.objectViews.get(object.id)?.object).toBe(object);
    }
  });

  it("redraws only visible outdoor objects instead of all of Downtown", () => {
    const outdoors = buildOutdoorModel(downtownMap);
    const visible: Rect = { x: 760, y: 430, w: 720, h: 520 };
    const stats = redrawOutdoorObjects(
      outdoors.objectViews,
      { x: visible.x + visible.w / 2, y: visible.y + visible.h / 2 },
      1,
      visible,
    );

    expect(stats.redrawn).toBeGreaterThan(0);
    expect(stats.redrawn).toBeLessThan(outdoors.objectViews.size);
    expect(stats.total).toBe(outdoors.objectViews.size);
  });

  it("moves a lifted canopy with the tree redraw while its trunk stays planted", () => {
    const outdoors = buildOutdoorModel(downtownMap);
    const tree = downtownMap.outdoor.objects.find((object) => object.kind === "tree")!;
    const handle = outdoors.objectViews.get(tree.id)!;
    const lifted = handle.elevated.children[0];
    const originalParent = lifted.parent;
    const viewCentre = { x: tree.x - 500, y: tree.y - 300 };
    const visible: Rect = { x: tree.x - 100, y: tree.y - 100, w: tree.w + 200, h: tree.h + 200 };

    redrawOutdoorObjects(outdoors.objectViews, viewCentre, 1, visible);

    expect(Math.hypot(handle.elevated.position.x, handle.elevated.position.y)).toBeGreaterThan(2);
    expect(lifted.parent).toBe(originalParent);
    expect(lifted.parent).toBe(handle.elevated);
    expect(handle.view.position.x).toBe(0);
    expect(handle.view.position.y).toBe(0);
  });

  it("keeps a lamp post planted while its authored arm and head lean together", () => {
    const outdoors = buildOutdoorModel(downtownMap);
    const lamp = downtownMap.outdoor.objects.find((object) => object.kind === "lampPost")!;
    const handle = outdoors.objectViews.get(lamp.id)!;
    const lifted = handle.elevated.children[0];
    const visible: Rect = { x: lamp.x - 100, y: lamp.y - 100, w: lamp.w + 200, h: lamp.h + 200 };

    redrawOutdoorObjects(outdoors.objectViews, { x: lamp.x - 500, y: lamp.y }, 1, visible);

    expect(lifted.parent).toBe(handle.elevated);
    expect(handle.elevated.position.x).toBeGreaterThan(2);
    expect(handle.view.position.x).toBe(0);
    expect(handle.view.position.y).toBe(0);
  });

  it("keeps the canopy's decorative ground shadow out of the lifted sway group", () => {
    const outdoors = buildOutdoorModel(downtownMap);
    const tree = downtownMap.outdoor.objects.find((object) => object.kind === "tree")!;
    const handle = outdoors.objectViews.get(tree.id)!;
    const crown = handle.elevated.children[0] as Graphics;

    // `foliageMass` owns the deliberately authored 0.17-alpha ground shadow.
    expect(containsNumber(handle.view.context.instructions, 0.17)).toBe(true);
    expect(containsNumber(crown.context.instructions, 0.17)).toBe(false);
  });

  it("does not redraw or shift the ground-contact and shadow layers", () => {
    const outdoors = buildOutdoorModel(downtownMap);
    const before = instructionCount(outdoors.ground);
    const visible: Rect = { x: 0, y: 0, w: 900, h: 700 };

    redrawOutdoorObjects(outdoors.objectViews, { x: 450, y: 350 }, 2, visible);

    expect(instructionCount(outdoors.ground)).toBe(before);
    for (const { view } of outdoors.objectViews.values()) {
      expect(view.position.x).toBe(0);
      expect(view.position.y).toBe(0);
    }
  });
});

describe("the lab parallax control", () => {
  it("ships a restrained quarter-strength response", () => {
    expect(parseObjectParallaxStrength("")).toBe(0.25);
    expect(parseObjectParallaxStrength("?solo")).toBe(0.25);
  });

  it("keeps 0, 0.5, 1 and 2 as distinct strengths", () => {
    expect(parseObjectParallaxStrength("?parallax=0")).toBe(0);
    expect(parseObjectParallaxStrength("?parallax=0.25")).toBe(0.25);
    expect(parseObjectParallaxStrength("?parallax=0.5")).toBe(0.5);
    expect(parseObjectParallaxStrength("?parallax=1")).toBe(1);
    expect(parseObjectParallaxStrength("?parallax=2")).toBe(2);
  });

  it("bounds malformed and extreme values without collapsing the useful range", () => {
    expect(parseObjectParallaxStrength("?parallax=nope")).toBe(0.25);
    expect(parseObjectParallaxStrength("?parallax=-4")).toBe(0);
    expect(parseObjectParallaxStrength("?parallax=99")).toBe(MAX_OBJECT_PARALLAX_STRENGTH);
  });
});
