import { describe, expect, it } from "vitest";
import {
  canonicalTrustedPartyRoster,
  canonicalTrustedPartyReservation,
  parseTrustedPartyReservation,
  parseTrustedPartyRoster,
  type TrustedPartyRoster,
} from "./internalParty";

const roster = (overrides: Partial<TrustedPartyRoster> = {}): TrustedPartyRoster => ({
  claimId: "00000000-0000-4000-8000-000000000010",
  partyId: "party-0123456789abcdef0123456789abcdef",
  version: 7,
  leaderPlayerId: "00000000-0000-4000-8000-000000000001",
  requestingPlayerId: "00000000-0000-4000-8000-000000000001",
  buildId: "web-42",
  region: "ca-central-1",
  issuedAt: 1_785_552_000_000,
  expiresAt: 1_785_552_030_000,
  members: [
    { playerId: "00000000-0000-4000-8000-000000000002", name: "Second" },
    { playerId: "00000000-0000-4000-8000-000000000001", name: "Leader" },
  ],
  ...overrides,
});

describe("trusted internal party roster", () => {
  it("canonicalizes member order without exposing aliases or device identity", () => {
    const parsed = parseTrustedPartyRoster(roster());
    expect(parsed?.members.map((member) => member.playerId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(canonicalTrustedPartyRoster(roster())).toBe(JSON.stringify(parsed));
    expect(canonicalTrustedPartyRoster(roster())).not.toContain("device");
    expect(canonicalTrustedPartyRoster(roster())).not.toContain("publicPlayerId");
  });

  it("rejects over-cap, duplicate, non-member leader/requester, and unsafe metadata", () => {
    const fourth = { playerId: "00000000-0000-4000-8000-000000000004", name: "Fourth" };
    const third = { playerId: "00000000-0000-4000-8000-000000000003", name: "Third" };
    expect(parseTrustedPartyRoster(roster({ members: [...roster().members, third, fourth] }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ members: [roster().members[0], roster().members[0]] }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ leaderPlayerId: fourth.playerId }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ requestingPlayerId: fourth.playerId }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ partyId: "00000000-0000-4000-8000-000000000099" }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ buildId: "web 42" }))).toBeNull();
  });

  it("requires a bounded, fresh, positive-version canonical snapshot", () => {
    expect(parseTrustedPartyRoster(roster({ version: 0 }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ expiresAt: roster().issuedAt }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ expiresAt: roster().issuedAt + 5 * 60_000 + 1 }))).toBeNull();
    expect(parseTrustedPartyRoster(roster({ members: [] }))).toBeNull();
  });

  it("binds one GameLift reservation to the complete canonical roster", () => {
    const reservation = {
      claimId: roster().claimId,
      partyId: roster().partyId,
      version: roster().version,
      playerId: roster().members[0].playerId,
      memberPlayerIds: roster().members.map((member) => member.playerId).reverse(),
      arenaId: "A2BC",
      buildId: roster().buildId,
      region: roster().region,
      expiresAt: roster().expiresAt,
    };
    const parsed = parseTrustedPartyReservation(reservation);
    expect(parsed?.memberPlayerIds).toEqual([...reservation.memberPlayerIds].sort());
    expect(canonicalTrustedPartyReservation(reservation)).toBe(JSON.stringify(parsed));
    expect(parseTrustedPartyReservation({ ...reservation, playerId: "00000000-0000-4000-8000-000000000099" })).toBeNull();
    expect(parseTrustedPartyReservation({ ...reservation, memberPlayerIds: [...reservation.memberPlayerIds, reservation.memberPlayerIds[0]] })).toBeNull();
  });
});
