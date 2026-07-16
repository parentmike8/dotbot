import { afterEach, describe, expect, it, vi } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { defaultGameConfig } from "@dotbot/game/config";
import { NetSession } from "./NetSession";

describe("NetSession item edges", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends useBay once over 30Hz frames and routes GIVE UP through leaveRun", () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const sent: Array<Record<string, unknown>> = [];
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    Object.assign(session as unknown as object, {
      socket: { readyState: 1, send: (value: string) => sent.push(JSON.parse(value) as Record<string, unknown>) },
      mapValue: downtownMap,
    });

    session.sendInput({ move: { x: 0, y: 0 }, dash: false, useBay: 2 });
    session.sendInput({ move: { x: 0, y: 0 }, dash: false });
    session.sendInput({ move: { x: 0, y: 0 }, dash: false });
    session.giveUp();
    session.requestSquad("bravo");

    expect(sent[0]).toMatchObject({ type: "input", seq: 1, useBay: 2 });
    expect(sent[1]).toMatchObject({ type: "input", seq: 2 });
    expect(sent[1]).not.toHaveProperty("useBay");
    expect(sent[2]).toEqual({ type: "leaveRun" });
    expect(sent[3]).toEqual({ type: "joinSquad", squadId: "bravo" });
  });

  it("decodes contract payouts from the authoritative run manifest", () => {
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    (session as unknown as { receive(message: unknown): void }).receive({
      type: "runOver",
      reason: "extracted",
      keptItems: ["h"],
      lostItems: [],
      learnedBlueprints: [],
      contractCompletions: [{ contractId: "contract-test", title: "TEST HAUL", payout: ["r"] }],
    });
    expect(session.getRunState()).toMatchObject({
      phase: "over",
      contractCompletions: [{ contractId: "contract-test", title: "TEST HAUL", payout: [{ kind: "powerup", type: "radar" }] }],
    });
  });

  it("seeds dots once, applies ordered deltas, and replaces floor contexts", () => {
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    const receive = (message: unknown) => (session as unknown as { receive(message: unknown): void }).receive(message);
    receive({
      type: "matchStart",
      map: downtownMap,
      config: defaultGameConfig,
      yourBotId: "viewer",
      meta: [{ id: "viewer", name: "Ada", squadId: "alpha", isAmbient: false, maxShields: 3, radius: 24 }],
      tickHz: 60,
      endTick: 3600,
      insertionName: "TEST",
      dotBaseline: [{ id: "outside", position: { x: 1, y: 2 }, radius: 10, floorId: "outdoor", it: "h", active: true }],
    });
    const bot = { i: "viewer", p: [0, 0] as [number, number] };
    receive({ type: "snap", tick: 3, ack: 0, bots: [bot], dotDeltas: [{ id: "outside", captureProgressMs: 500 }] });
    receive({
      type: "snap",
      tick: 6,
      ack: 0,
      bots: [{ ...bot, fl: "mercy:F1" }],
      dotSync: [
        { context: "outdoor" },
        { context: "mercy:F1", dots: [{ id: "upper", position: { x: 3, y: 4 }, radius: 10, floorId: "mercy:F1", it: "r", active: false }] },
      ],
    });
    const snapshots = (session as unknown as { snapshots: Array<{ snapshot: { dots: Array<{ id: string; captureProgressMs: number }> } }> }).snapshots;
    expect(snapshots[0].snapshot.dots).toMatchObject([{ id: "outside", captureProgressMs: 500 }]);
    expect(snapshots[1].snapshot.dots).toMatchObject([{ id: "upper", captureProgressMs: 0 }]);
  });
});
