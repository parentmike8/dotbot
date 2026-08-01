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
  readonly finishes: string[] = [];

  override async getBaseTutorialForPlayer() { return completedBaseTutorialState; }
  override async startMatch(input: Parameters<NoopPersistence["startMatch"]>[0]) {
    this.starts.push(input.matchId);
    return super.startMatch(input);
  }
  override async finishMatch(input: Parameters<Persistence["finishMatch"]>[0]) {
    this.finishes.push(input.matchId);
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
  override async finishMatch(): Promise<void> {
    throw new Error("finish unavailable");
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

  it("keeps a three-person party together, rejects a fourth member, and rejects live joins", async () => {
    let now = 0;
    const room = new Room("P4TY", { now: () => now, hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 } });
    const peers = ["a", "b", "c", "d"].map(collectingPeer);
    for (let index = 0; index < 3; index += 1) {
      expect(room.join(peers[index].peer, `token-${index}`, `P${index}`, `p${index}`, undefined, "friends")).not.toBeNull();
    }
    expect(room.join(peers[3].peer, "token-3", "P3", "p3", undefined, "friends")).toBeNull();
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    expect(room.join(collectingPeer("late").peer, "late-token", "Late", "late", undefined, "late-party")).toBeNull();
    const roles = (peers[0].messages.find((message) => message.type === "matchStart") as Extract<ServerMessage, { type: "matchStart" }>).roles!;
    const friends = roles.filter((role) => role.partyId === "friends");
    expect(friends).toHaveLength(3);
    expect(new Set(friends.map((role) => role.squadId)).size).toBe(1);
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

  it("requires explicit DEPLOY AGAIN and creates a fresh persistence boundary on the same room", async () => {
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
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();
    expect(room.phase).toBe("results");
    now = 20_000;
    room.tick(now);
    expect(room.phase).toBe("results");

    room.receive("pilot", { type: "deployAgain" });
    expect(room.phase).toBe("assembling");
    now += 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    expect(persistence.starts).toEqual([
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
    ]);
    expect(persistence.finishes).toEqual(["00000000-0000-4000-8000-000000000021"]);
  });

  it("releases connected non-opted-in parties before reopening assembly capacity", async () => {
    let now = 0;
    const released: string[] = [];
    const room = new Room("SWAP", {
      now: () => now,
      persistence: new RunBoundaryPersistence(),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      onPublicMemberReleased: (peerId) => { released.push(peerId); },
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

  it("retires between runs when the completed run cannot be durably finished", async () => {
    let now = 0;
    const room = new Room("FAIL", {
      now: () => now,
      persistence: new FailedFinishPersistence(),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    room.join(collectingPeer("pilot").peer, "token", "Pilot", "pilot", undefined, "party");
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    (room as unknown as { end(reason: string): void }).end("complete");
    await room.waitForPersistence();

    expect(room.phase).toBe("results");
    expect(room.retirementRequested).toBe(true);
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
    expect(persistence.finishes).toEqual(["00000000-0000-4000-8000-000000000099"]);
    expect(room.readyForDisposal).toBe(true);
    expect(pilot.messages).toContainEqual(expect.objectContaining({ type: "err", code: "arena_configuration_invalid" }));
  });
});

function collectingPeer(id: string): { peer: RoomPeer; messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return { peer: { id, send: (message) => messages.push(message) }, messages };
}
