import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@dotbot/protocol";
import { NoopPersistence, type Persistence } from "./db";
import type { BaseObjectKind } from "@dotbot/game/types";
import { Room, type RoomPeer } from "./Room";
import { carriesAction, fromWireKillCamClip } from "@dotbot/protocol";
import { buildingContaining, buildingOfFloor } from "@dotbot/game/mapModel";
import { downtownMap } from "@dotbot/game/content/downtown";

describe("Room lobby squads", () => {
  it("cancels a pending legacy countdown when the rollback room is disposed", async () => {
    const room = new Room("STOP", { countdownMs: 20, persistence: new NoopPersistence(), aiWingmates: false });
    room.join(collectingPeer("host").peer, "host-token", "Host", "host", "alpha");
    room.receive("host", { type: "startMatch" });
    expect(room.phase).toBe("countdown");

    room.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(room.phase).toBe("countdown");
    expect((room as unknown as { simulation: unknown }).simulation).toBeNull();
  });

  it("rejects a second device token for the same canonical or retired public identity", () => {
    const room = new Room("DUPE", { persistence: new NoopPersistence(), aiWingmates: false });
    const first = collectingPeer("same-account-first");
    const second = collectingPeer("same-account-second");
    expect(room.join(first.peer, "first-device-token", "Pilot", "ABCD-EFGH", "alpha", undefined, undefined, undefined, "00000000-0000-4000-8000-000000000001")).not.toBeNull();
    expect(room.join(second.peer, "second-device-token", "Pilot", "WXYZ-2345", "alpha", undefined, undefined, undefined, "00000000-0000-4000-8000-000000000002", ["ABCD-EFGH"]))
      .toBeNull();
    expect(room.size).toBe(1);
    room.dispose();
  });

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

  it("mirrors recruited bot squads into member interest and client metadata", async () => {
    const room = new Room("RECR", {
      countdownMs: 0,
      persistence: new NoopPersistence(),
      aiWingmates: false,
    });
    const alpha = collectingPeer("recruit-alpha");
    const bravo = collectingPeer("recruit-bravo");
    room.join(alpha.peer, "recruit-token-a", "Alpha", "recruit-a", "alpha");
    room.join(bravo.peer, "recruit-token-b", "Bravo", "recruit-b", "bravo");
    room.receive("recruit-a", { type: "startMatch" });
    await waitFor(() => room.phase === "live");

    const internals = room as unknown as {
      members: Map<string, { botId: string; squadId: string }>;
      simulation: {
        bots: Map<string, { squadId: string }>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
      syncMemberSquads(snapshot: import("@dotbot/game/types").GameSnapshot): void;
    };
    const recruited = internals.members.get("recruit-b")!;
    internals.simulation.bots.get(recruited.botId)!.squadId = "alpha";
    internals.syncMemberSquads(internals.simulation.getSnapshot());

    expect(recruited.squadId).toBe("alpha");
    for (const peer of [alpha, bravo]) {
      expect(peer.messages.filter((message) => message.type === "meta").at(-1))
        .toMatchObject({
          type: "meta",
          add: [expect.objectContaining({ id: recruited.botId, squadId: "alpha" })],
          remove: [],
        });
    }
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
      simulation: {
        bots: Map<string, {
          id: string;
          squadId: string;
          floorId: string;
          position: { x: number; y: number };
          state: string;
          shields: number;
        }>;
        mines: Map<string, unknown>;
      };
    };
    const member = internals.members.get("p1")!;
    const bot = internals.simulation.bots.get(member.botId)!;
    internals.simulation.mines.set("mine-give-up", {
      id: "mine-give-up",
      position: { ...bot.position },
      radius: 10,
      placedByBotId: bot.id,
      squadId: bot.squadId,
      floorId: bot.floorId,
      placedAtMs: 10,
      revealedToBotIds: [],
      armedAtTick: 1,
      sensorElapsedMs: 0,
      revealMsByBotId: new Map(),
    });
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
    expect(internals.simulation.mines.size).toBe(0);
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

describe("Room victim-private kill cam", () => {
  it("delivers only to the victim, resends after reconnect, clears on revive, and replaces on a repeated down", async () => {
    const room = new Room("KCAM", {
      countdownMs: 0,
      persistence: new NoopPersistence(),
      aiWingmates: false,
    });
    const victim = collectingPeer("killcam-victim");
    const rival = collectingPeer("killcam-rival");
    room.join(victim.peer, "killcam-token-victim", "Victim", "killcam-player-victim", "alpha");
    room.join(rival.peer, "killcam-token-rival", "Rival", "killcam-player-rival", "bravo");
    room.receive("killcam-player-victim", { type: "startMatch" });
    await waitFor(() => room.phase === "live");

    type MutableBot = import("@dotbot/game/types").DotBotEntity;
    const internals = room as unknown as {
      members: Map<string, {
        botId: string;
        lastKillCam: import("@dotbot/protocol").KillCamClip | null;
        activeKillCamId: string | null;
        inputQueue: import("@dotbot/protocol").WireInputFrame[];
        inputStarved: boolean;
      }>;
      simulation: {
        bots: Map<string, MutableBot>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
      killCamHistory: { record(snapshot: import("@dotbot/game/types").GameSnapshot): void };
      processKillCamEvents(
        events: import("@dotbot/game/types").SimEvent[],
        snapshot: import("@dotbot/game/types").GameSnapshot,
      ): void;
      consumeInputFrame(member: {
        botId: string;
        lastKillCam: import("@dotbot/protocol").KillCamClip | null;
        activeKillCamId: string | null;
        inputQueue: import("@dotbot/protocol").WireInputFrame[];
        inputStarved: boolean;
      }): import("@dotbot/game/types").InputCommand;
    };
    const victimMember = internals.members.get("killcam-player-victim")!;
    const rivalMember = internals.members.get("killcam-player-rival")!;
    const victimBot = internals.simulation.bots.get(victimMember.botId)!;
    const rivalBot = internals.simulation.bots.get(rivalMember.botId)!;
    victimBot.position = { x: 500, y: 500 };
    rivalBot.position = { x: 560, y: 500 };
    victimBot.floorId = "outdoor";
    rivalBot.floorId = "outdoor";

    const before = structuredClone(internals.simulation.getSnapshot());
    before.debug.tickCount = 120;
    internals.killCamHistory.record(before);
    victimBot.state = "downed";
    victimBot.shields = 0;
    victimBot.shieldSegments = victimBot.shieldSegments.map(() => 0);
    const death = structuredClone(internals.simulation.getSnapshot());
    death.debug.tickCount = 123;
    internals.killCamHistory.record(death);
    internals.processKillCamEvents([{
      type: "downed",
      botId: victimMember.botId,
      byBotId: rivalMember.botId,
      cause: {
        kind: "dash",
        tick: 123,
        position: { x: 524, y: 500 },
        direction: { x: -1, y: 0 },
      },
    }], death);

    const first = victim.messages.filter((message) => message.type === "killCam");
    expect(first).toHaveLength(1);
    expect(fromWireKillCamClip(first[0].clip)).toMatchObject({
      id: `${victimMember.botId}-123`,
      victimId: victimMember.botId,
      sourceBotId: rivalMember.botId,
    });
    expect(rival.messages.some((message) => message.type === "killCam")).toBe(false);
    expect(victimMember.activeKillCamId).toBe(`${victimMember.botId}-123`);

    victimMember.inputStarved = false;
    victimMember.inputQueue = [{
      seq: 44,
      move: [1, 0],
      dash: true,
      useBay: 0,
      plea: true,
      drop: { from: "hold", index: 0, revision: 4, expected: { kind: "mine" } },
    }];
    expect(internals.consumeInputFrame(victimMember)).toEqual({
      move: { x: 0, y: 0 },
      dash: false,
      plea: true,
    });

    room.disconnect(victim.peer.id);
    const refreshed = collectingPeer("killcam-victim-refreshed");
    expect(room.join(
      refreshed.peer,
      "killcam-token-victim",
      "Victim",
      "killcam-player-victim",
      "alpha",
    )).not.toBeNull();
    expect(refreshed.messages.filter((message) => message.type === "killCam")).toHaveLength(1);
    room.receive("killcam-player-victim", {
      type: "killCamDone",
      clipId: `${victimMember.botId}-stale`,
    });
    expect(victimMember.activeKillCamId).toBe(`${victimMember.botId}-123`);
    room.receive("killcam-player-victim", {
      type: "killCamDone",
      clipId: `${victimMember.botId}-123`,
    });
    expect(victimMember.activeKillCamId).toBeNull();

    internals.processKillCamEvents([{
      type: "revived",
      botId: victimMember.botId,
      byBotId: rivalMember.botId,
    }], death);
    expect(victimMember.lastKillCam).toBeNull();

    const secondDeath = structuredClone(death);
    secondDeath.debug.tickCount = 126;
    internals.killCamHistory.record(secondDeath);
    internals.processKillCamEvents([{
      type: "downed",
      botId: victimMember.botId,
      byBotId: rivalMember.botId,
      cause: {
        kind: "ram",
        tick: 126,
        position: { x: 524, y: 500 },
        direction: { x: -1, y: 0 },
      },
    }], secondDeath);
    const repeatedWire = refreshed.messages.filter((message) => message.type === "killCam").at(-1)?.clip;
    expect(repeatedWire && fromWireKillCamClip(repeatedWire))
      .toMatchObject({ id: `${victimMember.botId}-126`, cause: { kind: "ram" } });
    room.dispose();
  });
});

describe("Room input stream", () => {
  it("treats every one-shot edge as an action the jitter buffer must not shed", () => {
    // Shedding picks the first frame that carries no press. That rule lived twice,
    // written out field by field, so a new action had to be remembered in two
    // places — and one of them would eventually be forgotten. It is one function
    // now, and this pins each edge it has to know about.
    const move = { seq: 1, move: [1, 0] as [number, number], dash: false };
    expect(carriesAction(move)).toBe(false);
    expect(carriesAction({ ...move, dash: true })).toBe(true);
    expect(carriesAction({ ...move, useBay: 0 })).toBe(true);
    expect(carriesAction({ ...move, swapBay: { bayIndex: 0, holdIndex: 0 } })).toBe(true);
    expect(carriesAction({
      ...move,
      drop: { from: "bay", index: 0, revision: 0, expected: { kind: "mine" } },
    })).toBe(true);
    expect(carriesAction({ ...move, take: { fromBotId: "enemy", index: "all" } })).toBe(true);
    expect(carriesAction({ ...move, plea: true })).toBe(true);
    // A verb is standing state, not an edge: it repeats every frame while a key is
    // held, so shedding one costs nothing — which is why `ActionEdges` does not
    // name it, and why passing it here would not typecheck.
    expect(carriesAction({ ...move })).toBe(false);
  });

  it("derives a dropped pickup from server state and includes it in a reconnect baseline", async () => {
    let clock = 0;
    const room = new Room("DROP", {
      countdownMs: 0,
      persistence: new NoopPersistence(),
      aiWingmates: false,
      now: () => clock,
    });
    const first = collectingPeer("drop-first");
    room.join(first.peer, "drop-token", "Dropper", "drop-player", "alpha");
    room.receive("drop-player", { type: "startMatch" });
    await waitFor(() => room.phase === "live");
    const internals = room as unknown as {
      members: Map<string, { botId: string }>;
      simulation: {
        bots: Map<string, {
          position: { x: number; y: number };
          bays: unknown[];
          inventoryRevision: number;
        }>;
        dots: Map<string, unknown>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
    };
    const member = internals.members.get("drop-player")!;
    const authoritative = internals.simulation.bots.get(member.botId)!;
    const cargo = { kind: "powerup", type: "health", sourceBuildingId: "mercy" } as const;
    authoritative.bays[0] = cargo;
    const at = { ...authoritative.position };

    room.receive("drop-player", {
      type: "input",
      seq: 1,
      move: [0, 0],
      dash: false,
      drop: {
        from: "bay",
        index: 0,
        revision: 0,
        expected: cargo,
        item: { kind: "mine" },
        position: [9999, 9999],
        floorId: "forged",
      },
      frames: [
        {
          seq: 1,
          move: [0, 0],
          dash: false,
          drop: {
            from: "bay",
            index: 0,
            revision: 0,
            expected: cargo,
            item: { kind: "mine" },
            position: [9999, 9999],
            floorId: "forged",
          },
        },
        { seq: 2, move: [0, 0], dash: false },
      ],
    } as never);
    clock += 1000 / 60 + 0.01;
    room.tick(clock);
    clock += 1000 / 60 + 0.01;
    room.tick(clock);

    const dropped = internals.simulation.getSnapshot().dots.find((dot) => dot.id.startsWith("runtime-drop-"))!;
    expect(dropped).toMatchObject({
      position: at,
      floorId: "outdoor",
      item: cargo,
    });
    expect(authoritative.bays[0]).toBeNull();
    for (let tick = 0; tick < 5; tick += 1) {
      clock += 1000 / 60 + 0.01;
      room.tick(clock);
    }
    const runtimeFrames = first.messages
      .filter((message) => message.type === "snap")
      .filter((message) => message.runtimeDots?.some((dot) => dot.id === dropped.id));
    // Discard the first latest-state frame conceptually. The later frame must
    // independently carry the complete active runtime set.
    expect(runtimeFrames.length).toBeGreaterThanOrEqual(2);
    expect(runtimeFrames.at(-1)?.runtimeDots)
      .toContainEqual(expect.objectContaining({ id: dropped.id, it: "h", src: "mercy", rt: true }));

    room.disconnect(first.peer.id);
    const reconnected = collectingPeer("drop-reconnected");
    expect(room.join(reconnected.peer, "drop-token", "Dropper", "drop-player", "alpha")).not.toBeNull();
    const start = reconnected.messages.find((message) => message.type === "matchStart");
    expect(start?.dotBaseline).toContainEqual(expect.objectContaining({
      id: dropped.id,
      position: at,
      it: "h",
      src: "mercy",
      active: true,
    }));

    // Retired runtime definitions are physically collected and therefore
    // cannot accumulate in a reconnect baseline forever.
    internals.simulation.dots.delete(dropped.id);
    room.disconnect(reconnected.peer.id);
    const afterGc = collectingPeer("drop-after-gc");
    expect(room.join(afterGc.peer, "drop-token", "Dropper", "drop-player", "alpha")).not.toBeNull();
    expect(afterGc.messages.find((message) => message.type === "matchStart")?.dotBaseline)
      .not.toContainEqual(expect.objectContaining({ id: dropped.id }));
    room.dispose();
  });

  it("reconnects to current private effect timers, radar contacts, and owned mines", async () => {
    const room = new Room("POWR", {
      countdownMs: 0,
      persistence: new NoopPersistence(),
      aiWingmates: false,
    });
    const original = collectingPeer("power-original");
    room.join(original.peer, "power-token", "Powered", "power-player", "alpha");
    room.receive("power-player", { type: "startMatch" });
    await waitFor(() => room.phase === "live");

    const internals = room as unknown as {
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
      broadcastSnapshot(snapshot: import("@dotbot/game/types").GameSnapshot): void;
    };
    const member = internals.members.get("power-player")!;
    const bot = internals.simulation.bots.get(member.botId)!;
    bot.radarActiveMs = 5_000;
    bot.radarPings = [{ botId: "known-rival", floorId: bot.floorId, ...bot.position, ageMs: 250 }];
    bot.dashOverchargeMs = 43_000;
    bot.incognitoMs = 6_000;
    internals.simulation.mines.set("mine-reconnect", {
      id: "mine-reconnect",
      position: { ...bot.position },
      radius: 10,
      placedByBotId: bot.id,
      squadId: bot.squadId,
      floorId: bot.floorId,
      placedAtMs: 10,
      revealedToBotIds: [],
      armedAtTick: 1,
      sensorElapsedMs: 0,
      revealMsByBotId: new Map(),
    });

    room.disconnect(original.peer.id);
    const reconnected = collectingPeer("power-reconnected");
    expect(room.join(reconnected.peer, "power-token", "Powered", "power-player", "alpha")).not.toBeNull();
    internals.broadcastSnapshot(internals.simulation.getSnapshot());

    const snap = reconnected.messages.filter((message) => message.type === "snap").at(-1);
    const own = snap?.bots.find((entry) => entry.i === member.botId);
    expect(own).toMatchObject({
      r: [5_000, [["known-rival", bot.position.x, bot.position.y, bot.floorId, 250]]],
      o: 43_000,
      ic: 6_000,
    });
    expect(snap?.mines).toContainEqual(expect.objectContaining({
      id: "mine-reconnect",
      placedByBotId: bot.id,
      squadId: "alpha",
      presentation: "squad",
    }));
    room.dispose();
  });

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
    const streamedSnapshot = peer.sent.find(({ message }) => message.type === "snap");
    expect(streamedSnapshot?.encoded).toBe(JSON.stringify(streamedSnapshot?.message));

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

    // A browser refresh creates a brand-new client input stream beginning at
    // seq 1. Rejoining during the handoff window must reset the old ack or the
    // server will discard the refreshed player's movement for many seconds.
    room.disconnect(peer.peer.id);
    const refreshed = collectingPeer("stream-peer-refreshed");
    expect(room.join(refreshed.peer, "stream-token", "Streamer", "stream-player", "alpha")).toBe(member);
    expect(member.lastAppliedSeq).toBe(0);
    room.receive("stream-player", {
      type: "input", seq: 2, move: [1, 0], dash: false,
      frames: [
        { seq: 1, move: [1, 0], dash: false },
        { seq: 2, move: [1, 0], dash: false },
      ],
    });
    step();
    expect(member.lastAppliedSeq).toBe(1);
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
    let extractionAttempts = 0;
    class FailingPersistence extends NoopPersistence {
      override readonly live = true;
      override async recordExtraction(input: Parameters<NoopPersistence["recordExtraction"]>[0]) {
        extractionAttempts += 1;
        if (extractionAttempts === 1) throw new Error("relay unavailable");
        return super.recordExtraction(input);
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
    expect(extractionAttempts).toBe(2);
    room.dispose();
  });
});

function collectingPeer(id: string): {
  peer: RoomPeer;
  messages: ServerMessage[];
  sent: Array<{ message: ServerMessage; encoded?: string }>;
} {
  const messages: ServerMessage[] = [];
  const sent: Array<{ message: ServerMessage; encoded?: string }> = [];
  return {
    peer: {
      id,
      send: (message, _delivery, encoded) => {
        messages.push(message);
        sent.push({ message, encoded });
      },
    },
    messages,
    sent,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Room state");
}
