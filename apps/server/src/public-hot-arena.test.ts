import { describe, expect, it, vi } from "vitest";
import type { PlayerRole, ServerMessage } from "@dotbot/protocol";
import { completedBaseTutorialState } from "@dotbot/game/baseTutorial";
import { NoopPersistence } from "./db";
import type { Persistence } from "./db";
import type { RoomPeer } from "./Room";
import { Room } from "./Room";
import { RoomManager } from "./RoomManager";

class RunBoundaryPersistence extends NoopPersistence {
  override readonly live = true;
  readonly starts: string[] = [];
  readonly rosters: string[][] = [];
  readonly outcomes: Array<{ matchId: string; playerId: string; outcome: string }> = [];
  readonly finishes: string[] = [];
  readonly finishInputs: Array<Parameters<Persistence["finishMatch"]>[0]> = [];

  override async getBaseTutorialForPlayer() { return completedBaseTutorialState; }
  override async startMatch(input: Parameters<NoopPersistence["startMatch"]>[0]) {
    this.starts.push(input.matchId);
    this.rosters.push([...input.playerIds]);
    return super.startMatch(input);
  }
  override async finishMatch(input: Parameters<Persistence["finishMatch"]>[0]) {
    this.finishes.push(input.matchId);
    this.finishInputs.push(structuredClone(input));
  }
  override async recordOutcome(input: Parameters<Persistence["recordOutcome"]>[0]) {
    this.outcomes.push(input);
  }
}

class DeferredFinishPersistence extends RunBoundaryPersistence {
  private releaseFinish!: () => void;
  readonly finishGate = new Promise<void>((resolve) => { this.releaseFinish = resolve; });

  override async finishMatch(input: Parameters<Persistence["finishMatch"]>[0]) {
    await this.finishGate;
    await super.finishMatch(input);
  }

  release(): void { this.releaseFinish(); }
}

class FailedFinishPersistence extends RunBoundaryPersistence {
  recovered = false;
  attempts = 0;

  override async finishMatch(): Promise<void> {
    this.attempts += 1;
    if (!this.recovered) {
      const error = new Error("00000000-0000-4000-8000-999999999999 secret-finish-detail");
      error.name = "00000000-0000-4000-8000-999999999999";
      throw error;
    }
  }

  recover(): void {
    this.recovered = true;
  }
}

class DeferredStartPersistence extends RunBoundaryPersistence {
  private releaseStart!: () => void;
  private markEntered!: () => void;
  readonly startEntered = new Promise<void>((resolve) => { this.markEntered = resolve; });
  readonly startGate = new Promise<void>((resolve) => { this.releaseStart = resolve; });

  override async startMatch(input: Parameters<NoopPersistence["startMatch"]>[0]) {
    this.starts.push(input.matchId);
    this.rosters.push([...input.playerIds]);
    this.markEntered();
    await this.startGate;
    return NoopPersistence.prototype.startMatch.call(this, input);
  }

  release(): void { this.releaseStart(); }
}

class FailedStartPersistence extends RunBoundaryPersistence {
  override async startMatch(input: Parameters<NoopPersistence["startMatch"]>[0]): Promise<never> {
    this.starts.push(input.matchId);
    this.rosters.push([...input.playerIds]);
    throw new Error("start response lost");
  }
}

class FailedOutcomePersistence extends RunBoundaryPersistence {
  recovered = false;
  outcomeAttempts = 0;

  override async recordOutcome(): Promise<void> {
    this.outcomeAttempts += 1;
    if (!this.recovered) throw new Error("outcome unavailable");
  }

  recover(): void {
    this.recovered = true;
  }
}

describe("public quick-play Room mode", () => {
  it("automatically runs a one-to-six-second assembly and exposes 18 player roles", async () => {
    let now = 10_000;
    const room = new Room("A2BC", {
      now: () => now,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 6_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000010",
    });
    const pilot = collectingPeer("pilot-peer");

    expect(room.join(pilot.peer, "pilot-token", "Pilot", "pilot", undefined, "party-pilot")).not.toBeNull();
    expect(room.phase).toBe("assembling");
    now += 999;
    room.tick(now);
    expect(room.phase).toBe("assembling");
    now += 1;
    room.tick(now);
    expect(room.phase).toBe("countdown");
    now += 4_999;
    room.tick(now);
    expect(room.phase).toBe("countdown");
    now += 1;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    const start = pilot.messages.find((message) => message.type === "matchStart");
    expect(start).toMatchObject({ matchId: "00000000-0000-4000-8000-000000000010" });
    const roles = (start as Extract<ServerMessage, { type: "matchStart" }>).roles as PlayerRole[];
    expect(roles).toHaveLength(18);
    expect(roles.filter((role) => role.controller === "human")).toHaveLength(1);
    expect(roles.filter((role) => role.controller === "ai")).toHaveLength(17);
    const snapshot = (room as unknown as { simulation: { getSnapshot(): { bots: Array<{ id: string; isAmbient: boolean }> } } }).simulation.getSnapshot();
    const playerRoleBots = snapshot.bots.filter((bot) => !bot.isAmbient);
    expect(playerRoleBots).toHaveLength(18);
    expect(new Set(playerRoleBots.map((bot) => bot.id))).toEqual(new Set(roles.map((role) => role.roleId)));
  });

  it("starts with all 18 humans and sends the complete roster to persistence", async () => {
    let now = 0;
    const persistence = new RunBoundaryPersistence();
    const room = new Room("FULL", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 6_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000018",
    });
    const peers = Array.from({ length: 18 }, (_, index) => collectingPeer(`peer-${index}`));
    for (let index = 0; index < peers.length; index += 1) {
      expect(room.join(peers[index].peer, `token-${index}`, `P${index}`, `player-${index}`, undefined, `party-${index}`)).not.toBeNull();
    }

    now = 999;
    room.tick(now);
    expect(room.phase).toBe("assembling");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    const roles = (peers[0].messages.find((message) => message.type === "matchStart") as Extract<ServerMessage, { type: "matchStart" }>).roles!;
    expect(roles.filter((role) => role.controller === "human")).toHaveLength(18);
    expect(persistence.rosters).toEqual([Array.from({ length: 18 }, (_, index) => `player-${index}`)]);
  });

  it("keeps a three-person party together and rejects live joins", async () => {
    let now = 0;
    const room = new Room("P4TY", { now: () => now, hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 } });
    const peers = ["a", "b", "c"].map(collectingPeer);
    for (let index = 0; index < 3; index += 1) {
      expect(room.join(peers[index].peer, `token-${index}`, `P${index}`, `p${index}`, undefined, "friends")).not.toBeNull();
    }
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    expect(room.join(collectingPeer("late").peer, "late-token", "Late", "late", undefined, "late-party")).toBeNull();
    const roles = (peers[0].messages.find((message) => message.type === "matchStart") as Extract<ServerMessage, { type: "matchStart" }>).roles!;
    const friends = roles.filter((role) => role.partyId === "friends");
    expect(friends).toHaveLength(3);
    expect(new Set(friends.map((role) => role.squadId)).size).toBe(1);
  });

  it("evicts every provisional member when a trusted party exceeds the three-player cap", () => {
    const released: string[] = [];
    const room = new Room("P4TY", {
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      onPublicMemberReleased: ({ peerId }) => { if (peerId) released.push(peerId); },
    });
    const peers = ["a", "b", "c", "d"].map(collectingPeer);
    for (let index = 0; index < 3; index += 1) {
      expect(room.join(peers[index].peer, `token-${index}`, `P${index}`, `p${index}`, undefined, "friends")).not.toBeNull();
    }
    let rejection: unknown;
    expect(room.join(peers[3].peer, "token-3", "P3", "p3", undefined, "friends", (value) => { rejection = value; })).toBeNull();
    expect(rejection).toEqual({ accepted: false, code: "party_invalid", retryable: false });
    expect(room.publicArenaMembers).toEqual([]);
    expect(released).toEqual(["a", "b", "c"]);
    for (const peer of peers.slice(0, 3)) {
      expect(peer.messages).toContainEqual(expect.objectContaining({ type: "err", code: "party_invalid" }));
    }
  });

  it("does not let a duplicate authenticated identity overwrite an admitted member", () => {
    const room = new Room("DUPE", { hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 } });
    const original = collectingPeer("original");
    expect(room.join(original.peer, "token-original", "Original", "player-1", undefined, "party-a")).not.toBeNull();
    expect(room.join(collectingPeer("duplicate").peer, "token-other", "Duplicate", "player-1", undefined, "party-b")).toBeNull();
    expect(room.join(collectingPeer("mismatch").peer, "token-original", "Mismatch", "player-2", undefined, "party-a")).toBeNull();
    expect(room.publicArenaMembers).toEqual([{ playerId: "player-1", name: "Original", partyId: "party-a", queued: true }]);
  });

  it("preflights an un-packable party atomically with a retryable routing reason", () => {
    const room = new Room("PACK", {
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    for (let party = 0; party < 6; party += 1) {
      for (let member = 0; member < 2; member += 1) {
        expect(room.join(collectingPeer(`peer-${party}-${member}`).peer, `token-${party}-${member}`, `P${party}-${member}`, `p-${party}-${member}`, undefined, `party-${party}`)).not.toBeNull();
      }
    }
    const before = room.publicArenaMembers;
    expect(room.evaluatePublicPartyAdmission([
      { playerId: "seven-a", name: "Seven A", partyId: "party-seven" },
      { playerId: "seven-b", name: "Seven B", partyId: "party-seven" },
    ])).toEqual({ accepted: false, code: "party_composition_full", retryable: true });
    expect(room.publicArenaMembers).toEqual(before);
    expect(room.publicArenaMembers.some((member) => member.partyId === "party-seven")).toBe(false);
    expect(room.retirementRequested).toBe(false);

    const first = collectingPeer("seventh-first");
    expect(room.join(first.peer, "seventh-token-1", "Seven A", "seven-a", undefined, "party-seven")).not.toBeNull();
    let rejection: unknown;
    expect(room.join(
      collectingPeer("seventh-second").peer,
      "seventh-token-2",
      "Seven B",
      "seven-b",
      undefined,
      "party-seven",
      (value) => { rejection = value; },
    )).toBeNull();
    expect(rejection).toEqual({ accepted: false, code: "party_composition_full", retryable: true });
    expect(first.messages).toContainEqual(expect.objectContaining({ type: "err", code: "party_composition_full", retryable: true }));
    expect(room.publicArenaMembers).toEqual(before);
  });

  it("requires explicit DEPLOY AGAIN and clears active effects and mines before the fresh run", async () => {
    let now = 0;
    const persistence = new RunBoundaryPersistence();
    const ids = [
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
    ];
    const room = new Room("RERU", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000, maxRuns: 4 },
      matchIdFactory: () => ids.shift()!,
    });
    const pilot = collectingPeer("pilot");
    room.join(pilot.peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    const firstRun = (room as unknown as {
      members: Map<string, { botId: string }>;
      simulation: {
        bots: Map<string, {
          id: string;
          squadId: string;
          floorId: string;
          position: { x: number; y: number };
          radarActiveMs: number;
          radarPings: Array<{ botId: string; floorId: string; x: number; y: number; ageMs: number }>;
          dashOverchargeMs: number;
          incognitoMs: number;
        }>;
        mines: Map<string, unknown>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
    });
    const firstSimulation = firstRun.simulation;
    const firstBot = firstSimulation.bots.get(firstRun.members.get("pilot")!.botId)!;
    firstBot.radarActiveMs = 8_000;
    firstBot.radarPings = [{
      botId: "stale-rival",
      floorId: firstBot.floorId,
      ...firstBot.position,
      ageMs: 100,
    }];
    firstBot.dashOverchargeMs = 60_000;
    firstBot.incognitoMs = 10_000;
    firstSimulation.mines.set("mine-00000000-0000-4000-8000-000000000021", {
      id: "mine-00000000-0000-4000-8000-000000000021",
      position: { ...firstBot.position },
      radius: 10,
      placedByBotId: firstBot.id,
      squadId: firstBot.squadId,
      floorId: firstBot.floorId,
      placedAtMs: 100,
      revealedToBotIds: [],
      armedAtTick: Number.MAX_SAFE_INTEGER,
      sensorElapsedMs: 0,
      revealMsByBotId: new Map(),
    });
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    expect(room.phase).toBe("results");
    expect(firstSimulation.getSnapshot()).toMatchObject({ bots: [], mines: [], coverages: [], noises: [] });
    now = 20_000;
    room.tick(now);
    expect(room.phase).toBe("results");

    room.receive("pilot", { type: "deployAgain" });
    expect(room.phase).toBe("assembling");
    now += 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    const secondRun = (room as unknown as {
      members: Map<string, { botId: string }>;
      simulation: {
        bots: Map<string, {
          radarActiveMs: number;
          radarPings: unknown[];
          dashOverchargeMs: number;
          incognitoMs: number;
        }>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
    });
    expect(secondRun.simulation).not.toBe(firstSimulation);
    expect(secondRun.simulation.bots.get(secondRun.members.get("pilot")!.botId)).toMatchObject({
      radarActiveMs: 0,
      radarPings: [],
      dashOverchargeMs: 0,
      incognitoMs: 0,
    });
    expect(secondRun.simulation.getSnapshot().mines).toEqual([]);
    expect(pilot.messages.filter((message) => message.type === "matchStart").map((message) => message.matchId)).toEqual([
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
    ]);
    expect(persistence.starts).toEqual([
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
    ]);
    expect(persistence.finishes).toEqual(["00000000-0000-4000-8000-000000000021"]);
    expect(persistence.finishInputs[0].summary).toEqual({
      reason: "complete",
      participantCount: 0,
      outcomes: {},
    });
    const persistedBoundary = JSON.stringify(persistence.finishInputs[0]);
    expect(persistedBoundary).not.toContain(firstBot.id);
    expect(persistedBoundary).not.toContain("mine-00000000-0000-4000-8000-000000000021");
    expect(persistedBoundary).not.toMatch(/radar|incognito|dashOvercharge|mine/i);
  });

  it("replays the authoritative outcome on reconnect before and after results settlement", async () => {
    let now = 0;
    const persistence = new DeferredFinishPersistence();
    const room = new Room("RCOR", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000, maxRuns: 4 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000023",
    });
    const pilot = collectingPeer("result-original");
    room.join(pilot.peer, "result-token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    const live = room as unknown as {
      simulation: { getSnapshot(): import("@dotbot/game/types").GameSnapshot };
      timeoutRun(bots: import("@dotbot/game/types").GameSnapshot["bots"]): void;
    };
    live.timeoutRun(live.simulation.getSnapshot().bots);
    await vi.waitFor(() => expect(pilot.messages).toContainEqual(expect.objectContaining({
      type: "runOver",
      reason: "timeout",
    })));
    expect(room.phase).toBe("results");

    room.disconnect(pilot.peer.id);
    const settling = collectingPeer("result-settling");
    expect(room.join(
      settling.peer,
      "result-token",
      "Pilot",
      "pilot",
      undefined,
      "party",
    )).not.toBeNull();
    expect(settling.messages.map((message) => message.type)).toEqual([
      "arenaWelcome",
      "matchStart",
      "runOver",
    ]);
    expect(settling.messages.at(-1)).toMatchObject({ type: "runOver", reason: "timeout" });

    persistence.release();
    await room.waitForPersistence();
    expect(room.phase).toBe("results");

    room.disconnect(settling.peer.id);
    const settled = collectingPeer("result-settled");
    expect(room.join(
      settled.peer,
      "result-token",
      "Pilot",
      "pilot",
      undefined,
      "party",
    )).not.toBeNull();
    expect(settled.messages.map((message) => message.type)).toEqual([
      "arenaWelcome",
      "matchStart",
      "runOver",
    ]);
    expect(settled.messages.at(-2)).toMatchObject({
      type: "matchStart",
      matchId: "00000000-0000-4000-8000-000000000023",
    });
    expect(settled.messages.at(-1)).toMatchObject({ type: "runOver", reason: "timeout" });
  });

  it("releases connected non-opted-in parties before reopening assembly capacity", async () => {
    let now = 0;
    const released: string[] = [];
    const room = new Room("SWAP", {
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      onPublicMemberReleased: ({ peerId }) => { if (peerId) released.push(peerId); },
    });
    const staying = collectingPeer("staying-peer");
    const leaving = collectingPeer("leaving-peer");
    room.join(staying.peer, "stay-token", "Stay", "stay", undefined, "stay-party");
    room.join(leaving.peer, "leave-token", "Leave", "leave", undefined, "leave-party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();

    room.receive("stay", { type: "deployAgain" });
    expect(room.phase).toBe("assembling");
    expect(room.publicArenaMembers.map((member) => member.playerId)).toEqual(["stay"]);
    expect(released).toEqual(["leaving-peer"]);
    expect(room.join(collectingPeer("replacement").peer, "new-token", "New", "new", undefined, "new-party")).not.toBeNull();
  });

  it("releases a disconnected non-opted reservation before reopening capacity", async () => {
    let now = 0;
    const releases: import("./Room").PublicMemberRelease[] = [];
    const room = new Room("FREE", {
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      connectionHandoffMs: 60_000,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      onPublicMemberReleased: (release) => { releases.push(release); },
    });
    const staying = collectingPeer("staying-peer");
    const leaving = collectingPeer("leaving-peer");
    room.join(staying.peer, "stay-token", "Stay", "stay", undefined, "stay-party", undefined, "reserved-stay");
    room.join(leaving.peer, "leave-token", "Leave", "leave", undefined, "leave-party", undefined, "reserved-leave");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    room.disconnect(leaving.peer.id);
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    room.receive("stay", { type: "deployAgain" });

    expect(releases).toContainEqual({
      peerId: null,
      playerId: "leave",
      reservationPlayerId: "reserved-leave",
    });
    expect(room.publicArenaMembers.map((member) => member.playerId)).toEqual(["stay"]);
  });

  it("requests bounded retirement only between runs after persistence settles", async () => {
    let now = 0;
    const room = new Room("OLD1", {
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000, maxRuns: 1, maxAgeMs: 60_000 },
    });
    room.join(collectingPeer("pilot").peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    expect(room.retirementRequested).toBe(false);
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    expect(room.phase).toBe("results");
    expect(room.retirementRequested).toBe(true);
    expect(room.readyForDisposal).toBe(true);
  });

  it("retires cleanly when the age boundary lands during assembly countdown", () => {
    let now = 0;
    const room = new Room("AGED", {
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 6_000, maxAgeMs: 6_000 },
    });
    room.join(collectingPeer("pilot").peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    expect(room.phase).toBe("countdown");

    now = 6_000;
    room.tick(now);

    expect(room.phase).toBe("assembling");
    expect(room.retirementRequested).toBe(true);
    expect(room.readyForDisposal).toBe(true);
  });

  it("turns an external drain into retirement and cannot start another ordinary run", async () => {
    let now = 0;
    const persistence = new RunBoundaryPersistence();
    const pilot = collectingPeer("pilot");
    const room = new Room("DRAN", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    room.join(pilot.peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    room.requestRetirement();
    expect(room.safeToTerminate).toBe(false);
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    room.receive("pilot", { type: "deployAgain" });
    now = 10_000;
    room.tick(now);

    expect(room.phase).toBe("results");
    expect(room.readyForDisposal).toBe(true);
    expect(persistence.starts).toHaveLength(1);
    expect(pilot.messages).toContainEqual(expect.objectContaining({ type: "err", code: "arena_retiring" }));
  });

  it("freezes for reconnect grace, then labels the same player role as AI for the rest of the run", async () => {
    let now = 0;
    const persistence = new RunBoundaryPersistence();
    const room = new Room("HAND", {
      now: () => now,
      persistence,
      connectionHandoffMs: 20,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000031",
    });
    const original = collectingPeer("original");
    const observer = collectingPeer("observer");
    room.join(original.peer, "token", "Pilot", "pilot", undefined, "party");
    room.join(observer.peer, "observer-token", "Observer", "observer", undefined, "observer-party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    const internals = room as unknown as { simulation: { controllers: Map<string, string> } };

    vi.useFakeTimers();
    try {
      room.disconnect(original.peer.id);
      expect(internals.simulation.controllers.get("human-pilot")).toBe("frozen");
      await vi.advanceTimersByTimeAsync(19);
      const resumed = collectingPeer("resumed");
      expect(room.join(resumed.peer, "token", "Pilot", "pilot", undefined, "party")).not.toBeNull();
      expect(internals.simulation.controllers.get("human-pilot")).toBe("human");

      room.disconnect(resumed.peer.id);
      await vi.advanceTimersByTimeAsync(20);
      expect(internals.simulation.controllers.get("human-pilot")).toBe("ai");
      expect(observer.messages).toContainEqual({
        type: "roleController",
        matchId: "00000000-0000-4000-8000-000000000031",
        roleId: "human-pilot",
        controller: "ai",
        reason: "disconnect_timeout",
      });
      expect(room.join(collectingPeer("too-late").peer, "token", "Pilot", "pilot", undefined, "party")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Radar, Invisibility, and mines viewer-private through hot-arena reconnect and AI takeover", async () => {
    let now = 0;
    const room = new Room("PWRH", {
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      connectionHandoffMs: 20,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000034",
    });
    const radar = collectingPeer("radar-peer");
    const invisible = collectingPeer("invisible-peer");
    room.join(radar.peer, "radar-token", "Radar", "RADR-2345", undefined, "radar-party");
    room.join(invisible.peer, "invisible-token", "Invisible", "HIDE-2345", undefined, "invisible-party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    const internals = room as unknown as {
      members: Map<string, { botId: string; squadId: string }>;
      simulation: {
        controllers: Map<string, string>;
        bots: Map<string, {
          id: string;
          squadId: string;
          floorId: string;
          position: { x: number; y: number };
          isAmbient: boolean;
          radarActiveMs: number;
          radarPings: Array<{ botId: string; floorId: string; x: number; y: number; ageMs: number }>;
          dashOverchargeMs: number;
          incognitoMs: number;
        }>;
        mines: Map<string, unknown>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
      broadcastSnapshot(snapshot: import("@dotbot/game/types").GameSnapshot): void;
    };
    const radarMember = internals.members.get("RADR-2345")!;
    const invisibleMember = internals.members.get("HIDE-2345")!;
    const radarBot = internals.simulation.bots.get(radarMember.botId)!;
    const invisibleBot = internals.simulation.bots.get(invisibleMember.botId)!;
    radarBot.floorId = invisibleBot.floorId;
    radarBot.position = { x: invisibleBot.position.x + 80, y: invisibleBot.position.y };
    const radarTarget = [...internals.simulation.bots.values()].find((bot) =>
      !bot.isAmbient
      && bot.id !== radarBot.id
      && bot.id !== invisibleBot.id
      && bot.squadId !== radarBot.squadId)!;

    radarBot.radarActiveMs = 8_000;
    radarBot.radarPings = [{
      botId: radarTarget.id,
      floorId: radarTarget.floorId,
      ...radarTarget.position,
      ageMs: 250,
    }];
    radarBot.dashOverchargeMs = 45_000;
    invisibleBot.incognitoMs = 6_000;
    invisibleBot.dashOverchargeMs = 30_000;
    const mineId = "mine-00000000-0000-4000-8000-000000000034";
    internals.simulation.mines.set(mineId, {
      id: mineId,
      position: { ...invisibleBot.position },
      radius: 10,
      placedByBotId: invisibleBot.id,
      squadId: invisibleBot.squadId,
      floorId: invisibleBot.floorId,
      placedAtMs: 321,
      revealedToBotIds: [],
      armedAtTick: Number.MAX_SAFE_INTEGER,
      sensorElapsedMs: 0,
      revealMsByBotId: new Map([[radarBot.id, 8_000]]),
    });

    radar.messages.length = 0;
    invisible.messages.length = 0;
    internals.broadcastSnapshot(internals.simulation.getSnapshot());
    const radarSnapshot = radar.messages.find((message) => message.type === "snap");
    const invisibleSnapshot = invisible.messages.find((message) => message.type === "snap");
    const radarMines = radarSnapshot?.mines ?? [];
    expect(radarSnapshot?.bots.find((bot) => bot.i === radarBot.id)).toMatchObject({
      r: [8_000, [[radarTarget.id, radarTarget.position.x, radarTarget.position.y, radarTarget.floorId, 250]]],
      o: 45_000,
    });
    expect(radarSnapshot?.bots.some((bot) => bot.i === invisibleBot.id)).toBe(false);
    expect(radarSnapshot?.mines).toContainEqual(expect.objectContaining({
      id: mineId,
      presentation: "revealed",
      placedAtMs: 0,
    }));
    expect(radarMines.find((mine) => mine.id === mineId)?.placedByBotId).toBeUndefined();
    expect(radarMines.find((mine) => mine.id === mineId)?.squadId).toBeUndefined();
    expect(invisibleSnapshot?.bots.find((bot) => bot.i === invisibleBot.id)).toMatchObject({
      o: 30_000,
      ic: 6_000,
    });
    const radarBodyForInvisible = invisibleSnapshot?.bots.find((bot) => bot.i === radarBot.id);
    expect(radarBodyForInvisible).toBeDefined();
    expect(radarBodyForInvisible?.r).toBeUndefined();
    expect(radarBodyForInvisible?.o).toBeUndefined();
    expect(invisibleSnapshot?.mines).toContainEqual(expect.objectContaining({
      id: mineId,
      presentation: "squad",
      placedByBotId: invisibleBot.id,
      squadId: invisibleBot.squadId,
      placedAtMs: 321,
    }));

    room.disconnect(radar.peer.id);
    const reconnected = collectingPeer("radar-reconnected");
    expect(room.join(
      reconnected.peer,
      "radar-token",
      "Radar",
      "RADR-2345",
      undefined,
      "radar-party",
    )).not.toBeNull();
    internals.broadcastSnapshot(internals.simulation.getSnapshot());
    const reconnectSnapshot = reconnected.messages.filter((message) => message.type === "snap").at(-1);
    expect(reconnectSnapshot?.bots.find((bot) => bot.i === radarBot.id)).toMatchObject({
      r: [8_000, [[radarTarget.id, radarTarget.position.x, radarTarget.position.y, radarTarget.floorId, 250]]],
      o: 45_000,
    });
    expect(reconnectSnapshot?.bots.some((bot) => bot.i === invisibleBot.id)).toBe(false);
    const reconnectMine = (reconnectSnapshot?.mines ?? []).find((mine) => mine.id === mineId);
    expect(reconnectMine).toMatchObject({ presentation: "revealed", placedAtMs: 0 });
    expect(reconnectMine?.placedByBotId).toBeUndefined();
    expect(reconnectMine?.squadId).toBeUndefined();

    vi.useFakeTimers();
    try {
      room.disconnect(invisible.peer.id);
      expect(internals.simulation.controllers.get(invisibleBot.id)).toBe("frozen");
      await vi.advanceTimersByTimeAsync(19);
      const invisibleReconnected = collectingPeer("invisible-reconnected");
      expect(room.join(
        invisibleReconnected.peer,
        "invisible-token",
        "Invisible",
        "HIDE-2345",
        undefined,
        "invisible-party",
      )).not.toBeNull();
      expect(internals.members.get("HIDE-2345")?.botId).toBe(invisibleBot.id);
      expect(internals.simulation.controllers.get(invisibleBot.id)).toBe("human");
      expect(internals.simulation.bots.get(invisibleBot.id)).toMatchObject({
        incognitoMs: 6_000,
        dashOverchargeMs: 30_000,
      });
      expect(internals.simulation.mines.has(mineId)).toBe(true);
      internals.broadcastSnapshot(internals.simulation.getSnapshot());
      const invisibleReconnectSnapshot = invisibleReconnected.messages
        .filter((message) => message.type === "snap").at(-1);
      expect(invisibleReconnectSnapshot?.bots.find((bot) => bot.i === invisibleBot.id)).toMatchObject({
        o: 30_000,
        ic: 6_000,
      });
      expect(invisibleReconnectSnapshot?.mines).toContainEqual(expect.objectContaining({
        id: mineId,
        presentation: "squad",
        placedByBotId: invisibleBot.id,
        squadId: invisibleBot.squadId,
        placedAtMs: 321,
      }));

      room.disconnect(invisibleReconnected.peer.id);
      expect(internals.simulation.controllers.get(invisibleBot.id)).toBe("frozen");
      await vi.advanceTimersByTimeAsync(20);
      expect(internals.simulation.controllers.get(invisibleBot.id)).toBe("ai");
      expect(internals.simulation.bots.get(invisibleBot.id)).toMatchObject({
        incognitoMs: 6_000,
        dashOverchargeMs: 30_000,
      });
      expect(internals.simulation.mines.has(mineId)).toBe(true);
      internals.broadcastSnapshot(internals.simulation.getSnapshot());
      const takeoverSnapshot = reconnected.messages.filter((message) => message.type === "snap").at(-1);
      const takeoverMines = takeoverSnapshot?.mines ?? [];
      expect(takeoverSnapshot?.bots.some((bot) => bot.i === invisibleBot.id)).toBe(false);
      expect(takeoverMines.find((mine) => mine.id === mineId)).toMatchObject({
        presentation: "revealed",
        placedAtMs: 0,
      });
    } finally {
      vi.useRealTimers();
      room.dispose();
    }
  });

  it("locks admission during async start and converts a grace expiry without creating a ghost role", async () => {
    let now = 0;
    const persistence = new DeferredStartPersistence();
    const room = new Room("RACE", {
      now: () => now,
      persistence,
      connectionHandoffMs: 5,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000032",
    });
    const pilot = collectingPeer("pilot-peer");
    const observer = collectingPeer("observer-peer");
    room.join(pilot.peer, "pilot-token", "Pilot", "pilot", undefined, "pilot-party");
    room.join(observer.peer, "observer-token", "Observer", "observer", undefined, "observer-party");
    now = 1_000;
    room.tick(now);
    await persistence.startEntered;

    expect(room.join(collectingPeer("late-peer").peer, "late-token", "Late", "late", undefined, "late-party")).toBeNull();
    room.disconnect(pilot.peer.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(room.publicArenaMembers.map((member) => member.playerId)).toContain("pilot");

    persistence.release();
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    const start = observer.messages.find((message) => message.type === "matchStart") as Extract<ServerMessage, { type: "matchStart" }>;
    expect(start.roles?.find((role) => role.playerId === "pilot")?.controller).toBe("ai");
    expect((room as unknown as { simulation: { controllers: Map<string, string> } }).simulation.controllers.get("human-pilot")).toBe("ai");
    expect(persistence.rosters[0]).toEqual(["pilot", "observer"]);
  });

  it("does not let a completed async start resurrect a disposed arena", async () => {
    let now = 0;
    const persistence = new DeferredStartPersistence();
    const room = new Room("STOP", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    room.join(collectingPeer("pilot-peer").peer, "pilot-token", "Pilot", "pilot", undefined, "pilot-party");
    now = 1_000;
    room.tick(now);
    await persistence.startEntered;

    room.dispose();
    persistence.release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(room.phase).toBe("countdown");
    expect((room as unknown as { simulation: unknown }).simulation).toBeNull();
    expect(room.tick(now + 1_000)).toEqual([]);
  });

  it("settles the exact persistence boundary when drain interrupts an async start", async () => {
    let now = 0;
    const persistence = new DeferredStartPersistence();
    const room = new Room("DRIP", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000033",
    });
    room.join(collectingPeer("pilot-peer").peer, "pilot-token", "Pilot", "pilot", undefined, "pilot-party");
    now = 1_000;
    room.tick(now);
    await persistence.startEntered;

    room.requestRetirement();
    persistence.release();
    await vi.waitFor(() => expect(room.readyForDisposal).toBe(true));
    await room.waitForPersistence();

    expect(room.phase).toBe("assembling");
    expect(persistence.starts).toEqual(["00000000-0000-4000-8000-000000000033"]);
    expect(persistence.outcomes).toEqual([{
      matchId: "00000000-0000-4000-8000-000000000033",
      playerId: "pilot",
      outcome: "disconnected",
    }]);
    expect(persistence.finishes).toEqual(["00000000-0000-4000-8000-000000000033"]);
  });

  it("keeps the run live under AI control after the last human exhausts reconnect grace", async () => {
    let now = 0;
    const room = new Room("AION", {
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      connectionHandoffMs: 20,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    const pilot = collectingPeer("pilot");
    room.join(pilot.peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    vi.useFakeTimers();
    try {
      room.disconnect(pilot.peer.id);
      await vi.advanceTimersByTimeAsync(20);
      expect(room.phase).toBe("live");
      expect((room as unknown as { simulation: { controllers: Map<string, string> } }).simulation.controllers.get("human-pilot")).toBe("ai");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps all 18 roles present by converting an explicit leaver to AI", async () => {
    let now = 0;
    const persistence = new RunBoundaryPersistence();
    const observer = collectingPeer("observer-peer");
    const room = new Room("QUIT", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    room.join(collectingPeer("leaver-peer").peer, "leaver-token", "Leaver", "leaver", undefined, "leaver-party");
    room.join(observer.peer, "observer-token", "Observer", "observer", undefined, "observer-party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    room.receive("leaver", { type: "leaveRun" });

    const simulation = (room as unknown as { simulation: { controllers: Map<string, string>; getSnapshot(): { bots: Array<{ id: string; isAmbient?: boolean }> } } }).simulation;
    expect(simulation.getSnapshot().bots.filter((bot) => !bot.isAmbient)).toHaveLength(18);
    expect(simulation.controllers.get("human-leaver")).toBe("ai");
    expect(room.phase).toBe("live");
    expect(observer.messages).toContainEqual(expect.objectContaining({
      type: "roleController",
      roleId: "human-leaver",
      controller: "ai",
      reason: "player_left",
    }));
  });

  it("rejects invalid assembly policies", () => {
    expect(() => new Room("FAST", { hotArena: { assemblyMinMs: 999, assemblyMaxMs: 1_000 } })).toThrow(/at least one second/i);
    expect(() => new Room("SLOW", { hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 6_001 } })).toThrow(/six seconds/i);
  });

  it("does not request process retirement after an ordinary run and requests it once at the configured boundary", async () => {
    let now = 0;
    const retired = vi.fn();
    const availability: Array<{ open: boolean; closesAt?: number }> = [];
    const manager = new RoomManager({
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000, maxRuns: 2 },
      sessionRoomCode: async () => "KEEP",
      onRoomExpired: retired,
      onPublicAdmissionChange: (state) => { availability.push({ open: state.open, closesAt: state.closesAt }); },
    });
    const room = manager.createRoom("KEEP");
    room.join(collectingPeer("pilot").peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    (manager as unknown as { tick(): void }).tick();
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    (manager as unknown as { tick(): void }).tick();
    expect(retired).not.toHaveBeenCalled();
    expect(manager.rooms).toBe(1);

    room.receive("pilot", { type: "deployAgain" });
    now = 2_000;
    (manager as unknown as { tick(): void }).tick();
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    (manager as unknown as { tick(): void }).tick();
    await vi.waitFor(() => expect(retired).toHaveBeenCalledTimes(1));
    expect(manager.rooms).toBe(0);
    expect(availability.map((state) => state.open)).toEqual([true, false, true, false]);
  });

  it("does not leave results or start the next persistence boundary while the prior finish write is in flight", async () => {
    let now = 0;
    const persistence = new DeferredFinishPersistence();
    const room = new Room("SAVE", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    const pilot = collectingPeer("pilot");
    room.join(pilot.peer, "pilot-token", "Pilot", "pilot", undefined, "pilot-party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    (room as unknown as { end(reason: string): void }).end("complete");
    expect(room.phase).toBe("results");

    const newcomer = collectingPeer("newcomer");
    expect(room.join(newcomer.peer, "new-token", "New", "new", undefined, "new-party")).not.toBeNull();
    room.receive("pilot", { type: "deployAgain" });
    now = 30_000;
    room.tick(now);
    expect(room.phase).toBe("results");
    expect(persistence.starts).toHaveLength(1);

    persistence.release();
    await room.waitForPersistence();
    expect(room.phase).toBe("assembling");
    expect(persistence.starts).toHaveLength(1);
  });

  it("remains unsafe after a failed finish and recovers the exact boundary before retirement", async () => {
    let now = 0;
    const persistence = new FailedFinishPersistence();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const room = new Room("FAIL", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000042",
    });
    room.join(collectingPeer("pilot").peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();

    expect(room.phase).toBe("results");
    expect(room.retirementRequested).toBe(true);
    expect(room.safeToTerminate).toBe(false);
    expect(room.readyForDisposal).toBe(false);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("999999999999");
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("secret-finish-detail");

    persistence.recover();
    now += 5_000;
    room.tick(now);
    await room.waitForPersistence();
    expect(persistence.attempts).toBe(2);
    expect(room.safeToTerminate).toBe(true);
    expect(room.readyForDisposal).toBe(true);
  });

  it("retires and closes the same match id when startMatch may have committed before its response failed", async () => {
    let now = 0;
    const persistence = new FailedStartPersistence();
    const room = new Room("LOST", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000041",
    });
    room.join(collectingPeer("pilot").peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.retirementRequested).toBe(true));
    await room.waitForPersistence();

    expect(persistence.starts).toEqual(["00000000-0000-4000-8000-000000000041"]);
    expect(persistence.outcomes).toEqual([{
      matchId: "00000000-0000-4000-8000-000000000041",
      playerId: "pilot",
      outcome: "disconnected",
    }]);
    expect(persistence.finishes).toEqual(["00000000-0000-4000-8000-000000000041"]);
    expect(room.readyForDisposal).toBe(true);
  });

  it("retains and retries an exhausted participant outcome before finishing the boundary", async () => {
    let now = 0;
    const persistence = new FailedOutcomePersistence();
    const released: string[] = [];
    const room = new Room("OUTC", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      onPublicMemberReleased: ({ peerId }) => { if (peerId) released.push(peerId); },
    });
    const pilot = collectingPeer("pilot-peer");
    room.join(pilot.peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    room.receive("pilot", { type: "leaveRun" });
    await room.waitForPersistence();

    expect(room.phase).toBe("results");
    expect(room.retirementRequested).toBe(true);
    expect(room.readyForDisposal).toBe(false);
    expect(released).toEqual(["pilot-peer"]);

    persistence.recover();
    now += 5_000;
    room.tick(now);
    await room.waitForPersistence();
    expect(persistence.outcomeAttempts).toBe(3);
    expect(room.readyForDisposal).toBe(true);
  });

  it("retries failed arena-directory opens and closes without reversing the desired state", async () => {
    let now = 0;
    const updates: boolean[] = [];
    let openFailures = 1;
    let closeFailures = 1;
    const room = new Room("SYNC", {
      now: () => now,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      onPublicAdmissionChange: async ({ open }) => {
        updates.push(open);
        if (open && openFailures-- > 0) throw new Error("open conflict");
        if (!open && closeFailures-- > 0) throw new Error("close timeout");
      },
    });
    room.join(collectingPeer("pilot").peer, "token", "Pilot", "pilot", undefined, "party");
    await vi.waitFor(() => expect(updates).toEqual([true]));
    await vi.waitFor(() => expect((room as unknown as { publicAdmissionFailed: boolean }).publicAdmissionFailed).toBe(true));

    now = 600;
    room.tick(now);
    await vi.waitFor(() => expect(updates).toEqual([true, true]));
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    await vi.waitFor(() => expect(updates).toEqual([true, true, false]));
    await vi.waitFor(() => expect((room as unknown as { publicAdmissionFailed: boolean }).publicAdmissionFailed).toBe(true));

    now = 1_600;
    room.tick(now);
    await vi.waitFor(() => expect(updates).toEqual([true, true, false, false]));
  });

  it("finishes and retires a persistence boundary when configuration fails after startMatch", async () => {
    let now = 0;
    const persistence = new RunBoundaryPersistence();
    const room = new Room("BADC", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000, minInsertionSpacing: 100_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000099",
    });
    const pilot = collectingPeer("pilot");
    room.join(pilot.peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.retirementRequested).toBe(true));
    await room.waitForPersistence();

    expect(persistence.starts).toEqual(["00000000-0000-4000-8000-000000000099"]);
    expect(persistence.outcomes).toEqual([{
      matchId: "00000000-0000-4000-8000-000000000099",
      playerId: "pilot",
      outcome: "disconnected",
    }]);
    expect(persistence.finishes).toEqual(["00000000-0000-4000-8000-000000000099"]);
    expect(room.readyForDisposal).toBe(true);
    expect(pilot.messages).toContainEqual(expect.objectContaining({ type: "err", code: "arena_configuration_invalid" }));
  });
});

function collectingPeer(id: string): { peer: RoomPeer; messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return { peer: { id, send: (message) => messages.push(message) }, messages };
}
