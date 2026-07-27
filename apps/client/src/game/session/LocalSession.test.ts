import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import type { GameSnapshot, SimEvent } from "@dotbot/game/types";
import { LocalSession, type LocalSimulation } from "./LocalSession";

describe("LocalSession run-state ownership", () => {
  const health = { kind: "powerup", type: "health" } as const;
  it("derives extracted state from the local simulation event", async () => {
    const { session } = scriptedSession({
      events: [{ type: "extracted", botId: "player", squadId: "alpha", items: [health, health, health] }],
      snapshot: snapshot(50, []),
    });

    await session.start();
    session.update(100);

    expect(session.getRunState()).toEqual({ phase: "over", reason: "extracted", keptItems: [health, health, health], lostItems: [], learnedBlueprints: [] });
    expect(session.drainEvents()).toEqual([{ type: "extracted", botId: "player", squadId: "alpha", items: [health, health, health] }]);
  });

  it("keeps the run live when the player is looted", async () => {
    // Losing everything you carry used to end the run, by way of the `consumed`
    // event. A looted bot is a downed bot with empty bays — still in the match,
    // waiting on a squadmate, a plea, or its own decision to leave.
    const { session } = scriptedSession({
      events: [{ type: "looted", botId: "player", byBotId: "enemy", items: [health, health] }],
      snapshot: snapshot(50, []),
    });

    await session.start();
    session.update(100);

    expect(session.getRunState()).toEqual({ phase: "live" });
  });

  it("delivers authoritative hit presentation events in local mode", async () => {
    const hit: Extract<SimEvent, { type: "hit" }> = {
      type: "hit",
      botId: "target",
      byBotId: "player",
      result: "plateBreak",
      position: { x: 120, y: 90 },
      direction: { x: 1, y: 0 },
      tick: 4,
    };
    const { session } = scriptedSession({ events: [hit], snapshot: snapshot(50, []) });

    await session.start();
    session.update(100);

    expect(session.drainEvents()).toEqual([hit]);
  });

  it("derives timeout state from local time and current inventory", async () => {
    const config = { ...defaultGameConfig, tickHz: 10, runDurationMs: 100 };
    const { session } = scriptedSession({
      config,
      events: [],
      snapshot: snapshot(100, [{
        id: "player",
        name: "Player",
        squadId: "alpha",
        isAmbient: false,
        color: "#fff",
        position: { x: 10, y: 10 },
        radius: 24,
        state: "alive",
        floorId: "outdoor",
        facing: 0,
        maxShields: 3,
        shields: 3,
        shieldSegments: [1, 1, 1],
        bays: [health, health, health],
        hold: [],
        carriedCount: 3,
        searched: false,
        radarActiveMs: 0,
        radarPings: [],
        dashOverchargeCharges: 0,
        incognitoMs: 0,
        dashCooldownMs: 0,
        dashActiveMs: 0,
        invulnerabilityMs: 0,
      }]),
    });

    await session.start();
    session.update(100);

    expect(session.getRunState()).toEqual({ phase: "over", reason: "timeout", keptItems: [], lostItems: [health, health, health], learnedBlueprints: [] });
  });

  it("ends a downed solo run through GIVE UP with an itemized loss", async () => {
    const downed = snapshot(50, [{
      id: "player", name: "Player", squadId: "alpha", isAmbient: false, color: "#fff",
      position: { x: 10, y: 10 }, radius: 24, state: "downed", floorId: "outdoor", facing: 0,
      maxShields: 3, shields: 0, shieldSegments: [0, 0, 0], bays: [health, null, null], hold: [],
      carriedCount: 1,
      searched: false,
      radarActiveMs: 0, radarPings: [], dashOverchargeCharges: 0, incognitoMs: 0,
      dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
    }]);
    const { session } = scriptedSession({ events: [], snapshot: downed });
    await session.start();
    session.update(100);
    session.giveUp();
    expect(session.getRunState()).toEqual({ phase: "over", reason: "died", keptItems: [], lostItems: [health], learnedBlueprints: [] });
  });
});

function scriptedSession(options: { config?: typeof defaultGameConfig; events: SimEvent[]; snapshot: GameSnapshot }) {
  let events = [...options.events];
  const simulation: LocalSimulation = {
    applyInput() {},
    dispose() {},
    drainEvents() {
      const drained = events;
      events = [];
      return drained;
    },
    getSnapshot: () => options.snapshot,
    setMeasuredFps() {},
    step() {},
  };
  const config = options.config ?? { ...defaultGameConfig, tickHz: 10 };
  return {
    session: new LocalSession({
      map: downtownMap,
      config,
      playerId: "player",
      createSimulation: async () => simulation,
    }),
  };
}

function snapshot(timeMs: number, bots: GameSnapshot["bots"]): GameSnapshot {
  return {
    timeMs,
    bots,
    dots: [],
    mines: [],
    coverages: [],
    noises: [],
    debug: { tickHz: 10, tickCount: 1, fps: 60, activeBodies: bots.length, activeDots: 0 },
  };
}
