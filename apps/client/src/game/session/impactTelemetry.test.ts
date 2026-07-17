import { describe, expect, it } from "vitest";
import {
  createImpactTelemetry,
  expireUnconfirmedHits,
  hitConfirmationTimeoutMs,
  recordAuthoritativeHit,
  recordPredictedHit,
} from "./impactTelemetry";

describe("impact confirmation telemetry", () => {
  it("measures an explicit authoritative acknowledgement from local contact", () => {
    const telemetry = createImpactTelemetry();
    recordPredictedHit(telemetry, "target", 100);
    recordAuthoritativeHit(telemetry, { botId: "target", byBotId: "player" }, "player", 146);

    expect(telemetry).toMatchObject({
      lastConfirmationMs: 46,
      predictedCount: 1,
      confirmedCount: 1,
      unconfirmedCount: 0,
      pending: [],
    });
  });

  it("does not mistake another player's hit for local confirmation", () => {
    const telemetry = createImpactTelemetry();
    recordPredictedHit(telemetry, "target", 100);
    recordAuthoritativeHit(telemetry, { botId: "target", byBotId: "rival" }, "player", 140);

    expect(telemetry.confirmedCount).toBe(0);
    expect(telemetry.pending).toHaveLength(1);
  });

  it("marks a prediction unconfirmed only after the bounded correlation window", () => {
    const telemetry = createImpactTelemetry();
    recordPredictedHit(telemetry, "target", 100);
    expireUnconfirmedHits(telemetry, 100 + hitConfirmationTimeoutMs);
    expect(telemetry.pending).toHaveLength(1);

    expireUnconfirmedHits(telemetry, 101 + hitConfirmationTimeoutMs);
    expect(telemetry).toMatchObject({
      predictedCount: 1,
      confirmedCount: 0,
      unconfirmedCount: 1,
      pending: [],
    });
  });

  it("correlates repeated contacts with matching targets in FIFO order", () => {
    const telemetry = createImpactTelemetry();
    recordPredictedHit(telemetry, "a", 100);
    recordPredictedHit(telemetry, "b", 200);
    recordPredictedHit(telemetry, "a", 300);

    recordAuthoritativeHit(telemetry, { botId: "a", byBotId: "player" }, "player", 340);
    expect(telemetry.lastConfirmationMs).toBe(240);
    expect(telemetry.pending.map(({ targetId }) => targetId)).toEqual(["b", "a"]);
  });
});
