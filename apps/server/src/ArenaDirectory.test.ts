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

  it("keeps call-order revisions when an older session lookup completes last", async () => {
    let resolveOpen!: (value: PublicSession) => void;
    let resolveClose!: (value: PublicSession) => void;
    const openSession = new Promise<PublicSession>((resolve) => { resolveOpen = resolve; });
    const closeSession = new Promise<PublicSession>((resolve) => { resolveClose = resolve; });
    const gameLift = {
      publicSession: vi.fn()
        .mockImplementationOnce(() => openSession)
        .mockImplementationOnce(() => closeSession),
    };
    const send = vi.fn(async (_command: unknown) => ({ Payload: Buffer.from(JSON.stringify({ result: { updated: true } })) }));
    const directory = new RemoteArenaDirectory("matchmaker", gameLift as never, { send, destroy: vi.fn() } as never);

    const opening = directory.publish({ arenaId: "A2BC", open: true, closesAt: 12_000 });
    const closing = directory.publish({ arenaId: "A2BC", open: false });
    resolveClose(publicSession);
    await closing;
    resolveOpen(publicSession);
    await opening;

    const payloads = send.mock.calls.map(([command]) => JSON.parse(Buffer.from(
      (command as { input: { Payload: Uint8Array } }).input.Payload,
    ).toString("utf8")) as { args: { open: boolean; revision: number } });
    expect(payloads).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ open: false, revision: 2 }) }),
    ]);
  });
});

type PublicSession = {
  gameSessionId: string;
  arenaId: string;
  buildId: string;
  region: string;
};

const publicSession: PublicSession = {
  gameSessionId: "game-session-1",
  arenaId: "A2BC",
  buildId: "web-42",
  region: "ca-central-1",
};
