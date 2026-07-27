import { describe, expect, it } from "vitest";
import { visibilityFogStyle } from "./visibilityStyle";

describe("visibilityFogStyle", () => {
  it("veils an unseen room but only hints at unseen street", () => {
    const indoors = visibilityFogStyle(true);
    const outdoors = visibilityFogStyle(false);
    expect(indoors.alpha).toBe(0.18);
    expect(outdoors.alpha).toBe(0.035);
    // Same ink either way: only the weight carries the meaning.
    expect(indoors.color).toBe(outdoors.color);
  });
});
