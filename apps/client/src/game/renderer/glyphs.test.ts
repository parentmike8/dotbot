import { describe, expect, it } from "vitest";
import { RECIPES } from "@dotbot/game/content/recipes";
import { rectSolid } from "@dotbot/game/geometry";
import { defaultGameConfig } from "@dotbot/game/config";
import { integrateWithWalls } from "@dotbot/game/kinematics";
import { objectCollisionRects, planningTableSurfaceRect } from "@dotbot/game/mapModel";
import type { MapObject } from "@dotbot/game/types";
import { glyphs } from "./glyphs";

describe("fabricable furniture glyph coverage", () => {
  it("has a renderer glyph for every furniture recipe output", () => {
    for (const recipe of RECIPES) {
      if (recipe.output.kind === "furniture") expect(glyphs[recipe.output.objectKind], recipe.id).toBeTypeOf("function");
    }
  });

  it("lets a bot approach to the visible contracts tabletop", () => {
    const object: MapObject = {
      id: "contracts-table",
      kind: "planningTable",
      x: 446,
      y: 246,
      w: 108,
      h: 72,
    };
    const table = planningTableSurfaceRect(object);
    const stopped = integrateWithWalls(
      { x: object.x - 80, y: table.y + table.h / 2 },
      { x: defaultGameConfig.playerSpeed, y: 0 },
      1000,
      defaultGameConfig.botRadius,
      objectCollisionRects(object).map(rectSolid),
    );

    expect(stopped.x + defaultGameConfig.botRadius).toBeCloseTo(table.x, 5);
  });
});
