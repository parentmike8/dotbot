import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@dotbot/protocol";
import { NoopPersistence } from "./db";
import { Room, type RoomPeer } from "./Room";

describe("Room GIVE UP", () => {
  it("returns a died manifest for a downed member while their squadmate keeps playing", async () => {
    const room = new Room("GIVE", { countdownMs: 0, persistence: new NoopPersistence() });
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
