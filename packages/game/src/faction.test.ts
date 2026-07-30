import { describe, expect, it } from "vitest";
import { botSpawnFaction, isAmbientBotSpawn } from "./faction";

describe("authored bot faction", () => {
  it("uses the explicit faction ahead of the legacy ambient flag", () => {
    expect(botSpawnFaction({ faction: "ambient", isAmbient: false })).toBe("ambient");
    expect(isAmbientBotSpawn({ faction: "ambient", isAmbient: false })).toBe(true);
    expect(botSpawnFaction({ faction: "squad", isAmbient: true })).toBe("squad");
    expect(isAmbientBotSpawn({ faction: "squad", isAmbient: true })).toBe(false);
  });

  it("keeps legacy spawns compatible when no explicit faction is authored", () => {
    expect(botSpawnFaction({ isAmbient: true })).toBe("ambient");
    expect(botSpawnFaction({ isAmbient: false })).toBe("squad");
    expect(botSpawnFaction({})).toBe("squad");
  });
});
