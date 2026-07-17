import { describe, expect, it, vi } from "vitest";
import { GameLiftSessionGate } from "./GameLiftSessionGate";

describe("GameLiftSessionGate", () => {
  it("reads the assigned room and accepts/removes player sessions through loopback", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        GameSessionId: "session-1",
        GameProperties: { roomCode: "a2bc" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ playerId: "player-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const gate = new GameLiftSessionGate({ adapterUrl: "http://127.0.0.1:18090", fetch: request });

    await expect(gate.roomCode()).resolves.toBe("A2BC");
    await expect(gate.acceptPlayerSession("psess-1")).resolves.toBe("player-1");
    await gate.removePlayerSession("psess-1");

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:18090/v1/session",
      "http://127.0.0.1:18090/v1/player-sessions/accept",
      "http://127.0.0.1:18090/v1/player-sessions/remove",
    ]);
  });

  it("refuses sessions without an explicit production room code", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ GameSessionId: "session-1" }), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request });
    await expect(gate.roomCode()).rejects.toThrow("missing its room code");
  });
});
