import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@dotbot/protocol";
import { completedBaseTutorialState, initialBaseTutorialState } from "@dotbot/game/baseTutorial";
import { NoopPersistence } from "./db";
import type { RoomPeer } from "./Room";
import { matchesReservedPlayerIdentity, RoomManager } from "./RoomManager";

class TutorialPersistence extends NoopPersistence {
  override readonly live = true;

  constructor(private complete: boolean) {
    super();
  }

  override async getBaseTutorialForPlayer() {
    return this.complete ? completedBaseTutorialState : initialBaseTutorialState;
  }
}

const peer = (messages: ServerMessage[]): RoomPeer => ({
  id: "peer-1",
  send(message) {
    messages.push(message);
  },
});

describe("RoomManager tutorial admission", () => {
  it("starts a bounded idle clock for an assigned GameLift arena even if no player opens a socket", async () => {
    let now = 0;
    const expired = vi.fn();
    const manager = new RoomManager({
      now: () => now,
      persistence: new TutorialPersistence(true),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
      sessionRoomCode: async () => "IDLE",
      onRoomExpired: expired,
    });

    (manager as unknown as { tick(): void }).tick();
    await vi.waitFor(() => expect(manager.rooms).toBe(1));
    now = 10 * 60_000;
    (manager as unknown as { tick(): void }).tick();
    await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    expect(manager.rooms).toBe(0);

    now += 1_000;
    (manager as unknown as { tick(): void }).tick();
    expect(manager.rooms).toBe(0);
    expect(expired).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("fails closed instead of admitting a stateless Noop identity", async () => {
    const messages: ServerMessage[] = [];
    const manager = new RoomManager({ persistence: new NoopPersistence() });

    expect(await manager.handleHello(peer(messages), {
      type: "hello",
      token: "offline-token-1234",
      name: "Offline player",
      roomCode: "",
    })).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({
      type: "err",
      code: "storage_unavailable",
    }));
    expect(manager.rooms).toBe(0);
  });

  it("rejects direct deployment attempts until the account has completed its base introduction", async () => {
    const messages: ServerMessage[] = [];
    const manager = new RoomManager({ persistence: new TutorialPersistence(false) });

    expect(await manager.handleHello(peer(messages), {
      type: "hello",
      token: "tutorial-token-1234",
      name: "New player",
      roomCode: "",
    })).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({
      type: "err",
      code: "tutorial_required",
    }));
    expect(manager.rooms).toBe(0);
  });

  it("admits a completed account and preserves reconnect-compatible authority", async () => {
    const messages: ServerMessage[] = [];
    const manager = new RoomManager({ persistence: new TutorialPersistence(true) });

    expect(await manager.handleHello(peer(messages), {
      type: "hello",
      token: "returning-token-1234",
      name: "Returning player",
      roomCode: "",
    })).toBe(true);
    expect(manager.rooms).toBe(1);
    await manager.stop();
  });

  it("accepts a GameLift reservation issued to a trusted retired identity alias", async () => {
    class AliasPersistence extends TutorialPersistence {
      override async resolveOrRegisterPlayer(_token: string, offeredName: string) {
        return { playerId: "canonical-player", name: offeredName, previousPlayerIds: ["reserved-guest"] };
      }
    }
    const messages: ServerMessage[] = [];
    const manager = new RoomManager({
      persistence: new AliasPersistence(true),
      hotArena: { assemblyMinMs: 1_000, assemblyMaxMs: 1_000 },
    });

    expect(matchesReservedPlayerIdentity({
      playerId: "canonical-player",
      name: "Linked player",
      previousPlayerIds: ["reserved-guest"],
    }, "reserved-guest")).toBe(true);
    expect(await manager.handleQuickPlayHello(peer(messages), {
      type: "quickPlayHello",
      token: "linked-device-token",
      name: "Linked player",
      playerSessionId: "psess-1",
    }, {
      playerId: "reserved-guest",
      arenaId: "ALIA",
      partyId: "solo-reserved-guest",
      buildId: "web-42",
      region: "ca-central-1",
    })).toBe(true);
    expect(manager.join("ALIA")?.publicArenaMembers).toEqual([{
      playerId: "canonical-player",
      name: "Linked player",
      partyId: "solo-reserved-guest",
      queued: true,
    }]);
    await manager.stop();
  });

  it("rejects a reservation id absent from the canonical identity and its trusted aliases", () => {
    expect(matchesReservedPlayerIdentity({
      playerId: "canonical-player",
      name: "Linked player",
      previousPlayerIds: ["retired-guest"],
    }, "spoofed-player")).toBe(false);
  });
});
