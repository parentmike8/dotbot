import { afterEach, describe, expect, it, vi } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { defaultGameConfig } from "@dotbot/game/config";
import { NetSession } from "./NetSession";
import { toWireKillCamClip, type ClientMessage, type DeliveryClass, type KillCamClip } from "@dotbot/protocol";
import type { GameTransport, GameTransportHandlers } from "../transport/GameTransport";

describe("NetSession item edges", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("cuts tick-aligned frames with one-shot edges and routes LEAVE RUN through leaveRun", () => {
    const sent: Array<Record<string, unknown>> = [];
    const deliveries: string[] = [];
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    Object.assign(session as unknown as object, {
      transport: { send: (message: Record<string, unknown>, delivery: string) => { sent.push(message); deliveries.push(delivery); } },
      mapValue: downtownMap,
      configValue: defaultGameConfig,
      tickHz: 60,
      lastRenderTick: 120,
      handshakeReady: true,
    });
    const advance = (ms: number) =>
      (session as unknown as { advancePrediction(ms: number): void }).advancePrediction(ms);
    const tickMs = 1000 / 60;

    session.sendInput({
      move: { x: 1, y: 0 },
      dash: false,
      useBay: 2,
      drop: { from: "hold", index: 4, revision: 8, expected: { kind: "mine" } },
    });
    advance(tickMs * 4 + 1);
    session.sendInput({ move: { x: 1, y: 0 }, dash: false });
    advance(tickMs * 2);
    session.leaveRun();
    session.requestSquad("bravo");

    const inputMessages = sent.filter((message) => message.type === "input");
    expect(inputMessages.length).toBeGreaterThan(0);
    const allFrames = inputMessages.flatMap((message) => message.frames as Array<Record<string, unknown>>);
    // The one-shot edge rides exactly one seq, however often that frame is
    // redundantly re-sent; every frame carries the staged movement.
    const bayFrameSeqs = new Set(allFrames.filter((frame) => frame.useBay === 2).map((frame) => frame.seq));
    expect([...bayFrameSeqs]).toEqual([1]);
    const dropFrameSeqs = new Set(allFrames.filter((frame) =>
      JSON.stringify(frame.drop) === JSON.stringify({
        from: "hold",
        index: 4,
        revision: 8,
        expected: { kind: "mine" },
      })).map((frame) => frame.seq));
    expect([...dropFrameSeqs]).toEqual([1]);
    const seqs = allFrames.map((frame) => frame.seq as number);
    expect(Math.max(...seqs)).toBe(6);
    expect(allFrames.every((frame) => (frame.move as [number, number])[0] === 1)).toBe(true);
    expect(allFrames.every((frame) => frame.viewTick === 120)).toBe(true);
    expect(deliveries.slice(0, 2)).toEqual(["reliable", "latest"]);
    expect(sent.at(-2)).toEqual({ type: "leaveRun" });
    expect(sent.at(-1)).toEqual({ type: "joinSquad", squadId: "bravo" });
  });

  it("carries an exterior map ping floor reliably without inventing an interior floor", () => {
    const sent: ClientMessage[] = [];
    const deliveries: DeliveryClass[] = [];
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    Object.assign(session as unknown as object, {
      transport: {
        send: (message: ClientMessage, delivery: DeliveryClass) => {
          sent.push(message);
          deliveries.push(delivery);
        },
      },
      mapValue: downtownMap,
      configValue: defaultGameConfig,
      tickHz: 60,
      lastRenderTick: 120,
      handshakeReady: true,
    });

    session.sendInput({
      move: { x: 0, y: 0 },
      dash: false,
      ping: { kind: "here", position: { x: 640, y: 420 }, floorId: "outdoor" },
    });
    (session as unknown as { advancePrediction(ms: number): void }).advancePrediction(1000 / 60 + 1);

    const input = sent.find((message): message is Extract<ClientMessage, { type: "input" }> => message.type === "input");
    expect(input?.ping).toEqual({ kind: "here", position: [640, 420], floorId: "outdoor" });
    expect(input?.frames?.[0].ping).toEqual({ kind: "here", position: [640, 420], floorId: "outdoor" });
    expect(deliveries[0]).toBe("reliable");
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

  it("queues a private kill cam once and deduplicates a reconnect resend by clip id", () => {
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    const clip = {
      id: "victim-60",
      victimId: "victim",
      cause: { kind: "mine", tick: 60, position: { x: 10, y: 20 }, direction: { x: 1, y: 0 } },
      startTick: 0,
      deathTick: 60,
      tickHz: 60,
      frames: [{
        tick: 0,
        victim: { id: "victim", position: { x: 10, y: 20 }, facing: 0, floorId: "outdoor", shieldSegments: [0, 0, 0], dashActiveMs: 0, state: "downed" },
        blockingDoorIds: [],
      }],
    } satisfies KillCamClip;
    const receive = (message: unknown) => (session as unknown as { receive(message: unknown): void }).receive(message);
    receive({ type: "killCam", clip: toWireKillCamClip(clip) });
    receive({ type: "killCam", clip: toWireKillCamClip(clip) });
    expect(session.drainKillCams()).toEqual([clip]);
    expect(session.drainKillCams()).toEqual([]);
  });

  it("keeps networking and plea live during replay while suppressing movement, actions, and prediction", () => {
    const sent: Array<Record<string, unknown>> = [];
    const predictorStep = vi.fn();
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    Object.assign(session as unknown as object, {
      transport: { send: (message: Record<string, unknown>) => sent.push(message) },
      mapValue: downtownMap,
      configValue: defaultGameConfig,
      tickHz: 60,
      handshakeReady: true,
      predictionEnabled: true,
      predictor: { step: predictorStep },
    });
    session.sendInput({
      move: { x: 0, y: 0 },
      dash: false,
      drop: { from: "hold", index: 0, revision: 3, expected: { kind: "mine" } },
    });
    session.setReplayActive(true);
    session.sendInput({
      move: { x: 1, y: 0 },
      dash: true,
      useBay: 2,
      drop: { from: "bay", index: 0, revision: 3, expected: { kind: "mine" } },
      plea: true,
      ping: { kind: "enemy", position: { x: 10, y: 20 } },
    });
    (session as unknown as { advancePrediction(ms: number): void })
      .advancePrediction(1000 / 60 + 1);

    const frame = (sent.find((message) => message.type === "input")?.frames as Array<Record<string, unknown>>)[0];
    expect(frame).toMatchObject({ move: [0, 0], dash: false, plea: true });
    expect(frame.useBay).toBeUndefined();
    expect(frame.drop).toBeUndefined();
    expect(frame.ping).toBeUndefined();
    expect(predictorStep).not.toHaveBeenCalled();

    session.setReplayActive(false);
    session.sendInput({ move: { x: 1, y: 0 }, dash: false });
    (session as unknown as { advancePrediction(ms: number): void })
      .advancePrediction(1000 / 60 + 1);
    expect(predictorStep).toHaveBeenCalledOnce();
  });

  it("correlates a predicted contact with the explicit server hit acknowledgement", () => {
    let nowMs = 100;
    vi.stubGlobal("performance", { now: () => nowMs });
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    let contact: { targetId: string; position: { x: number; y: number }; kind: "hit" } | null = {
      targetId: "target",
      position: { x: 10, y: 20 },
      kind: "hit",
    };
    Object.assign(session as unknown as object, {
      playerIdValue: "player",
      predictor: {
        consumeDashContact: () => {
          const next = contact;
          contact = null;
          return next;
        },
      },
    });

    expect(session.drainPredictedImpacts()).toEqual([{
      targetId: "target",
      sourceId: "player",
      predictionId: "player-1",
      predictedAtMs: 100,
      kind: "hit",
      x: 10,
      y: 20,
    }]);
    nowMs = 146;
    (session as unknown as { receive(message: unknown): void }).receive({
      type: "ev",
      events: [{ type: "hit", botId: "target", byBotId: "player" }],
    });

    expect(session.getNetworkDebug()).toMatchObject({
      hitConfirmationMs: 46,
      hitPredictedCount: 1,
      hitConfirmedCount: 1,
      hitUnconfirmedCount: 0,
      hitPendingCount: 0,
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

  it("reconnects with the same GameLift reservation after a brief mobile network handoff", async () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const session = new NetSession({
      url: "wss://game.example/ws",
      roomCode: "TEST",
      name: "Ada",
      token: "token",
      playerSessionId: "psess-1",
      transportFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
    });
    const started = session.start();
    transports[0].handlers?.open();
    expect(transports[0].sent[0]?.message).toMatchObject({ type: "hello", playerSessionId: "psess-1" });
    transports[0].handlers?.message({
      type: "welcome",
      roomCode: "TEST",
      playerId: "player-1",
      phase: "live",
      hostId: "player-1",
      members: [{ playerId: "player-1", name: "Ada", squadId: "alpha" }],
      locked: true,
    });
    transports[0].handlers?.message({
      type: "matchStart",
      map: downtownMap,
      config: defaultGameConfig,
      yourBotId: "player-1",
      meta: [],
      tickHz: 60,
      endTick: 3600,
      insertionName: "WEST GATE",
      dotBaseline: [],
    });
    await started;

    transports[0].handlers?.close();
    expect((session as unknown as { pendingInputs: unknown[] }).pendingInputs).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(transports).toHaveLength(2);
    transports[1].handlers?.open();
    expect(transports[1].sent[0]?.message).toMatchObject({
      type: "hello",
      token: "token",
      roomCode: "TEST",
      playerSessionId: "psess-1",
    });
    session.requestSquad("crew-3");
    expect(transports[1].sent.map(({ message }) => message.type)).toEqual(["hello"]);
    transports[1].handlers?.message({
      type: "welcome",
      roomCode: "TEST",
      playerId: "player-1",
      phase: "live",
      hostId: "player-1",
      members: [{ playerId: "player-1", name: "Ada", squadId: "alpha" }],
      locked: true,
    });
    // The public exterior chart is static match knowledge. Reconnecting does
    // not need a per-player fog payload or a replacement map document.
    expect(session.map).toBe(downtownMap);
    session.requestSquad("crew-3");
    expect(transports[1].sent.map(({ message }) => message.type)).toEqual(["hello", "joinSquad"]);
    session.dispose();
  });

  it("keeps an internal hello race out of player-facing reconnect copy", () => {
    const errors: string[] = [];
    const transport = new FakeTransport();
    const session = new NetSession({
      url: "/ws",
      roomCode: "TEST",
      name: "Ada",
      token: "token",
      transportFactory: () => transport,
      onError: (message) => errors.push(message),
    });
    void session.start();
    transport.handlers?.open();
    transport.handlers?.message({
      type: "err",
      code: "hello_required",
      msg: "Send hello before other messages.",
    });

    expect(errors).toEqual(["CONNECTION INTERRUPTED · RECONNECTING…"]);
    expect(errors.join(" ")).not.toContain("hello");
    session.dispose();
  });

  it("reconnects to the server-assigned room after creating a new room", async () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const session = new NetSession({
      url: "/ws",
      roomCode: "",
      name: "Ada",
      token: "token",
      transportFactory: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
    });
    const started = session.start();
    transports[0].handlers?.open();
    expect(transports[0].sent[0]?.message).toMatchObject({ type: "hello", roomCode: "" });
    transports[0].handlers?.message({
      type: "welcome",
      roomCode: "NEW1",
      playerId: "player-1",
      phase: "live",
      hostId: "player-1",
      members: [{ playerId: "player-1", name: "Ada", squadId: "alpha" }],
      locked: true,
    });
    transports[0].handlers?.message({
      type: "matchStart",
      map: downtownMap,
      config: defaultGameConfig,
      yourBotId: "player-1",
      meta: [],
      tickHz: 60,
      endTick: 3600,
      insertionName: "WEST GATE",
      dotBaseline: [],
    });
    await started;

    transports[0].handlers?.close();
    await vi.advanceTimersByTimeAsync(250);
    expect(transports).toHaveLength(2);
    transports[1].handlers?.open();
    expect(transports[1].sent[0]?.message).toMatchObject({
      type: "hello",
      token: "token",
      roomCode: "NEW1",
    });
    session.dispose();
  });
});

class FakeTransport implements GameTransport {
  handlers: GameTransportHandlers | null = null;
  readonly sent: Array<{ message: ClientMessage; delivery: DeliveryClass }> = [];

  connect(handlers: GameTransportHandlers): void { this.handlers = handlers; }
  send(message: ClientMessage, delivery: DeliveryClass): void { this.sent.push({ message, delivery }); }
  close(): void {}
}
