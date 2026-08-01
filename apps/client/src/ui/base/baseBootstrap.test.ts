import { describe, expect, it } from "vitest";
import { shouldPauseForBaseBootstrap } from "./baseBootstrap";

describe("base identity degradation", () => {
  it("never pauses the local base for identity or storage bootstrap", () => {
    expect(shouldPauseForBaseBootstrap(true, false)).toBe(false);
    expect(shouldPauseForBaseBootstrap(true, true)).toBe(false);
    expect(shouldPauseForBaseBootstrap(false, true)).toBe(false);
  });
});
