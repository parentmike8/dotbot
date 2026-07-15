import { describe, expect, it } from "vitest";
import { RECIPES } from "@dotbot/game/content/recipes";
import { glyphs } from "./glyphs";

describe("fabricable furniture glyph coverage", () => {
  it("has a renderer glyph for every furniture recipe output", () => {
    for (const recipe of RECIPES) {
      if (recipe.output.kind === "furniture") expect(glyphs[recipe.output.objectKind], recipe.id).toBeTypeOf("function");
    }
  });
});
