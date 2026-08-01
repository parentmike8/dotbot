import { describe, expect, it, vi } from "vitest";
import { RemotePersistence } from "./db/RemotePersistence";

describe("RemotePersistence", () => {
  it("retries a transient relay failure twice before succeeding", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("first relay timeout"))
      .mockRejectedValueOnce(new Error("second relay timeout"))
      .mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify({ result: null })) });
    const destroy = vi.fn();
    const persistence = new RemotePersistence("matchmaker", { send, destroy } as never);

    await persistence.recordOutcome({
      matchId: "11111111-1111-4111-8111-111111111111",
      playerId: "22222222-2222-4222-8222-222222222222",
      outcome: "disconnected",
    });

    expect(send).toHaveBeenCalledTimes(3);
    for (const [command] of send.mock.calls) {
      const input = (command as { input: { Payload: Uint8Array } }).input;
      expect(JSON.parse(Buffer.from(input.Payload).toString("utf8"))).toEqual({
        source: "dotbot-game-server",
        operation: "recordOutcome",
        args: {
          matchId: "11111111-1111-4111-8111-111111111111",
          playerId: "22222222-2222-4222-8222-222222222222",
          outcome: "disconnected",
        },
      });
    }

    await persistence.close();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
