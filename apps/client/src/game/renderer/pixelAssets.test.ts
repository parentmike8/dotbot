import { describe, expect, it } from "vitest";
import { dotItemFrameKey } from "./dotItemSprites";

describe("Pixel City Dot sprites", () => {
  it("maps every collectible type to a baked sprite frame", () => {
    expect(dotItemFrameKey({ kind: "powerup", type: "health" })).toBe("dot-health");
    expect(dotItemFrameKey({ kind: "powerup", type: "radar" })).toBe("dot-radar");
    expect(dotItemFrameKey({ kind: "powerup", type: "dashOvercharge" })).toBe("dot-dash-overcharge");
    expect(dotItemFrameKey({ kind: "powerup", type: "incognito" })).toBe("dot-incognito");
    expect(dotItemFrameKey({ kind: "blueprint", blueprintId: "test" })).toBe("dot-blueprint");
    expect(dotItemFrameKey({ kind: "mine" })).toBe("dot-mine");
  });
});
