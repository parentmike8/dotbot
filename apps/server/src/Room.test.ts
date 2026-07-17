import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@dotbot/protocol";
import { NoopPersistence, type Persistence } from "./db";
import type { BaseObjectKind } from "@dotbot/game/types";
import { Room, type RoomPeer } from "./Room";
import { buildingContaining, buildingOfFloor } from "@dotbot/game/mapModel";
import { downtownMap } from "@dotbot/game/content/downtown";

describe("Room lobby squads", () => {
  it("joins and switches capped squads, defaults late joins to the emptiest squad, and locks at host start", async () => {
    const room = new Room("SQAD", { countdownMs: 0, persistence: new NoopPersistence(), aiWingmates: false });
    const peers = Array.from({ length: 4 }, (_, index) => collectingPeer(`squad-peer-${index}`));
    expect(room.join(peers[0].peer, "s-token-0", "Alpha One", "s1", "alpha")?.squadId).toBe("alpha");
    expect(room.join(peers[1].peer, "s-token-1", "Alpha Two", "s2", "alpha")?.squadId).toBe("alpha");
    expect(room.join(peers[2].peer, "s-token-2", "Alpha Three", "s3", "alpha")?.squadId).toBe("alpha");
    expect(room.join(peers[3].peer, "s-token-3", "Late Join", "s4")?.squadId).toBe("bravo");

    room.receive("s4", { type: "joinSquad", squadId: "alpha" });
    expect(peers[3].messages.at(-1)).toMatchObject({ type: "err", code: "squad_full" });
    room.receive("s3", { type: "joinSquad", squadId: "bravo" });
    room.receive("s4", { type: "joinSquad", squadId: "alpha" });
    expect(room.lobbyMembers.find((member) => member.playerId === "s4")?.squadId).toBe("alpha");

    room.receive("s1", { type: "startMatch" });
    const lockedLobby = peers[0].messages.filter((message) => message.type === "lobby").at(-1);
    expect(lockedLobby).toMatchObject({ type: "lobby", locked: true });
    room.receive("s3", { type: "joinSquad", squadId: "crew-3" });
    expect(peers[2].messages.at(-1)).toMatchObject({ type: "err", code: "bad_phase" });
    await waitFor(() => room.phase === "live");
    room.dispose();
  });

  it("loads squad preferences, enforces insertion spacing, and names each matchStart insertion", async () => {
    class PreferencePersistence extends NoopPersistence {
      override async getInsertionPreference(playerId: string) {
        return playerId === "s1" ? "nw-corner" : "west-gate";
      }
    }
    const room = new Room("LAND", {
      countdownMs: 0,
      persistence: new PreferencePersistence(),
      aiWingmates: false,
      matchIdFactory: () => "00000000-0000-4000-8000-000000000016",
    });
    const alpha = collectingPeer("landing-alpha");
    const bravo = collectingPeer("landing-bravo");
    room.join(alpha.peer, "landing-token-a", "Alpha", "s1", "alpha");
    room.join(bravo.peer, "landing-token-b", "Bravo", "s2", "bravo");
    room.receive("s1", { type: "startMatch" });
    await waitFor(() => room.phase === "live");

    const alphaStart = alpha.messages.find((message) => message.type === "matchStart");
    const bravoStart = bravo.messages.find((message) => message.type === "matchStart");
    expect(alphaStart?.insertionName).toBeTruthy();
    expect(bravoStart?.insertionName).toBeTruthy();
    expect([alphaStart?.insertionName, bravoStart?.insertionName]).not.toEqual(["NW CORNER", "WEST GATE"]);
    const internals = room as unknown as {
      members: Map<string, { botId: string }>;
      simulation: { getSnapshot(): { bots: Array<{ id: string; position: { x: number; y: number } }> } };
    };
    const snapshot = internals.simulation.getSnapshot();
    const a = snapshot.bots.find((bot) => bot.id === internals.members.get("s1")!.botId)!;
    const b = snapshot.bots.find((bot) => bot.id === internals.members.get("s2")!.botId)!;
    expect(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)).toBeGreaterThanOrEqual(900);
    room.dispose();
  });

  it("carries a disconnected lobby member into the live handoff window, then gives the bot to AI", async () => {
    class HandoffPersistence extends NoopPersistence {
      readonly outcomes: Array<{ playerId: string; outcome: string }> = [];
      override async recordOutcome(input: Parameters<Persistence["recordOutcome"]>[0]): Promise<void> {
        this.outcomes.push(input);
      }
    }
    const persistence = new HandoffPersistence();
    const room = new Room("HAND", {
      countdownMs: 0,
      persistence,
      aiWingmates: false,
      connectionHandoffMs: 20,
      matchIdFactory: () => "00000000-0000-4000-8000-000000000017",
    });
    const host = collectingPeer("handoff-host");
    const mobile = collectingPeer("handoff-mobile");
    const duplicate = collectingPeer("handoff-duplicate");
    room.join(host.peer, "handoff-host-token", "Host", "handoff-host-player", "alpha");
    room.join(mobile.peer, "handoff-mobile-token", "Mobile", "handoff-mobile-player", "bravo");
    expect(room.join(duplicate.peer, "handoff-mobile-token", "Duplicate", "handoff-mobile-player", "bravo")).toBeNull();

    room.disconnect(mobile.peer.id);
    room.receive("handoff-host-player", { type: "startMatch" });
    await waitFor(() => room.phase === "live");
    await waitFor(() => persistence.outcomes.some((entry) => entry.playerId === "handoff-mobile-player"));
    expect(persistence.outcomes).toContainEqual({
      matchId: "00000000-0000-4000-8000-000000000017",
      playerId: "handoff-mobile-player",
      outcome: "disconnected",
    });
    expect(room.join(duplicate.peer, "handoff-mobile-token", "Too Late", "handoff-mobile-player", "bravo")).toBeNull();
    room.dispose();
  });
});

describe("Room GIVE UP", () => {
  it("returns a died manifest for a downed member while their squadmate keeps playing", async () => {
    class CountingPersistence extends NoopPersistence {
      outcomes: string[] = [];
      override async recordOutcome(...[input]: Parameters<Persistence["recordOutcome"]>) { this.outcomes.push(input.playerId); }
    }
    const persistence = new CountingPersistence();
    const room = new Room("GIVE", { countdownMs: 0, persistence });
    const peers = Array.from({ length: 4 }, (_, index) => collectingPeer(`peer-${index}`));
    for (let index = 0; index < peers.length; index += 1) {
      room.join(peers[index].peer, `token-${index}`, `Player ${index}`, `p${index + 1}`);
    }
    room.receive("p1", { type: "startMatch" });
    await waitFor(() => room.phase === "live");

    const internals = room as unknown as {
      members: Map<string, { botId: string; inRun: boolean }>;
      simulation: { bots: Map<string, { state: string; shields: number }> };
    };
    const member = internals.members.get("p1")!;
    const bot = internals.simulation.bots.get(member.botId)!;
    bot.state = "downed";
    bot.shields = 0;

    room.receive("p1", { type: "leaveRun" });
    await waitFor(() => peers[0].messages.some((message) => message.type === "runOver"));

    expect(peers[0].messages.find((message) => message.type === "runOver")).toEqual({
      type: "runOver",
      reason: "died",
      keptItems: [],
      lostItems: ["h"],
      learnedBlueprints: [],
    });
    expect(room.phase).toBe("live");
    expect(internals.members.get("p1")?.inRun).toBe(false);
    expect(internals.members.get("p4")?.inRun).toBe(true);
    const richer = room as unknown as {
      simulation: { getSnapshot(): import("@dotbot/game/types").GameSnapshot };
      broadcastSnapshot(snapshot: import("@dotbot/game/types").GameSnapshot): void;
    };
    richer.broadcastSnapshot(richer.simulation.getSnapshot());
    const spectatorSnap = peers[0].messages.filter((message) => message.type === "snap").at(-1);
    expect(spectatorSnap?.bots.some((candidate) => candidate.i === internals.members.get("p4")?.botId)).toBe(true);
    room.receive("p1", { type: "leaveRun" });
    expect(persistence.outcomes).toEqual(["p1"]);
    room.dispose();
  });
});

describe("Room owner-private match intel", () => {
  it("sends real grey counts and a deterministic signal only to owners, then expires the signal on capture and timeout", async () => {
    class IntelPersistence extends NoopPersistence {
      override async getMatchIntelObjects(playerId: string): Promise<BaseObjectKind[]> {
        return playerId === "intel-owner" ? ["listeningPost", "signalMast"] : [];
      }
    }
    const startRoom = async () => {
      const room = new Room("INTL", {
        countdownMs: 0,
        persistence: new IntelPersistence(),
        aiWingmates: false,
        matchIdFactory: () => "00000000-0000-4000-8000-000000000088",
      });
      const owner = collectingPeer(`intel-owner-${Math.random()}`);
      const rival = collectingPeer(`intel-rival-${Math.random()}`);
      room.join(owner.peer, "intel-token-owner", "Owner", "intel-owner", "alpha");
      room.join(rival.peer, "intel-token-rival", "Rival", "intel-rival", "bravo");
      room.receive("intel-owner", { type: "startMatch" });
      await waitFor(() => room.phase === "live");
      return { room, owner, rival };
    };

    const first = await startRoom();
    const ownerStart = first.owner.messages.find((message) => message.type === "matchStart");
    const rivalStart = first.rival.messages.find((message) => message.type === "matchStart");
    expect(ownerStart?.intel?.greyDensity).toBeDefined();
    expect(ownerStart?.intel?.signal).toMatchObject({ dotId: expect.stringMatching(/^blueprint-/), blueprintId: expect.any(String) });
    expect(rivalStart?.intel).toBeUndefined();

    const internals = first.room as unknown as {
      members: Map<string, unknown>;
      simulation: { getSnapshot(): import("@dotbot/game/types").GameSnapshot; dots: Map<string, { active: boolean }> };
      snapshotIntel(member: unknown, snapshot: import("@dotbot/game/types").GameSnapshot): import("@dotbot/protocol").MatchIntel | undefined;
    };
    const snapshot = internals.simulation.getSnapshot();
    const actual = new Map(downtownMap.buildings.map((building) => [building.id, 0]));
    for (const bot of snapshot.bots.filter((candidate) => candidate.isAmbient && candidate.state === "alive")) {
      const building = buildingOfFloor(downtownMap, bot.floorId) ?? buildingContaining(downtownMap, bot.position);
      if (building) actual.set(building.id, (actual.get(building.id) ?? 0) + 1);
    }
    expect(Object.fromEntries(ownerStart!.intel!.greyDensity!.map((row) => [row.buildingId, row.count]))).toEqual(Object.fromEntries(actual));

    const ownerMember = internals.members.get("intel-owner")!;
    const signal = ownerStart!.intel!.signal!;
    internals.simulation.dots.get(signal.dotId)!.active = false;
    expect(internals.snapshotIntel(ownerMember, internals.simulation.getSnapshot())).toEqual({});
    internals.simulation.dots.get(signal.dotId)!.active = true;
    const timedOut = internals.simulation.getSnapshot();
    timedOut.debug.tickCount = signal.expiresAtTick;
    expect(internals.snapshotIntel(ownerMember, timedOut)).toEqual({});

    const second = await startRoom();
    const secondStart = second.owner.messages.find((message) => message.type === "matchStart");
    expect(secondStart?.intel?.signal?.dotId).toBe(signal.dotId);
    first.room.dispose();
    second.room.dispose();
  });

  it("omits all match intel in stateless mode", async () => {
    const room = new Room("NINT", { countdownMs: 0, persistence: new NoopPersistence(), aiWingmates: false });
    const peer = collectingPeer("no-intel");
    room.join(peer.peer, "no-intel-token", "No Intel", "no-intel-player", "alpha");
    room.receive("no-intel-player", { type: "startMatch" });
    await waitFor(() => room.phase === "live");
    expect(peer.messages.find((message) => message.type === "matchStart")?.intel).toBeUndefined();
    room.dispose();
  });
});

describe("Room input stream", () => {
  it("consumes one frame per tick in seq order, acks only applied frames, and sheds stall backlogs", async () => {
    let clock = 0;
    const room = new Room("TICK", { countdownMs: 0, persistence: new NoopPersistence(), aiWingmates: false, now: () => clock });
    const peer = collectingPeer("stream-peer");
    room.join(peer.peer, "stream-token", "Streamer", "stream-player", "alpha");
    room.receive("stream-player", { type: "startMatch" });
    await waitFor(() => room.phase === "live");
    const tickMs = 1000 / 60;
    const internals = room as unknown as {
      members: Map<string, {
        botId: string;
        lastAppliedSeq: number;
        inputQueue: Array<{ seq: number }>;
        heldInput: { move: { x: number; y: number } };
      }>;
      simulation: { bots: Map<string, { viewDelayTicks: number }> };
    };
    const member = internals.members.get("stream-player")!;
    // The epsilon keeps float accumulation from rounding a tick away.
    const step = () => { clock += tickMs + 0.01; room.tick(clock); };

    // A stalled transport delivers frames 1..4 as one burst, including a
    // redundant duplicate of seq 2 — the queue keeps one copy of each.
    room.receive("stream-player", {
      type: "input", seq: 4, move: [1, 0], dash: false,
      frames: [
        { seq: 1, move: [1, 0], dash: false },
        { seq: 2, move: [1, 0], dash: true, viewTick: 0 },
        { seq: 2, move: [1, 0], dash: true, viewTick: 0 },
        { seq: 3, move: [1, 0], dash: false },
        { seq: 4, move: [1, 0], dash: false },
      ],
    });
    expect(member.inputQueue.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);

    // One frame per tick, in order; the ack only ever names applied frames.
    step();
    expect(member.lastAppliedSeq).toBe(1);
    step();
    expect(member.lastAppliedSeq).toBe(2);
    expect(internals.simulation.bots.get(member.botId)?.viewDelayTicks).toBe(2);
    step();
    step();
    expect(member.lastAppliedSeq).toBe(4);
    expect(member.inputQueue).toHaveLength(0);

    // Underrun: held movement keeps flowing, the ack does not advance.
    step();
    expect(member.lastAppliedSeq).toBe(4);
    expect(member.heldInput.move.x).toBe(1);

    // A deep post-stall backlog is shed to a bounded depth instead of
    // becoming standing input latency; shed frames count as acknowledged so
    // the client never replays them as pending.
    room.receive("stream-player", {
      type: "input", seq: 13, move: [0, 1], dash: false,
      frames: Array.from({ length: 9 }, (_, index) => ({ seq: 5 + index, move: [0, 1] as [number, number], dash: false })),
    });
    expect(member.inputQueue.map(({ seq }) => seq)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(member.lastAppliedSeq).toBe(7);

    // After an underrun the de-jitter latch waits for two buffered frames
    // before resuming, so a single arrival is held one tick — then both
    // (legacy single-frame messages included) flow through the same queue.
    step(); step(); step(); step(); step(); step(); step();
    room.receive("stream-player", { type: "input", seq: 20, move: [0, 1], dash: false });
    step();
    expect(member.lastAppliedSeq).toBe(13);
    room.receive("stream-player", { type: "input", seq: 21, move: [0, 1], dash: false });
    step();
    step();
    expect(member.lastAppliedSeq).toBe(21);
    room.dispose();
  });
});

describe("Room contract manifest", () => {
  it("forwards transaction-time contract completions on runOver", async () => {
    class ContractPersistence extends NoopPersistence {
      override async recordExtraction(input: Parameters<NoopPersistence["recordExtraction"]>[0]) {
        return {
          manifest: {
            ...input.manifest,
            contractCompletions: [{ contractId: "contract-test", title: "TEST HAUL", payout: ["r" as const] }],
          },
        };
      }
    }
    const room = new Room("DONE", {
      countdownMs: 0,
      persistence: new ContractPersistence(),
      aiWingmates: false,
      matchIdFactory: () => "00000000-0000-4000-8000-000000000099",
    });
    const peer = collectingPeer("contract-peer");
    room.join(peer.peer, "contract-token", "Contractor", "contract-player", "alpha");
    room.receive("contract-player", { type: "startMatch" });
    await waitFor(() => room.phase === "live");
    const internals = room as unknown as {
      members: Map<string, { botId: string }>;
      processRunEvents(events: Array<{ type: "extracted"; botId: string; squadId: string; items: Array<{ kind: "powerup"; type: "health" }> }>): void;
    };
    const botId = internals.members.get("contract-player")!.botId;
    internals.processRunEvents([{ type: "extracted", botId, squadId: "alpha", items: [{ kind: "powerup", type: "health" }] }]);
    await waitFor(() => peer.messages.some((message) => message.type === "runOver"));
    expect(peer.messages.find((message) => message.type === "runOver")).toMatchObject({
      reason: "extracted",
      contractCompletions: [{ contractId: "contract-test", title: "TEST HAUL", payout: ["r"] }],
    });
    room.dispose();
  });

  it("reports a failed extraction save and does not become terminable until persistence settles", async () => {
    let releaseFinish: (() => void) | undefined;
    let finishStarted = false;
    class FailingPersistence extends NoopPersistence {
      override readonly live = true;
      override async recordExtraction(): Promise<never> {
        throw new Error("relay unavailable");
      }
      override async finishMatch(): Promise<void> {
        finishStarted = true;
        await new Promise<void>((resolve) => { releaseFinish = resolve; });
      }
    }
    const room = new Room("FAIL", {
      countdownMs: 0,
      persistence: new FailingPersistence(),
      aiWingmates: false,
      matchIdFactory: () => "00000000-0000-4000-8000-000000000100",
    });
    const peer = collectingPeer("failed-save-peer");
    room.join(peer.peer, "failed-save-token", "Failed Save", "failed-save-player", "alpha");
    room.receive("failed-save-player", { type: "startMatch" });
    await waitFor(() => room.phase === "live");
    const internals = room as unknown as {
      members: Map<string, { botId: string }>;
      processRunEvents(events: Array<{ type: "extracted"; botId: string; squadId: string; items: Array<{ kind: "powerup"; type: "health" }> }>): void;
      completeIfNoActiveMembers(): void;
    };
    const botId = internals.members.get("failed-save-player")!.botId;
    internals.processRunEvents([{ type: "extracted", botId, squadId: "alpha", items: [{ kind: "powerup", type: "health" }] }]);
    internals.completeIfNoActiveMembers();

    await waitFor(() => finishStarted);
    expect(room.safeToTerminate).toBe(false);
    expect(room.readyForDisposal).toBe(false);
    await waitFor(() => peer.messages.some((message) => message.type === "runOver"));
    expect(peer.messages.find((message) => message.type === "err")).toMatchObject({ code: "save_failed" });
    expect(peer.messages.find((message) => message.type === "runOver")).toMatchObject({
      reason: "extracted",
      keptItems: [],
      lostItems: ["h"],
      learnedBlueprints: [],
      persistenceStatus: "failed",
    });

    releaseFinish?.();
    await room.waitForPersistence();
    expect(room.safeToTerminate).toBe(true);
    expect(room.readyForDisposal).toBe(true);
    room.dispose();
  });
});

function collectingPeer(id: string): { peer: RoomPeer; messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return { peer: { id, send: (message) => messages.push(message) }, messages };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Room state");
}
