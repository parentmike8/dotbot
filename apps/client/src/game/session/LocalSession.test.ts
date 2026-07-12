import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import type { GameSnapshot, SimEvent } from "@dotbot/game/types";
import { LocalSession, type LocalSimulation } from "./LocalSession";

describe("LocalSession run-state ownership", () => {
  it("derives extracted state from the local simulation event", async () => {
    const { session } = scriptedSession({
      events: [{ type: "extracted", botId: "player", squadId: "alpha", inventoryDots: 3 }],
      snapshot: snapshot(50, []),
    });

    await session.start();
    session.update(100);

    expect(session.getRunState()).toEqual({ phase: "over", reason: "extracted", keptDots: 3, lostDots: 0 });
    expect(session.drainEvents()).toEqual([{ type: "extracted", botId: "player", squadId: "alpha", inventoryDots: 3 }]);
  });

  it("derives died state and loss from the consumed event payload", async () => {
    const { session } = scriptedSession({
      events: [{ type: "consumed", botId: "player", byBotId: "enemy", lostDots: 2 }],
      snapshot: snapshot(50, []),
    });

    await session.start();
    session.update(100);

    expect(session.getRunState()).toEqual({ phase: "over", reason: "died", keptDots: 0, lostDots: 2 });
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
        inventoryDots: 4,
        dashCooldownMs: 0,
        dashActiveMs: 0,
        invulnerabilityMs: 0,
      }]),
    });

    await session.start();
    session.update(100);

    expect(session.getRunState()).toEqual({ phase: "over", reason: "timeout", keptDots: 0, lostDots: 4 });
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
    coverages: [],
    noises: [],
    debug: { tickHz: 10, tickCount: 1, fps: 60, activeBodies: bots.length, activeDots: 0 },
  };
}
