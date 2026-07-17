import { describe, expect, it } from "vitest";
import { generateRoomCode, isClosedGameSessionError, isFleetWakingError, isFullGameSessionError, secureWebSocketUrl } from "./handler";

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

  it("only retries errors that indicate a zero-capacity fleet is waking", () => {
    expect(isFleetWakingError({ name: "FleetCapacityExceededException" })).toBe(true);
    expect(isFleetWakingError({ name: "NotReadyException" })).toBe(true);
    expect(isFleetWakingError({ name: "InternalServiceException" })).toBe(false);
    expect(isFleetWakingError(new Error("network failure"))).toBe(false);
  });

  it("maps closed and full sessions to stable client errors", () => {
    expect(isClosedGameSessionError({ name: "NotFoundException" })).toBe(true);
    expect(isClosedGameSessionError({ name: "InvalidGameSessionStatusException" })).toBe(true);
    expect(isFullGameSessionError({ name: "GameSessionFullException" })).toBe(true);
    expect(isClosedGameSessionError({ name: "InternalServiceException" })).toBe(false);
  });
});
