import { describe, expect, it } from "vitest";
import { runGenerationAdvanced, startsNewRun } from "./runBoundary";

describe("client run boundary", () => {
  it("recognizes live after an ended run as a same-session deploy-again", () => {
    expect(startsNewRun(false, { phase: "live" })).toBe(false);
    expect(startsNewRun(false, {
      phase: "over",
      reason: "died",
      keptItems: [],
      lostItems: [],
      learnedBlueprints: [],
    })).toBe(false);
    expect(startsNewRun(true, { phase: "live" })).toBe(true);
  });

  it("recognizes a later matchStart even when the prior result was missed", () => {
    expect(runGenerationAdvanced(undefined, 1)).toBe(false);
    expect(runGenerationAdvanced(1, 1)).toBe(false);
    expect(runGenerationAdvanced(1, 2)).toBe(true);
  });
});
