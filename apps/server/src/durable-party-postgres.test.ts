import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { PartyConflictError, type VerifiedExternalIdentity } from "./db";
import { PostgresPersistence } from "./db/PostgresPersistence";

const databaseUrl = process.env.DATABASE_URL;
let databaseAvailable = false;
let sql: Sql | null = null;
let lockSql: Sql | null = null;

if (databaseUrl) {
  sql = postgres(databaseUrl, { connect_timeout: 2, max: 6 });
  lockSql = postgres(databaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await Promise.all([sql`select 1`, lockSql`select 1`]);
    databaseAvailable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    await lockSql.end({ timeout: 1 }).catch(() => undefined);
    sql = null;
    lockSql = null;
  }
}

const linkedIdentity = (subject: string): VerifiedExternalIdentity => ({
  issuer: "https://securetoken.google.com/dotbot-party-test",
  subject,
  provider: "email_link",
  authenticatedAt: Date.now(),
});

function conflictCode(reason: unknown): string | undefined {
  return reason instanceof PartyConflictError ? reason.code : undefined;
}

describe.skipIf(!databaseAvailable)("durable party authority", () => {
  beforeAll(async () => {
    await lockSql!`select pg_advisory_lock(4815162342)`;
    await sql!`truncate table players, match_results cascade`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await lockSql!`select pg_advisory_unlock(4815162342)`;
    await lockSql?.end({ timeout: 1 });
  });

  it("advances loadout authority when a pre-0014 writer updates only the loadout column", async () => {
    const persistence = new PostgresPersistence(sql!, () => "LDWR2345");
    const player = await persistence.registerPlayer("Old writer");

    await sql!`update players set loadout = ${JSON.stringify(["h"])}::jsonb where id = ${player.playerId}`;

    const [row] = await sql!<Array<{ loadoutRevision: number }>>`
      select loadout_revision as "loadoutRevision" from players where id = ${player.playerId}
    `;
    expect(row.loadoutRevision).toBe(2);
  });

  it("keeps a guest invite replay device-durable, promotes it on link, and exposes only public roster state", async () => {
    const ids = ["PARTYAAA", "PARTYBBB"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "PARTYCCC");
    const leader = await persistence.registerPlayer("Leader");
    const guest = await persistence.registerPlayer("Guest");
    await persistence.linkAccount(leader.token, linkedIdentity("leader-one"));

    const invite = await persistence.createDurablePartyInvite(leader.token);
    expect(invite?.party).toMatchObject({ version: 1, canInvite: true });
    const accepted = await persistence.acceptDurablePartyInvite(guest.token, invite!.code);
    expect(accepted).toMatchObject({ durable: false, replayed: false, party: { version: 2 } });
    expect(await persistence.acceptDurablePartyInvite(guest.token, invite!.code)).toMatchObject({ replayed: true });

    const duplicateGuestToken = "duplicate-guest-device-token";
    await sql!`insert into player_devices (player_id, token_hash) values
      (${guest.playerId}, ${createHash("sha256").update(duplicateGuestToken).digest("hex")})`;
    expect(await persistence.getParty(duplicateGuestToken)).toBeNull();
    await expect(persistence.acceptDurablePartyInvite(duplicateGuestToken, invite!.code))
      .rejects.toMatchObject({ code: "party_membership_conflict" });

    const publicState = await persistence.getParty(guest.token);
    expect(publicState).toEqual({
      version: 2,
      members: [
        { publicPlayerId: leader.publicPlayerId, displayName: "Leader", leader: true },
        { publicPlayerId: guest.publicPlayerId, displayName: "Guest", leader: false },
      ],
      canInvite: false,
    });
    expect(JSON.stringify(publicState)).not.toContain(leader.playerId);
    expect(JSON.stringify(publicState)).not.toContain(guest.playerId);

    const guestIdentity = linkedIdentity("guest-promoted");
    await persistence.linkAccount(guest.token, guestIdentity);
    const secondDevice = await persistence.createLinkedSession({ ...guestIdentity, provider: "phone" });
    expect(await persistence.getParty(secondDevice!.token)).toEqual(await persistence.getParty(guest.token));
    const [ownership] = await sql!<Array<{ guestDeviceId: string | null }>>`
      select guest_device_id as "guestDeviceId" from party_members where player_id = ${guest.playerId}
    `;
    expect(ownership.guestDeviceId).toBeNull();
    const [acceptance] = await sql!<Array<{ guestDeviceId: string | null; durable: boolean }>>`
      select guest_device_id as "guestDeviceId", durable
      from party_invite_acceptances where player_id = ${guest.playerId}
    `;
    expect(acceptance).toEqual({ guestDeviceId: null, durable: true });
  });

  it("serializes concurrent joins at three and enforces the cap below application code", async () => {
    const ids = ["CAPABCDE", "CAPBCDEF", "CAPCDEFG", "CAPDEFGH", "CAPEFGHJ"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "CAPFGHJK");
    const leader = await persistence.registerPlayer("Cap owner");
    const member = await persistence.registerPlayer("Cap member");
    const candidateA = await persistence.registerPlayer("Cap candidate A");
    const candidateB = await persistence.registerPlayer("Cap candidate B");
    const rawFourth = await persistence.registerPlayer("Cap raw fourth");
    await persistence.linkAccount(leader.token, linkedIdentity("cap-owner"));
    const invite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(member.token, invite!.code);

    const joins = await Promise.allSettled([
      persistence.acceptDurablePartyInvite(candidateA.token, invite!.code),
      persistence.acceptDurablePartyInvite(candidateB.token, invite!.code),
    ]);
    expect(joins.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = joins.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(conflictCode(failed?.reason)).toBe("party_full");
    const roster = await persistence.getParty(leader.token);
    expect(roster?.members).toHaveLength(3);
    expect(roster?.version).toBe(3);
    expect(roster?.canInvite).toBe(false);

    const [party] = await sql!<Array<{ partyId: string }>>`
      select party_id as "partyId" from party_members where player_id = ${leader.playerId}
    `;
    await expect(sql!`insert into party_members (party_id, player_id) values (${party.partyId}, ${rawFourth.playerId})`)
      .rejects.toThrow("party membership cap exceeded");
  });

  it("rejects a partially bound durable invite below application code", async () => {
    const persistence = new PostgresPersistence(sql!, () => "BNDABCDE");
    const leader = await persistence.registerPlayer("Binding leader");
    await persistence.linkAccount(leader.token, linkedIdentity("binding-leader"));
    await persistence.createDurablePartyInvite(leader.token);
    const [membership] = await sql!<Array<{ partyId: string }>>`
      select party_id as "partyId" from party_members where player_id = ${leader.playerId}
    `;
    await expect(sql!`insert into party_invites
      (token_hash, owner_player_id, party_id, roster_version, expires_at)
      values ('partially-bound-invite', ${leader.playerId}, ${membership.partyId}, null, now() + interval '1 day')`)
      .rejects.toThrow(/roster_binding|check constraint/i);
  });

  it("handles revocation, expiry, stale versions, deterministic leader transfer, and disband", async () => {
    const ids = ["LFAABCDE", "LFABCDEF", "LFACDEFG"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "LFADEFGH");
    const leader = await persistence.registerPlayer("Lifecycle leader");
    const linkedMember = await persistence.registerPlayer("Lifecycle linked");
    const guestMember = await persistence.registerPlayer("Lifecycle guest");
    await persistence.linkAccount(leader.token, linkedIdentity("life-leader"));
    await persistence.linkAccount(linkedMember.token, linkedIdentity("life-linked"));

    const expired = await persistence.createDurablePartyInvite(leader.token);
    await sql!`update party_invites set expires_at = now() - interval '1 second' where token_hash = ${createHash("sha256").update(expired!.code).digest("hex")}`;
    expect(await persistence.acceptDurablePartyInvite(guestMember.token, expired!.code)).toBeNull();
    const revoked = await persistence.createDurablePartyInvite(leader.token);
    await persistence.revokeDurablePartyInvites(leader.token);
    expect(await persistence.acceptDurablePartyInvite(guestMember.token, revoked!.code)).toBeNull();

    const live = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(guestMember.token, live!.code);
    await persistence.acceptDurablePartyInvite(linkedMember.token, live!.code);
    await expect(persistence.leaveParty(guestMember.token, 2)).rejects.toMatchObject({ code: "party_version_stale" });

    const beforeDelete = await persistence.getParty(leader.token);
    expect(beforeDelete?.version).toBe(3);
    await expect(sql!`delete from players where id = ${leader.playerId}`)
      .rejects.toThrow(/parties|party_members/i);
    expect(await persistence.deleteLinkedAccount(leader.token, linkedIdentity("life-leader"))).toBe(true);
    const transferred = await persistence.getParty(linkedMember.token);
    expect(transferred).toMatchObject({ version: 4 });
    expect(transferred?.members.find((member) => member.publicPlayerId === linkedMember.publicPlayerId)?.leader).toBe(true);
    expect(await persistence.disbandParty(linkedMember.token, transferred!.version)).toBe(true);
    expect(await persistence.getParty(guestMember.token)).toBeNull();
  });

  it("serializes concurrent leaves and leader transfer without a cross-player deadlock", async () => {
    const ids = ["CNAABCDE", "CNABCDEF", "CNACDEFG"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "CNADEFGH");
    const leader = await persistence.registerPlayer("Concurrent leader");
    const first = await persistence.registerPlayer("Concurrent first");
    const second = await persistence.registerPlayer("Concurrent second");
    await persistence.linkAccount(leader.token, linkedIdentity("concurrent-leader"));
    const invite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(first.token, invite!.code);
    await persistence.acceptDurablePartyInvite(second.token, invite!.code);

    const transferAndLeave = await Promise.allSettled([
      persistence.transferPartyLeader(leader.token, first.publicPlayerId, 3),
      persistence.leaveParty(first.token, 3),
    ]);
    expect(transferAndLeave.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = transferAndLeave.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(conflictCode(rejected?.reason)).toBe("party_version_stale");

    await Promise.all([
      persistence.leaveParty(first.token),
      persistence.leaveParty(second.token),
    ]);
    const finalParty = await persistence.getParty(leader.token);
    expect(finalParty?.members).toEqual([
      { publicPlayerId: leader.publicPlayerId, displayName: "Concurrent leader", leader: true },
    ]);
  });

  it("serializes leader transfer against a guest-to-leader identity merge", async () => {
    const ids = ["TMAABCDE", "TMABCDEF"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "TMACDEFG");
    const leader = await persistence.registerPlayer("Transfer merge leader");
    const guest = await persistence.registerPlayer("Transfer merge guest");
    const leaderIdentity = linkedIdentity("transfer-merge-leader");
    await persistence.linkAccount(leader.token, leaderIdentity);
    const invite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(guest.token, invite!.code);

    const outcomes = await Promise.allSettled([
      persistence.transferPartyLeader(leader.token, guest.publicPlayerId, 2),
      persistence.linkAccount(guest.token, { ...leaderIdentity, provider: "phone" }),
    ]);
    expect(outcomes[1].status).toBe("fulfilled");
    if (outcomes[0].status === "rejected") {
      expect(conflictCode(outcomes[0].reason)).toBe("party_version_stale");
    }
    expect(await persistence.getParty(leader.token)).toMatchObject({
      members: [{ publicPlayerId: leader.publicPlayerId, displayName: "Transfer merge leader", leader: true }],
    });
  });

  it("serializes invite creation with another member leaving", async () => {
    const ids = ["VLAABCDE", "VLABCDEF"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "VLACDEFG");
    const leader = await persistence.registerPlayer("Invite lock leader");
    const member = await persistence.registerPlayer("Invite lock member");
    await persistence.linkAccount(leader.token, linkedIdentity("invite-lock-leader"));
    const initialInvite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(member.token, initialInvite!.code);

    const inviteAndLeave = await Promise.allSettled([
      persistence.createDurablePartyInvite(leader.token),
      persistence.leaveParty(member.token, 2),
    ]);
    expect(inviteAndLeave).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    expect((inviteAndLeave[0] as PromiseFulfilledResult<unknown>).value).toBeTruthy();
    expect((await persistence.getParty(leader.token))?.members).toEqual([
      { publicPlayerId: leader.publicPlayerId, displayName: "Invite lock leader", leader: true },
    ]);
  });

  it("serializes a leader loss with another member leaving", async () => {
    const ids = ["LLAABCDE", "LLABCDEF", "LLACDEFG"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "LLADEFGH");
    const leader = await persistence.registerPlayer("Leaving leader");
    const first = await persistence.registerPlayer("Leaving first");
    const second = await persistence.registerPlayer("Leaving second");
    await persistence.linkAccount(leader.token, linkedIdentity("leaving-leader"));
    const invite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(first.token, invite!.code);
    await persistence.acceptDurablePartyInvite(second.token, invite!.code);

    const leaves = await Promise.allSettled([
      persistence.leaveParty(leader.token),
      persistence.leaveParty(first.token),
    ]);
    expect(leaves.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await persistence.getParty(second.token)).toMatchObject({
      version: 5,
      members: [{ publicPlayerId: second.publicPlayerId, displayName: "Leaving second", leader: true }],
    });
  });

  it("moves a guest membership to the canonical linked account and never signs the retired alias", async () => {
    const ids = ["MRGABCDE", "MRGBCDEF", "MRGCDEFG"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "MRGDEFGH");
    const leader = await persistence.registerPlayer("Merge leader");
    const source = await persistence.registerPlayer("Merge source");
    const target = await persistence.registerPlayer("Merge target");
    const targetIdentity = linkedIdentity("merge-target");
    await persistence.linkAccount(leader.token, linkedIdentity("merge-leader"));
    await persistence.linkAccount(target.token, targetIdentity);
    const invite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(source.token, invite!.code);

    const merge = await persistence.linkAccount(source.token, { ...targetIdentity, provider: "phone" });
    expect(merge).toMatchObject({ merged: true, account: { publicPlayerId: target.publicPlayerId } });
    const party = await persistence.getParty(target.token);
    expect(party?.members.map((member) => member.publicPlayerId)).toEqual([leader.publicPlayerId, target.publicPlayerId]);
    const claim = await persistence.claimPartyQueue(leader.token, {
      requestId: randomUUID(),
      buildId: "web-party-test",
      region: "ca-central-1",
    });
    expect(claim.members.map((member) => member.playerId)).toEqual([leader.playerId, target.playerId]);
    expect(JSON.stringify(claim)).not.toContain(source.playerId);
    await persistence.completePartyQueueCancellation(target.token, claim.claimId);
  });

  it("freezes one versioned roster, makes concurrent queue entry idempotent, rejects stale authority, and unfreezes only after completion", async () => {
    const ids = ["QUEABCDE", "QUEBCDEF", "QUECDEFG"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "QUEDEFGH");
    const leader = await persistence.registerPlayer("Queue leader");
    const member = await persistence.registerPlayer("Queue member");
    const joiner = await persistence.registerPlayer("Queue joiner");
    await persistence.linkAccount(leader.token, linkedIdentity("queue-leader"));
    const invite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(member.token, invite!.code);

    const firstRequest = randomUUID();
    const secondRequest = randomUUID();
    const claims = await Promise.all([
      persistence.claimPartyQueue(leader.token, { requestId: firstRequest, buildId: "web-queue", region: "ca-central-1" }),
      persistence.claimPartyQueue(leader.token, { requestId: secondRequest, buildId: "web-queue", region: "ca-central-1" }),
    ]);
    expect(new Set(claims.map((claim) => claim.claimId))).toEqual(new Set([claims[0].claimId]));
    expect(claims[0].members).toHaveLength(2);
    const queuedMergeIdentity = linkedIdentity("queue-merge-target");
    await persistence.linkAccount(joiner.token, queuedMergeIdentity);
    await expect(persistence.linkAccount(member.token, { ...queuedMergeIdentity, provider: "phone" }))
      .rejects.toMatchObject({ code: "party_queued" });
    await expect(persistence.deleteLinkedAccount(leader.token, linkedIdentity("queue-leader")))
      .rejects.toMatchObject({ code: "party_queued" });
    await expect(persistence.acceptDurablePartyInvite(joiner.token, invite!.code)).rejects.toMatchObject({ code: "party_queued" });
    await expect(persistence.leaveParty(member.token, 2)).rejects.toMatchObject({ code: "party_queued" });
    await expect(persistence.transferPartyLeader(leader.token, member.publicPlayerId, 2)).rejects.toMatchObject({ code: "party_queued" });

    expect(await persistence.getPartyQueueStatus(member.token, claims[0].claimId)).toMatchObject({
      claimId: claims[0].claimId,
      requestingPlayerId: member.playerId,
      status: "active",
    });
    const cancellation = await persistence.cancelPartyQueue(member.token, claims[0].claimId);
    expect(cancellation?.requestingPlayerId).toBe(member.playerId);
    expect(await persistence.completePartyQueueCancellation(member.token, claims[0].claimId)).toBe(true);
    expect(await persistence.completePartyQueueCancellation(member.token, claims[0].claimId)).toBe(true);
    await persistence.leaveParty(member.token, 2);

    const nextInvite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(joiner.token, nextInvite!.code);
    const staleClaim = await persistence.claimPartyQueue(leader.token, {
      requestId: randomUUID(), buildId: "web-queue", region: "ca-central-1",
    });
    const [party] = await sql!<Array<{ partyId: string }>>`
      select party_id as "partyId" from party_members where player_id = ${leader.playerId}
    `;
    await sql!`update parties set version = version + 1 where id = ${party.partyId}`;
    await expect(persistence.claimPartyQueue(joiner.token, {
      requestId: randomUUID(), buildId: "web-queue", region: "ca-central-1",
    })).rejects.toMatchObject({ code: "party_version_stale" });
    await persistence.completePartyQueueCancellation(leader.token, staleClaim.claimId);
  });

  it("snapshots versioned loadouts, locks changes, and gives cancel/start exactly one transactional winner", async () => {
    const ids = ["LCKABCDE", "LCKBCDEF"];
    const persistence = new PostgresPersistence(sql!, () => ids.shift() ?? "LCKCDEFG");
    const leader = await persistence.registerPlayer("Loadout leader");
    const member = await persistence.registerPlayer("Loadout member");
    await persistence.linkAccount(leader.token, linkedIdentity("loadout-leader"));
    const invite = await persistence.createDurablePartyInvite(leader.token);
    await persistence.acceptDurablePartyInvite(member.token, invite!.code);
    await sql!`update players set loadout = '["h"]'::jsonb, loadout_revision = 4 where id = ${leader.playerId}`;
    await sql!`update players set loadout = '["r"]'::jsonb, loadout_revision = 9 where id = ${member.playerId}`;

    const claim = await persistence.claimPartyQueue(leader.token, {
      requestId: randomUUID(), buildId: "web-lock", region: "ca-central-1",
    });
    expect(claim.status).toBe("active");
    expect(claim.members).toEqual([
      { playerId: leader.playerId, name: "Loadout leader", loadoutRevision: 4 },
      { playerId: member.playerId, name: "Loadout member", loadoutRevision: 9 },
    ]);
    await expect(persistence.setLoadout(leader.token, [])).rejects.toMatchObject({ code: "party_queued" });

    await expect(persistence.startMatch({
      matchId: randomUUID(), roomCode: "A2BC", mapId: "downtown", startedAt: new Date(),
      playerIds: [leader.playerId, member.playerId],
      queueClaims: claim.members.map((entry) => ({
        playerId: entry.playerId,
        claimId: claim.claimId,
        partyVersion: claim.version,
        loadoutRevision: entry.loadoutRevision + (entry.playerId === leader.playerId ? 1 : 0),
      })),
    })).rejects.toThrow(/loadout revision/i);

    const matchId = randomUUID();
    const start = persistence.startMatch({
      matchId, roomCode: "A2BC", mapId: "downtown", startedAt: new Date(),
      playerIds: [leader.playerId, member.playerId],
      queueClaims: claim.members.map((entry) => ({
        playerId: entry.playerId,
        claimId: claim.claimId,
        partyVersion: claim.version,
        loadoutRevision: entry.loadoutRevision,
      })),
    });
    const cancel = persistence.cancelPartyQueue(member.token, claim.claimId);
    const [started, cancelled] = await Promise.allSettled([start, cancel]);
    const [terminal] = await sql!<Array<{ status: string; startedMatchId: string | null }>>`
      select status, started_match_id as "startedMatchId" from party_queue_claims where id = ${claim.claimId}
    `;
    expect(["completed", "cancelling"]).toContain(terminal.status);
    if (terminal.status === "completed") {
      expect(started.status).toBe("fulfilled");
      expect(cancelled.status === "fulfilled" ? cancelled.value : null).toBeNull();
      expect(terminal.startedMatchId).toBe(matchId);
      expect((started as PromiseFulfilledResult<{ loadouts: Record<string, string[]> }>).value.loadouts).toEqual({
        [leader.playerId]: ["h"], [member.playerId]: ["r"],
      });
    } else {
      expect(cancelled.status).toBe("fulfilled");
      expect(started.status).toBe("rejected");
      expect(terminal.startedMatchId).toBeNull();
      expect(await persistence.completePartyQueueCancellation(member.token, claim.claimId)).toBe(true);
    }
  });
});
