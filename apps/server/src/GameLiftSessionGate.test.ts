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

  it("returns trusted public-arena admission metadata from GameLift player data", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        playerId: "player-1",
        playerData: JSON.stringify({
          mode: "public-hot-arena",
          arenaId: "A2BC",
          partyId: "party-1",
          buildId: "web-42",
          region: "ca-central-1",
        }),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        GameSessionId: "game-session-1",
        GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
      }), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request });

    await expect(gate.acceptPublicPlayerSession("psess-public")).resolves.toEqual({
      playerId: "player-1",
      arenaId: "A2BC",
      partyId: "party-1",
      buildId: "web-42",
      region: "ca-central-1",
    });
  });

  it("rejects public player metadata that does not match the assigned GameLift session", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        playerId: "player-1",
        playerData: JSON.stringify({
          mode: "public-hot-arena",
          arenaId: "A2BC",
          partyId: "party-1",
          buildId: "web-old",
          region: "ca-central-1",
        }),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        GameSessionId: "game-session-1",
        GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1" },
      }), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request });

    await expect(gate.acceptPublicPlayerSession("psess-public")).rejects.toThrow(/does not match/i);
  });

  it("returns the trusted GameLift session id with public arena metadata", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      GameSessionId: "arn:aws:gamelift:ca-central-1:123:gamesession/fleet/session-1",
      GameProperties: {
        mode: "public-hot-arena",
        arenaId: "a2bc",
        buildId: "web-42",
        region: "ca-central-1",
      },
    }), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request });

    await expect(gate.publicSession()).resolves.toEqual({
      gameSessionId: "arn:aws:gamelift:ca-central-1:123:gamesession/fleet/session-1",
      arenaId: "A2BC",
      buildId: "web-42",
      region: "ca-central-1",
    });
  });
});
