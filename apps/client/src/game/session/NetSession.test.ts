import { afterEach, describe, expect, it, vi } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { defaultGameConfig } from "@dotbot/game/config";
import { NetSession } from "./NetSession";

describe("NetSession item edges", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cuts tick-aligned frames with one-shot edges and routes GIVE UP through leaveRun", () => {
    const sent: Array<Record<string, unknown>> = [];
    const deliveries: string[] = [];
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    Object.assign(session as unknown as object, {
      transport: { send: (message: Record<string, unknown>, delivery: string) => { sent.push(message); deliveries.push(delivery); } },
      mapValue: downtownMap,
      configValue: defaultGameConfig,
      tickHz: 60,
      lastRenderTick: 120,
    });
    const advance = (ms: number) =>
      (session as unknown as { advancePrediction(ms: number): void }).advancePrediction(ms);
    const tickMs = 1000 / 60;

    session.sendInput({ move: { x: 1, y: 0 }, dash: false, useBay: 2 });
    advance(tickMs * 4 + 1);
    session.sendInput({ move: { x: 1, y: 0 }, dash: false });
    advance(tickMs * 2);
    session.giveUp();
    session.requestSquad("bravo");

    const inputMessages = sent.filter((message) => message.type === "input");
    expect(inputMessages.length).toBeGreaterThan(0);
    const allFrames = inputMessages.flatMap((message) => message.frames as Array<Record<string, unknown>>);
    // The one-shot edge rides exactly one seq, however often that frame is
    // redundantly re-sent; every frame carries the staged movement.
    const bayFrameSeqs = new Set(allFrames.filter((frame) => frame.useBay === 2).map((frame) => frame.seq));
    expect([...bayFrameSeqs]).toEqual([1]);
    const seqs = allFrames.map((frame) => frame.seq as number);
    expect(Math.max(...seqs)).toBe(6);
    expect(allFrames.every((frame) => (frame.move as [number, number])[0] === 1)).toBe(true);
    expect(allFrames.every((frame) => frame.viewTick === 120)).toBe(true);
    expect(deliveries.slice(0, 2)).toEqual(["reliable", "latest"]);
    expect(sent.at(-2)).toEqual({ type: "leaveRun" });
    expect(sent.at(-1)).toEqual({ type: "joinSquad", squadId: "bravo" });
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
