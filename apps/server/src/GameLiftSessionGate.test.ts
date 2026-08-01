import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { canonicalTrustedPartyReservation } from "@dotbot/protocol";
import { GameLiftSessionGate, isPlayerSessionClaimMismatch, requiresPlayerSessionRemoval } from "./GameLiftSessionGate";

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

    const error = await gate.acceptPublicPlayerSession("psess-public").catch((caught) => caught as unknown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/does not match/i);
    expect(requiresPlayerSessionRemoval(error)).toBe(true);
  });

  it("accepts only a fresh whole-roster reservation signed for this exact arena", async () => {
    const secret = "a".repeat(64);
    const reservation = {
      claimId: "00000000-0000-4000-8000-000000000010",
      partyId: "party-0123456789abcdef0123456789abcdef",
      version: 7,
      playerId: "00000000-0000-4000-8000-000000000001",
      memberPlayerIds: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
      memberLoadoutRevisions: [
        { playerId: "00000000-0000-4000-8000-000000000001", revision: 4 },
        { playerId: "00000000-0000-4000-8000-000000000002", revision: 9 },
      ],
      arenaId: "A2BC",
      buildId: "web-42",
      region: "ca-central-1",
      expiresAt: Date.now() + 30_000,
    };
    const playerSessionPayloads = reservation.memberPlayerIds.map((playerId, index) => {
      const memberReservation = { ...reservation, playerId };
      const signature = createHmac("sha256", secret)
        .update(`party-reservation.${canonicalTrustedPartyReservation(memberReservation)}`)
        .digest("hex");
      return {
        playerSessionId: `psess-party-${index + 1}`,
        playerId,
        playerData: JSON.stringify({ mode: "public-hot-arena", reservation: memberReservation, reservationSignature: signature }),
      };
    });
    const sessionPayload = {
      GameSessionId: "game-session-1",
      GameProperties: {
        mode: "public-hot-arena",
        arenaId: "A2BC",
        buildId: "web-42",
        region: "ca-central-1",
        partyAllocation: "v1",
        partySecret: secret,
      },
    };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(playerSessionPayloads[0]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(playerSessionPayloads[1]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        playerSessions: playerSessionPayloads,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionPayload), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request, atomicPartyAllocation: true });

    const inspected = [
      await gate.inspectPublicPlayerSession("psess-party-1"),
      await gate.inspectPublicPlayerSession("psess-party-2"),
    ];
    expect(inspected[0].admission).toMatchObject({
      playerId: reservation.playerId,
      partyId: reservation.partyId,
      partyVersion: 7,
      partyClaimId: reservation.claimId,
      partyMemberPlayerIds: reservation.memberPlayerIds,
    });
    await expect(gate.acceptPublicPartySessions(inspected)).resolves.toBeUndefined();
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:8090/v1/player-sessions/inspect",
      "http://127.0.0.1:8090/v1/session",
      "http://127.0.0.1:8090/v1/player-sessions/inspect",
      "http://127.0.0.1:8090/v1/session",
      "http://127.0.0.1:8090/v1/player-sessions/accept-party",
      "http://127.0.0.1:8090/v1/session",
    ]);
  });

  it("fails closed on a tampered or expired whole-party reservation", async () => {
    const secret = "b".repeat(64);
    const reservation = {
      claimId: "00000000-0000-4000-8000-000000000010",
      partyId: "party-0123456789abcdef0123456789abcdef",
      version: 2,
      playerId: "00000000-0000-4000-8000-000000000001",
      memberPlayerIds: ["00000000-0000-4000-8000-000000000001"],
      memberLoadoutRevisions: [{ playerId: "00000000-0000-4000-8000-000000000001", revision: 4 }],
      arenaId: "A2BC",
      buildId: "web-42",
      region: "ca-central-1",
      expiresAt: Date.now() - 1,
    };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        playerSessionId: "psess-party",
        playerId: reservation.playerId,
        playerData: JSON.stringify({ mode: "public-hot-arena", reservation, reservationSignature: "0".repeat(64) }),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        GameSessionId: "game-session-1",
        GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1", partyAllocation: "v1", partySecret: secret },
      }), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request, atomicPartyAllocation: true });
    const error = await gate.inspectPublicPlayerSession("psess-party").catch((caught) => caught as unknown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid atomic party metadata");
    expect(requiresPlayerSessionRemoval(error)).toBe(true);
  });

  it("does not require removal for a definite atomic inspect rejection", async () => {
    const gate = new GameLiftSessionGate({
      atomicPartyAllocation: true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    });

    const error = await gate.inspectPublicPlayerSession("foreign-player-session").catch((caught) => caught as unknown);
    expect(error).toBeInstanceOf(Error);
    expect(requiresPlayerSessionRemoval(error)).toBe(false);
  });

  it("proves a release id belongs to the exact signed claim without requiring a fresh reservation", async () => {
    const secret = "c".repeat(64);
    const claimId = "00000000-0000-4000-8000-000000000010";
    const reservation = {
      claimId,
      partyId: "party-0123456789abcdef0123456789abcdef",
      version: 2,
      playerId: "00000000-0000-4000-8000-000000000001",
      memberPlayerIds: ["00000000-0000-4000-8000-000000000001"],
      memberLoadoutRevisions: [{ playerId: "00000000-0000-4000-8000-000000000001", revision: 4 }],
      arenaId: "A2BC",
      buildId: "web-42",
      region: "ca-central-1",
      expiresAt: Date.now() - 60_000,
    };
    const reservationSignature = createHmac("sha256", secret)
      .update(`party-reservation.${canonicalTrustedPartyReservation(reservation)}`)
      .digest("hex");
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        playerSessionId: "psess-party",
        playerId: reservation.playerId,
        playerData: JSON.stringify({ mode: "public-hot-arena", reservation, reservationSignature }),
        status: "ACTIVE",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        GameSessionId: "game-session-1",
        GameProperties: { mode: "public-hot-arena", arenaId: "A2BC", buildId: "web-42", region: "ca-central-1", partyAllocation: "v1", partySecret: secret },
      }), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request, atomicPartyAllocation: true });

    await expect(gate.verifyPublicPartySessionForRelease("psess-party", claimId)).resolves.toBe(true);
    expect(String(request.mock.calls[0][0])).toContain("/v1/player-sessions/inspect-release");

    const absent = new GameLiftSessionGate({
      atomicPartyAllocation: true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    });
    await expect(absent.verifyPublicPartySessionForRelease("already-gone", claimId)).resolves.toBe(false);
  });

  it("keeps release verification retryable when current-session metadata is unavailable", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        playerSessionId: "psess-party",
        playerId: "00000000-0000-4000-8000-000000000001",
        playerData: "{}",
        status: "RESERVED",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const gate = new GameLiftSessionGate({ fetch: request, atomicPartyAllocation: true });

    const error = await gate.verifyPublicPartySessionForRelease(
      "psess-party", "00000000-0000-4000-8000-000000000010",
    ).catch((caught) => caught as unknown);
    expect(error).toBeInstanceOf(Error);
    expect(isPlayerSessionClaimMismatch(error)).toBe(false);
  });

  it("requires whole-batch cleanup after an uncertain or partial adapter accept", async () => {
    const admission = {
      playerId: "00000000-0000-4000-8000-000000000001",
      arenaId: "A2BC",
      partyId: "party-0123456789abcdef0123456789abcdef",
      buildId: "web-42",
      region: "ca-central-1",
      partyVersion: 3,
      partyClaimId: "00000000-0000-4000-8000-000000000010",
      partyMemberPlayerIds: ["00000000-0000-4000-8000-000000000001"],
      partyMemberLoadoutRevisions: [{ playerId: "00000000-0000-4000-8000-000000000001", revision: 4 }],
      loadoutRevision: 4,
      partyReservationExpiresAt: Date.now() + 30_000,
    };
    const gate = new GameLiftSessionGate({
      atomicPartyAllocation: true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    });
    const error = await gate.acceptPublicPartySessions([{ playerSessionId: "psess-party", admission }])
      .catch((caught) => caught as unknown);
    expect(requiresPlayerSessionRemoval(error)).toBe(true);
  });

  it("does not require cleanup for a definite adapter rejection", async () => {
    const gate = new GameLiftSessionGate({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    });

    const error = await gate.acceptPublicPlayerSession("psess-rejected").catch((caught) => caught as unknown);
    expect(error).toBeInstanceOf(Error);
    expect(requiresPlayerSessionRemoval(error)).toBe(false);
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

  it("rejects a whitespace-only reservation identity", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ playerId: "   " }), { status: 200 }));
    const gate = new GameLiftSessionGate({ fetch: request });
    await expect(gate.acceptPlayerSession("psess-1")).rejects.toThrow("invalid player identity");
  });
});
