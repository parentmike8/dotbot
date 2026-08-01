import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@dotbot/protocol";
import { completedBaseTutorialState } from "@dotbot/game/baseTutorial";
import { NoopPersistence, type Persistence, type PlayerIdentity } from "./db";
import { Room, type RoomPeer } from "./Room";
import { matchesReservedPlayerIdentity, RoomManager } from "./RoomManager";

class IntegratedPersistence extends NoopPersistence {
  override readonly live = true;
  readonly starts: Array<Parameters<Persistence["startMatch"]>[0]> = [];
  readonly outcomes: Array<Parameters<Persistence["recordOutcome"]>[0]> = [];
  readonly finishes: Array<Parameters<Persistence["finishMatch"]>[0]> = [];

  constructor(private readonly identityForToken: (token: string, name: string) => PlayerIdentity | Promise<PlayerIdentity>) {
    super();
  }

  override async resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity> {
    return await this.identityForToken(token, offeredName);
  }

  override async getBaseTutorialForPlayer() {
    return { ...completedBaseTutorialState };
  }

  override async startMatch(input: Parameters<Persistence["startMatch"]>[0]) {
    this.starts.push({ ...input, playerIds: [...input.playerIds] });
    return { loadouts: Object.fromEntries(input.playerIds.map((playerId) => [playerId, []])) };
  }

  override async recordOutcome(input: Parameters<Persistence["recordOutcome"]>[0]): Promise<void> {
    this.outcomes.push({ ...input });
  }

  override async finishMatch(input: Parameters<Persistence["finishMatch"]>[0]): Promise<void> {
    this.finishes.push(structuredClone(input));
  }
}

describe("hot arena and identity integration", () => {
  it("admits a guest reservation after that guest merges before WebSocket identity resolution", async () => {
    const retiredGuestId = "00000000-0000-4000-8000-000000000001";
    const canonicalPlayerId = "00000000-0000-4000-8000-000000000002";
    let merged = false;
    const persistence = new IntegratedPersistence((_token, name) => merged
      ? {
          playerId: canonicalPlayerId,
          previousPlayerIds: [retiredGuestId],
          publicPlayerId: "WXYZ2345",
          previousPublicPlayerIds: ["ABCDEFGH"],
          name,
        }
      : { playerId: retiredGuestId, publicPlayerId: "ABCDEFGH", name });
    const manager = new RoomManager({
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    const admission = {
      playerId: retiredGuestId,
      arenaId: "ALIA",
      partyId: "party-opaque",
      buildId: "web-42",
      region: "ca-central-1",
    };

    // Allocation captured the guest UUID. Linking wins before the socket opens.
    merged = true;
    const messages: ServerMessage[] = [];
    expect(await manager.handleQuickPlayHello(testPeer("merged-peer", messages), {
      type: "quickPlayHello",
      token: "merged-device-token",
      name: "Merged player",
      playerSessionId: "psess-merged",
    }, admission)).toBe(true);

    const room = manager.join("ALIA")!;
    expect(room.publicArenaMembers).toEqual([{
      playerId: "WXYZ-2345",
      name: "Merged player",
      partyId: "party-opaque",
      queued: true,
    }]);
    const member = (room as unknown as {
      members: Map<string, { persistencePlayerId: string; publicReservationPlayerId: string | null }>;
    }).members.get("WXYZ-2345");
    expect(member).toMatchObject({
      persistencePlayerId: canonicalPlayerId,
      publicReservationPlayerId: retiredGuestId,
    });
    expect(JSON.stringify(messages)).not.toContain(canonicalPlayerId);
    expect(JSON.stringify(messages)).not.toContain(retiredGuestId);
    await manager.stop();
  });

  it("rejects a second device for the same linked account without adding a second arena member", async () => {
    const retiredGuestId = "00000000-0000-4000-8000-000000000009";
    const canonicalPlayerId = "00000000-0000-4000-8000-000000000010";
    const persistence = new IntegratedPersistence((token, name) => token === "linked-device-one"
      ? { playerId: retiredGuestId, publicPlayerId: "GUES2345", name }
      : {
          playerId: canonicalPlayerId,
          previousPlayerIds: [retiredGuestId],
          publicPlayerId: "STUV2345",
          name,
        });
    const manager = new RoomManager({
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    const admission = {
      playerId: retiredGuestId,
      arenaId: "SAME",
      partyId: "party-one",
      buildId: "web-42",
      region: "ca-central-1",
    };
    const firstMessages: ServerMessage[] = [];
    const secondMessages: ServerMessage[] = [];

    expect(await manager.handleQuickPlayHello(testPeer("device-one", firstMessages), {
      type: "quickPlayHello",
      token: "linked-device-one",
      name: "Linked player",
      playerSessionId: "psess-one",
    }, admission)).toBe(true);
    expect(await manager.handleQuickPlayHello(testPeer("device-two", secondMessages), {
      type: "quickPlayHello",
      token: "linked-device-two",
      name: "Linked player",
      playerSessionId: "psess-two",
    }, { ...admission, playerId: canonicalPlayerId, partyId: "party-two" })).toBe(false);

    expect(manager.join("SAME")?.publicArenaMembers).toHaveLength(1);
    expect(secondMessages).toContainEqual(expect.objectContaining({ type: "err", code: "party_invalid" }));
    expect(JSON.stringify([...firstMessages, ...secondMessages])).not.toContain(canonicalPlayerId);
    expect(JSON.stringify([...firstMessages, ...secondMessages])).not.toContain(retiredGuestId);
    await manager.stop();
  });

  it("refreshes canonical identity after an account merges during admission awaits", async () => {
    const retiredGuestId = "00000000-0000-4000-8000-000000000019";
    const canonicalPlayerId = "00000000-0000-4000-8000-000000000020";
    let merged = false;
    let tutorialLookups = 0;
    let releaseTutorials!: () => void;
    const tutorialGate = new Promise<void>((resolve) => { releaseTutorials = resolve; });
    class MergeDuringAdmissionPersistence extends IntegratedPersistence {
      override async getBaseTutorialForPlayer() {
        tutorialLookups += 1;
        await tutorialGate;
        return { ...completedBaseTutorialState };
      }
    }
    const persistence = new MergeDuringAdmissionPersistence((token, name) => {
      if (!merged && token === "source-device") return { playerId: retiredGuestId, publicPlayerId: "GUES2345", name };
      return {
        playerId: canonicalPlayerId,
        previousPlayerIds: [retiredGuestId],
        publicPlayerId: "LINK2345",
        previousPublicPlayerIds: ["GUES2345"],
        name,
      };
    });
    const manager = new RoomManager({
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    const sourceMessages: ServerMessage[] = [];
    const targetMessages: ServerMessage[] = [];
    const source = manager.handleQuickPlayHello(testPeer("source-peer", sourceMessages), {
      type: "quickPlayHello",
      token: "source-device",
      name: "Source",
      playerSessionId: "psess-source",
    }, {
      playerId: retiredGuestId,
      arenaId: "RACE",
      partyId: "party-source",
      buildId: "web-42",
      region: "ca-central-1",
    });
    const target = manager.handleQuickPlayHello(testPeer("target-peer", targetMessages), {
      type: "quickPlayHello",
      token: "target-device",
      name: "Target",
      playerSessionId: "psess-target",
    }, {
      playerId: canonicalPlayerId,
      arenaId: "RACE",
      partyId: "party-target",
      buildId: "web-42",
      region: "ca-central-1",
    });
    await vi.waitFor(() => expect(tutorialLookups).toBe(2));
    merged = true;
    releaseTutorials();

    const admitted = await Promise.all([source, target]);
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(manager.join("RACE")?.publicArenaMembers).toEqual([
      expect.objectContaining({ playerId: "LINK-2345" }),
    ]);
    expect(`${JSON.stringify(sourceMessages)}${JSON.stringify(targetMessages)}`).not.toContain(canonicalPlayerId);
    expect(`${JSON.stringify(sourceMessages)}${JSON.stringify(targetMessages)}`).not.toContain(retiredGuestId);
    await manager.stop();
  });

  it("accepts only canonical or trusted retired reservation aliases", () => {
    const identity: PlayerIdentity = {
      playerId: "00000000-0000-4000-8000-000000000020",
      previousPlayerIds: ["00000000-0000-4000-8000-000000000019"],
      publicPlayerId: "WXYZ2345",
      previousPublicPlayerIds: ["ABCDEFGH"],
      name: "Alias player",
    };

    expect(matchesReservedPlayerIdentity(identity, identity.playerId)).toBe(true);
    expect(matchesReservedPlayerIdentity(identity, identity.previousPlayerIds![0])).toBe(true);
    expect(matchesReservedPlayerIdentity(identity, "WXYZ-2345")).toBe(true);
    expect(matchesReservedPlayerIdentity(identity, "ABCD-EFGH")).toBe(true);
    expect(matchesReservedPlayerIdentity(identity, "   ")).toBe(false);
    expect(matchesReservedPlayerIdentity(identity, "00000000-0000-4000-8000-000000000021")).toBe(false);
  });

  it("keeps the no-reservation solo party fallback opaque on public arena messages", async () => {
    const canonicalPlayerId = "00000000-0000-4000-8000-000000000025";
    const persistence = new IntegratedPersistence((_token, name) => ({
      playerId: canonicalPlayerId,
      publicPlayerId: "SOLO2345",
      name,
    }));
    const manager = new RoomManager({
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    const messages: ServerMessage[] = [];

    expect(await manager.handleQuickPlayHello(testPeer("solo-peer", messages), {
      type: "quickPlayHello",
      token: "solo-device-token",
      name: "Solo player",
      playerSessionId: "psess-solo",
    })).toBe(true);

    expect(manager.join("PUB1")?.publicArenaMembers).toEqual([
      expect.objectContaining({ playerId: "SOLO-2345", partyId: expect.stringMatching(/^solo-[a-f0-9]{24}$/) }),
    ]);
    expect(JSON.stringify({ messages, members: manager.join("PUB1")?.publicArenaMembers })).not.toContain(canonicalPlayerId);
    await manager.stop();
  });

  it("does not ghost-admit a socket that closes while canonical identity is resolving", async () => {
    let releaseIdentity!: () => void;
    const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    let identityLookupStarted!: () => void;
    const identityStarted = new Promise<void>((resolve) => { identityLookupStarted = resolve; });
    const persistence = new IntegratedPersistence(asyncIdentity);
    let open = true;
    const messages: ServerMessage[] = [];
    const manager = new RoomManager({
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });
    const admission = manager.handleQuickPlayHello(testPeer("closing-peer", messages, () => open), {
      type: "quickPlayHello",
      token: "closing-device-token",
      name: "Closing player",
      playerSessionId: "psess-closing",
    }, {
      playerId: "00000000-0000-4000-8000-000000000030",
      arenaId: "CLOS",
      partyId: "party-closing",
      buildId: "web-42",
      region: "ca-central-1",
    });
    await identityStarted;
    open = false;
    releaseIdentity();

    await expect(admission).resolves.toBe(false);
    expect(manager.rooms).toBe(0);
    expect(messages).toEqual([]);
    await manager.stop();

    async function asyncIdentity(_token: string, name: string): Promise<PlayerIdentity> {
      identityLookupStarted();
      await identityGate;
      return {
        playerId: "00000000-0000-4000-8000-000000000030",
        publicPlayerId: "CLOS2345",
        name,
      };
    }
  });

  it("rejects an unpackable full-party preflight without mutating arena membership", () => {
    const room = new Room("PACK", {
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 6_000 },
      persistence: new NoopPersistence(),
    });
    for (let party = 0; party < 6; party += 1) {
      for (let member = 0; member < 2; member += 1) {
        const playerId = `P${party}${member}A-BCDE`;
        expect(room.join(
          testPeer(`peer-${party}-${member}`, []),
          `token-${party}-${member}`,
          `Player ${party}-${member}`,
          playerId,
          undefined,
          `party-${party}`,
        )).not.toBeNull();
      }
    }
    const before = structuredClone(room.publicArenaMembers);

    expect(room.evaluatePublicPartyAdmission([
      { playerId: "NEXT-AAA1", name: "Next one", partyId: "party-next" },
      { playerId: "NEXT-AAA2", name: "Next two", partyId: "party-next" },
    ])).toEqual({ accepted: false, code: "party_composition_full", retryable: true });
    expect(room.publicArenaMembers).toEqual(before);
    expect(room.size).toBe(12);
    room.dispose();
  });

  it("uses public runtime ids for hot-run mine events and channels while persistence keeps the canonical id", async () => {
    let now = 0;
    const canonicalPlayerId = "00000000-0000-4000-8000-000000000026";
    const retiredReservationId = "00000000-0000-4000-8000-000000000025";
    const publicPlayerId = "MINE-2345";
    const persistence = new IntegratedPersistence((_token, name) => ({
      playerId: canonicalPlayerId,
      previousPlayerIds: [retiredReservationId],
      publicPlayerId: publicPlayerId.replace("-", ""),
      name,
    }));
    const messages: ServerMessage[] = [];
    const room = new Room("EVNT", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      matchIdFactory: () => "00000000-0000-4000-8000-000000000126",
    });
    expect(room.join(
      testPeer("event-peer", messages),
      "event-token",
      "Event player",
      publicPlayerId,
      undefined,
      "event-party",
      undefined,
      retiredReservationId,
      canonicalPlayerId,
    )).not.toBeNull();
    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));

    const internals = room as unknown as {
      members: Map<string, { botId: string; squadId: string }>;
      simulation: {
        coverages: Map<string, import("@dotbot/game/types").CoverageSnapshot>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
      broadcastSnapshot(snapshot: import("@dotbot/game/types").GameSnapshot): void;
      broadcastEvents(
        events: import("@dotbot/game/types").SimEvent[],
        snapshot: import("@dotbot/game/types").GameSnapshot,
      ): void;
    };
    const member = internals.members.get(publicPlayerId)!;
    expect(member.botId).toBe(`human-${publicPlayerId}`);
    expect(persistence.starts[0].playerIds).toEqual([canonicalPlayerId]);
    internals.simulation.coverages.set("capture:runtime-dot", {
      kind: "capture",
      actorId: member.botId,
      targetId: "runtime-dot",
      progressMs: 500,
      durationMs: 1_000,
    });

    messages.length = 0;
    const snapshot = internals.simulation.getSnapshot();
    internals.broadcastSnapshot(snapshot);
    const opaqueMineId = "mine-b8132f69-3f0d-46ef-9ae1-61c917841882";
    internals.broadcastEvents([{
      type: "mineSensor",
      botId: member.botId,
      squadId: member.squadId,
      mineId: opaqueMineId,
      position: { ...snapshot.bots.find((bot) => bot.id === member.botId)!.position },
      floorId: snapshot.bots.find((bot) => bot.id === member.botId)!.floorId,
    }], snapshot);

    expect(messages.find((message) => message.type === "snap")?.coverages).toContainEqual({
      kind: "capture",
      actorId: member.botId,
      targetId: "runtime-dot",
      progressMs: 500,
      durationMs: 1_000,
    });
    expect(messages.find((message) => message.type === "ev")?.events).toContainEqual(expect.objectContaining({
      type: "mineSensor",
      botId: member.botId,
      mineId: opaqueMineId,
    }));
    const encoded = JSON.stringify(messages);
    expect(encoded).toContain(member.botId);
    expect(encoded).not.toContain(canonicalPlayerId);
    expect(encoded).not.toContain(retiredReservationId);
    room.dispose();
  });

  it("starts and settles an 18-human run with canonical UUIDs and aggregate-only finish data", async () => {
    let now = 0;
    const persistence = new IntegratedPersistence((_token, name) => ({
      playerId: "unused",
      publicPlayerId: "UNUS2345",
      name,
    }));
    const room = new Room("FULL", {
      now: () => now,
      persistence,
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      connectionHandoffMs: 0,
      matchIdFactory: () => "00000000-0000-4000-8000-000000000999",
    });
    const canonicalPlayerIds: string[] = [];
    const publicPlayerIds: string[] = [];
    const peers: RoomPeer[] = [];
    for (let index = 0; index < 18; index += 1) {
      const canonicalPlayerId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const publicPlayerId = displayPublicId(index);
      const peer = testPeer(`full-peer-${index}`, []);
      canonicalPlayerIds.push(canonicalPlayerId);
      publicPlayerIds.push(publicPlayerId);
      peers.push(peer);
      expect(room.join(
        peer,
        `full-token-${index}`,
        `Player ${index}`,
        publicPlayerId,
        undefined,
        `solo-${index}`,
        undefined,
        `reservation-${index}`,
        canonicalPlayerId,
      )).not.toBeNull();
    }

    now = 1_000;
    room.tick(now);
    await vi.waitFor(() => expect(room.phase).toBe("live"));
    expect(persistence.starts).toHaveLength(1);
    expect(new Set(persistence.starts[0].playerIds)).toEqual(new Set(canonicalPlayerIds));

    for (const peer of peers) room.disconnect(peer.id);
    await vi.waitFor(() => expect(persistence.outcomes).toHaveLength(18));
    (room as unknown as { end(reason: string): void }).end("all_humans_disconnected");
    await vi.waitFor(() => expect(persistence.finishes).toHaveLength(1));
    await room.waitForPersistence();

    expect(new Set(persistence.outcomes.map((outcome) => outcome.playerId))).toEqual(new Set(canonicalPlayerIds));
    expect(persistence.finishes[0].summary).toEqual({
      reason: "all_humans_disconnected",
      participantCount: 18,
      outcomes: { disconnected: 18 },
    });
    const serializedFinish = JSON.stringify(persistence.finishes[0]);
    for (const playerId of [...canonicalPlayerIds, ...publicPlayerIds]) {
      expect(serializedFinish).not.toContain(playerId);
    }
    room.dispose();
  });

  it("keeps the legacy room-code path active and public quick play unavailable when the feature is off", async () => {
    const canonicalPlayerId = "00000000-0000-4000-8000-000000000040";
    const persistence = new IntegratedPersistence((_token, name) => ({
      playerId: canonicalPlayerId,
      publicPlayerId: "ROLL2345",
      name,
    }));
    const manager = new RoomManager({ persistence, countdownMs: 0 });
    const legacyMessages: ServerMessage[] = [];

    expect(await manager.handleHello(testPeer("legacy-peer", legacyMessages), {
      type: "hello",
      token: "legacy-device-token",
      name: "Legacy player",
      roomCode: "",
    })).toBe(true);
    const legacyWelcome = legacyMessages.find((message) => message.type === "welcome");
    expect(legacyWelcome).toMatchObject({
      type: "welcome",
      playerId: "ROLL-2345",
      roomCode: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}$/),
    });
    expect(JSON.stringify(legacyMessages)).not.toContain(canonicalPlayerId);

    const legacyRoom = manager.join(legacyWelcome!.roomCode)!;
    legacyRoom.receive("ROLL-2345", { type: "startMatch" });
    await vi.waitFor(() => expect(legacyRoom.phase).toBe("live"));
    const legacyStart = legacyMessages.find((message) => message.type === "matchStart");
    expect(legacyStart?.matchId).toBeUndefined();
    expect(legacyStart?.roles).toBeUndefined();
    const legacyInternals = legacyRoom as unknown as {
      members: Map<string, { botId: string }>;
      simulation: {
        bots: Map<string, {
          id: string;
          squadId: string;
          floorId: string;
          position: { x: number; y: number };
          radarActiveMs: number;
          radarPings: unknown[];
          dashOverchargeMs: number;
          incognitoMs: number;
        }>;
        mines: Map<string, unknown>;
        getSnapshot(): import("@dotbot/game/types").GameSnapshot;
      };
      broadcastSnapshot(snapshot: import("@dotbot/game/types").GameSnapshot): void;
    };
    const legacyMember = legacyInternals.members.get("ROLL-2345")!;
    const legacyBot = legacyInternals.simulation.bots.get(legacyMember.botId)!;
    legacyBot.radarActiveMs = 4_000;
    legacyBot.dashOverchargeMs = 45_000;
    legacyBot.incognitoMs = 5_000;
    const legacyMineId = "mine-a4f82e4a-0fe8-4e0e-8506-bc74be48f19c";
    legacyInternals.simulation.mines.set(legacyMineId, {
      id: legacyMineId,
      position: { ...legacyBot.position },
      radius: 10,
      placedByBotId: legacyBot.id,
      squadId: legacyBot.squadId,
      floorId: legacyBot.floorId,
      placedAtMs: 400,
      revealedToBotIds: [],
      armedAtTick: Number.MAX_SAFE_INTEGER,
      sensorElapsedMs: 0,
      revealMsByBotId: new Map(),
    });
    legacyMessages.length = 0;
    legacyInternals.broadcastSnapshot(legacyInternals.simulation.getSnapshot());
    const legacySnapshot = legacyMessages.find((message) => message.type === "snap");
    expect(legacySnapshot?.bots.find((bot) => bot.i === legacyBot.id)).toMatchObject({
      r: [4_000],
      o: 45_000,
      ic: 5_000,
    });
    expect(legacySnapshot?.mines).toContainEqual(expect.objectContaining({
      id: legacyMineId,
      presentation: "squad",
      placedByBotId: legacyBot.id,
    }));
    expect(JSON.stringify(legacyMessages)).not.toContain(canonicalPlayerId);

    const publicMessages: ServerMessage[] = [];
    expect(await manager.handleQuickPlayHello(testPeer("public-peer", publicMessages), {
      type: "quickPlayHello",
      token: "public-device-token",
      name: "Public player",
      playerSessionId: "psess-disabled",
    })).toBe(false);
    expect(publicMessages).toContainEqual(expect.objectContaining({ type: "err", code: "quick_play_unavailable" }));
    expect(manager.rooms).toBe(1);
    await manager.stop();
  });
});

function testPeer(
  id: string,
  messages: ServerMessage[],
  isOpen: () => boolean = () => true,
): RoomPeer {
  return {
    id,
    isOpen,
    send(message) {
      messages.push(message);
    },
  };
}

function displayPublicId(index: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  let remaining = index + 1;
  for (let place = 0; place < 8; place += 1) {
    value = alphabet[remaining % alphabet.length] + value;
    remaining = Math.floor(remaining / alphabet.length);
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}
