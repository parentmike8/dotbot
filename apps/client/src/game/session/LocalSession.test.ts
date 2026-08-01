import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import type { GameSnapshot, MapDocument, SimEvent } from "@dotbot/game/types";
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

  it("queues the authoritative replay when an ambient AI downs the solo player", async () => {
    const cause = {
      kind: "dash" as const,
      tick: 1,
      position: { x: 28, y: 10 },
      direction: { x: -1, y: 0 },
    };
    const player = testBot("player", "Player", { x: 10, y: 10 }, {
      state: "downed",
      shields: 0,
      shieldSegments: [0, 0, 0],
    });
    const guard = testBot("ambient-guard", "Depot Guard", { x: 40, y: 10 }, {
      squadId: "ambient",
      isAmbient: true,
    });
    const { session } = scriptedSession({
      map: replayMap,
      events: [
        {
          type: "hit",
          botId: "player",
          byBotId: "ambient-guard",
          result: "downed",
          tick: 1,
          position: { ...cause.position },
          direction: { ...cause.direction },
        },
        {
          type: "downed",
          botId: "player",
          byBotId: "ambient-guard",
          cause,
        },
      ],
      snapshot: snapshot(50, [player, guard]),
    });

    await session.start();
    session.update(100);

    expect(session.drainKillCams()).toEqual([
      expect.objectContaining({
        victimId: "player",
        sourceBotId: "ambient-guard",
        cause,
        impacts: [expect.objectContaining({
          tick: 1,
          result: "downed",
          position: cause.position,
          direction: cause.direction,
          sourceId: "ambient-guard",
        })],
        frames: [expect.objectContaining({
          victim: expect.objectContaining({ id: "player", state: "downed" }),
          source: expect.objectContaining({ id: "ambient-guard" }),
        })],
      }),
    ]);
    expect(session.drainKillCams()).toEqual([]);
    expect(session.getEntityMeta("ambient-guard")?.name).toBe("Depot Guard");
  });

  it("suppresses solo gameplay input during replay while retaining plea", async () => {
    const applied: import("@dotbot/game/types").InputCommand[] = [];
    const current = snapshot(0, [testBot("player", "Player", { x: 10, y: 10 })]);
    const simulation: LocalSimulation = {
      applyInput(_botId, input) { applied.push(input); },
      dispose() {},
      drainEvents: () => [],
      getSnapshot: () => current,
      setMeasuredFps() {},
      step() {},
    };
    const session = new LocalSession({
      map: downtownMap,
      config: defaultGameConfig,
      playerId: "player",
      createSimulation: async () => simulation,
    });
    await session.start();

    session.setReplayActive(true);
    session.sendInput({ move: { x: 1, y: 0 }, dash: true, useBay: 0, plea: true });

    expect(applied.at(-1)).toEqual({ move: { x: 0, y: 0 }, dash: false, plea: true });
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
        moving: false,
        maxShields: 3,
        shields: 3,
        shieldSegments: [1, 1, 1],
        bays: [health, health, health],
        hold: [],
        carriedCount: 3,
        searched: false,
        pleaded: false,
        radarActiveMs: 0,
        radarPings: [],
        dashOverchargeMs: 0,
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

  it("ends a downed solo run through LEAVE RUN with an itemized loss", async () => {
    const downed = snapshot(50, [{
      id: "player", name: "Player", squadId: "alpha", isAmbient: false, color: "#fff",
      position: { x: 10, y: 10 }, radius: 24, state: "downed", floorId: "outdoor", facing: 0, moving: false,
      maxShields: 3, shields: 0, shieldSegments: [0, 0, 0], bays: [health, null, null], hold: [],
      carriedCount: 1,
      searched: false,
      pleaded: false,
      radarActiveMs: 0, radarPings: [], dashOverchargeMs: 0, incognitoMs: 0,
      dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
    }]);
    const { session } = scriptedSession({ events: [], snapshot: downed });
    await session.start();
    session.update(100);
    session.leaveRun();
    expect(session.getRunState()).toEqual({ phase: "over", reason: "died", keptItems: [], lostItems: [health], learnedBlueprints: [] });
  });
});

function scriptedSession(options: {
  config?: typeof defaultGameConfig;
  events: SimEvent[];
  map?: MapDocument;
  snapshot: GameSnapshot;
}) {
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
      map: options.map ?? downtownMap,
      config,
      playerId: "player",
      createSimulation: async () => simulation,
    }),
  };
}

const replayMap: MapDocument = {
  id: "local-kill-cam-test",
  name: "Local Kill Cam Test",
  width: 600,
  height: 400,
  outdoor: { roads: [], parks: [], walls: [], objects: [], dotSpawns: [] },
  buildings: [],
  extractionPoints: [],
  insertionPoints: [],
  botSpawns: [],
};

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

function testBot(
  id: string,
  name: string,
  position: { x: number; y: number },
  overrides: Partial<GameSnapshot["bots"][number]> = {},
): GameSnapshot["bots"][number] {
  return {
    id,
    name,
    squadId: "alpha",
    isAmbient: false,
    color: "#fff",
    position,
    radius: 24,
    state: "alive",
    floorId: "outdoor",
    facing: 0,
    moving: false,
    maxShields: 3,
    shields: 3,
    shieldSegments: [1, 1, 1],
    bays: [null, null, null],
    hold: [],
    carriedCount: 0,
    searched: false,
    pleaded: false,
    radarActiveMs: 0,
    radarPings: [],
    dashOverchargeMs: 0,
    incognitoMs: 0,
    dashCooldownMs: 0,
    dashActiveMs: 0,
    invulnerabilityMs: 0,
    ...overrides,
  };
}
