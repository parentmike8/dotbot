import { describe, expect, it, vi } from "vitest";
import { RemoteArenaDirectory } from "./ArenaDirectory";

describe("RemoteArenaDirectory", () => {
  it("publishes only the assigned arena through the IAM Lambda seam", async () => {
    const send = vi.fn(async (_command: unknown) => ({ Payload: Buffer.from(JSON.stringify({ result: { updated: true } })) }));
    const destroy = vi.fn();
    const gameLift = {
      publicSession: vi.fn(async () => ({ gameSessionId: "game-session-1", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" })),
    };
    const directory = new RemoteArenaDirectory("matchmaker", gameLift as never, { send, destroy } as never);

    await directory.publish({ arenaId: "A2BC", open: true, closesAt: 12_000 });
    const command = send.mock.calls[0][0] as { input: { Payload: Uint8Array } };
    expect(JSON.parse(Buffer.from(command.input.Payload).toString("utf8"))).toEqual({
      source: "dotbot-arena-server",
      operation: "setAdmission",
      args: {
        gameSessionId: "game-session-1",
        arenaId: "A2BC",
        buildId: "web-42",
        region: "ca-central-1",
        open: true,
        closesAt: 12_000,
        revision: 1,
      },
    });
    await expect(directory.publish({ arenaId: "B2CD", open: false })).rejects.toThrow(/mismatched arena/i);
    expect(send).toHaveBeenCalledTimes(1);
    directory.close();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
