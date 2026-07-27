import { describe, expect, it } from "vitest";
import { pixelCityBlockMap } from "./content/pixelCityBlock";
import { cloneMapDocument, validateEditableMap } from "./mapEditor";

describe("editable map validation", () => {
  it("accepts the production pixel city document", () => {
    expect(validateEditableMap(pixelCityBlockMap).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("rejects invalid geometry and broken stair destinations before save", () => {
    const candidate = cloneMapDocument(pixelCityBlockMap);
    candidate.outdoor.walls[0].w = 0;
    candidate.buildings[0].floors[0].stairs.push({ id: "broken", rect: { x: 0, y: 0, w: 40, h: 80 }, direction: "up", bottom: "S", toFloorId: "missing" });
    const issues = validateEditableMap(candidate);
    expect(issues.some((issue) => issue.path.endsWith(".w") && issue.severity === "error")).toBe(true);
    expect(issues.some((issue) => issue.message.includes("Unknown target floor"))).toBe(true);
  });

  it("clones without mutating the production source", () => {
    const clone = cloneMapDocument(pixelCityBlockMap);
    clone.name = "Changed";
    expect(pixelCityBlockMap.name).not.toBe("Changed");
  });
});
