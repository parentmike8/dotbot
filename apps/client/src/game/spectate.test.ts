import { describe, expect, it } from "vitest";
import { selectSpectatedBot } from "./spectate";

describe("spectate selection", () => {
  const squad = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("uses deterministic squad order and wraps Space cycles", () => {
    expect(selectSpectatedBot(squad, null, false)?.id).toBe("a");
    expect(selectSpectatedBot(squad, "a", true)?.id).toBe("b");
    expect(selectSpectatedBot(squad, "c", true)?.id).toBe("a");
  });

  it("falls back when the focus dies and returns null for a wiped squad", () => {
    expect(selectSpectatedBot(squad.slice(1), "a", false)?.id).toBe("b");
    expect(selectSpectatedBot([], "a", true)).toBeNull();
  });
});
