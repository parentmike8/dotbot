import { describe, expect, it } from "vitest";
import { downtownMap } from "./content/downtown";
import { contractSatisfied, deriveContractTemplates, generateContractOffers } from "./contracts";

describe("data-driven contracts", () => {
  it("derives objectives from map data and is deterministic per player/day", () => {
    const templates = deriveContractTemplates(downtownMap);
    expect(templates.some((template) => template.objective.kind === "extractBlueprint")).toBe(true);
    expect(templates.some((template) => template.objective.kind === "extractPowerups")).toBe(true);
    expect(templates.some((template) => template.objective.kind === "extractFromBuilding")).toBe(true);
    const first = generateContractOffers(downtownMap, "player-a", "2026-07-15");
    expect(first).toHaveLength(3);
    expect(generateContractOffers(downtownMap, "player-a", "2026-07-15")).toEqual(first);
    expect(generateContractOffers(downtownMap, "player-b", "2026-07-15")).not.toEqual(first);
    expect(generateContractOffers(downtownMap, "player-a", "2026-07-16")).not.toEqual(first);
    expect(generateContractOffers(downtownMap, "player-a", "2026-07-15", 1)).not.toEqual(first);
  });

  it("judges exact provenance and count objectives", () => {
    expect(contractSatisfied({
      id: "bp", templateId: "bp", title: "BP", difficulty: 1, payout: { items: [] },
      objective: { kind: "extractBlueprint", blueprintId: "shelf", buildingId: "lot6" },
    }, [{ kind: "blueprint", blueprintId: "shelf", sourceBuildingId: "lot6" }])).toBe(true);
    expect(contractSatisfied({
      id: "building", templateId: "building", title: "Building", difficulty: 1, payout: { items: [] },
      objective: { kind: "extractFromBuilding", buildingId: "lot6", count: 2 },
    }, [{ kind: "powerup", type: "health", sourceBuildingId: "lot6" }])).toBe(false);
  });

  it("keeps every payout inventory-only", () => {
    for (const offer of generateContractOffers(downtownMap, "guard", "2026-07-15")) {
      expect(offer.payout.items.length).toBeGreaterThan(0);
      expect(offer.payout.items.every((item) => item.kind === "powerup" || item.kind === "blueprint")).toBe(true);
      expect(JSON.stringify(offer)).not.toMatch(/shield|speed|damage|radius/i);
    }
  });
});
