import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "@dotbot/game/config";
import { cornerShopMap } from "@dotbot/game/content/cornerShop";
import { isSolidObject, objectCollisionRects } from "@dotbot/game/mapModel";
import { RETAIL_SCALE, retailProductLayout } from "./retailGlyphs";

const objects = cornerShopMap.buildings.flatMap((building) => building.floors).flatMap((floor) => floor.objects);
const retailObjects = objects.filter((object) => object.visualStyle === "retail");

describe("code-drawn retail fixture system", () => {
  it("uses one fixed world-unit product scale in differently sized fixtures", () => {
    const layouts = [
      retailProductLayout({ x: 0, y: 0, w: 22, h: 104 }, 0),
      retailProductLayout({ x: 0, y: 0, w: 44, h: 44 }, 1),
      retailProductLayout({ x: 0, y: 0, w: 62, h: 118 }, 2),
    ];

    expect(layouts.every((layout) => layout.length > 0)).toBe(true);
    expect(new Set(layouts.flat().map((mark) => mark.size))).toEqual(new Set([RETAIL_SCALE.product]));
    expect(RETAIL_SCALE.product).toBeLessThan(defaultGameConfig.botRadius);
  });

  it("keeps every visible retail fixture on its exact physics rectangle", () => {
    for (const object of retailObjects.filter((object) => !object.collisionParts)) {
      expect(objectCollisionRects(object).map(({ x, y, w, h }) => ({ x, y, w, h })), object.id).toEqual([
        { x: object.x, y: object.y, w: object.w, h: object.h },
      ]);
    }
  });

  it("uses the U counter's three visible arms as its only collision", () => {
    const counter = retailObjects.find((object) => object.id === "checkout-counter")!;
    expect(counter.collisionParts).toEqual([
      { x: 0, y: 0, w: 292, h: 76 },
      { x: 0, y: 76, w: 104, h: 196 },
      { x: 0, y: 272, w: 292, h: 76 },
    ]);
    expect(objectCollisionRects(counter).map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([
      { x: 148, y: 348, w: 292, h: 76 },
      { x: 148, y: 424, w: 104, h: 196 },
      { x: 148, y: 620, w: 292, h: 76 },
    ]);
  });

  it("varies rack proportions without changing the physical part scale", () => {
    const shelves = retailObjects.filter((object) => object.kind === "shelf");
    expect(shelves.length).toBeGreaterThanOrEqual(7);
    expect(new Set(shelves.map((shelf) => `${shelf.w}x${shelf.h}`)).size).toBeGreaterThan(2);
    expect(shelves.every((shelf) => Math.min(shelf.w, shelf.h) >= RETAIL_SCALE.product * 6)).toBe(true);
  });

  it("reserves dark closed outlines for solid fixtures and pale mats for passable detail", () => {
    expect(retailObjects.every(isSolidObject)).toBe(true);
    const passable = objects.filter((object) => !isSolidObject(object));
    expect(passable.length).toBeGreaterThan(0);
    expect(passable.every((object) => object.kind === "rug" || object.kind === "floorTiles")).toBe(true);
    expect(passable.every((object) => object.visualStyle !== "retail")).toBe(true);
  });

  it("draws every floor's market anchors through the code fixture kit", () => {
    const supportedKinds = new Set(["counter", "fridge", "kiosk", "produceDisplay", "shelf"]);
    expect(retailObjects.every((object) => supportedKinds.has(object.kind))).toBe(true);
    for (const floor of cornerShopMap.buildings[0].floors) {
      expect(floor.objects.some((object) => object.visualStyle === "retail"), floor.id).toBe(true);
    }
  });
});
