import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@dotbot/protocol";
import { completedBaseTutorialState, initialBaseTutorialState } from "@dotbot/game/baseTutorial";
import { NoopPersistence } from "./db";
import type { RoomPeer } from "./Room";
import { RoomManager } from "./RoomManager";

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
});
