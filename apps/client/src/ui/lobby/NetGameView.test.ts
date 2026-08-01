import { describe, expect, it } from "vitest";
import { roomCodeDataAttribute } from "./roomCodePrivacy";

describe("network game room-code privacy", () => {
  it("omits the arena code from public quick-play DOM while preserving legacy rooms", () => {
    expect(roomCodeDataAttribute("A2BC", true)).toBeUndefined();
    expect(roomCodeDataAttribute("A2BC", false)).toBe("A2BC");
  });
});
