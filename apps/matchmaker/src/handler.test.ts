import { describe, expect, it } from "vitest";
import { generateRoomCode, secureWebSocketUrl } from "./handler";

describe("matchmaker endpoint helpers", () => {
  it("generates shareable room codes without ambiguous characters", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it("returns a secure browser-compatible GameLift endpoint", () => {
    expect(secureWebSocketUrl("abc.ca-central-1.amazongamelift.com", 7001))
      .toBe("wss://abc.ca-central-1.amazongamelift.com:7001/ws");
    expect(() => secureWebSocketUrl("bad/path", 7001)).toThrow("Invalid GameLift endpoint");
  });
});
