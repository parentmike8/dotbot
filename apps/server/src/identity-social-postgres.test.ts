import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { PostgresPersistence } from "./db/PostgresPersistence";
import type { VerifiedExternalIdentity } from "./db";

const databaseUrl = process.env.DATABASE_URL;
let databaseAvailable = false;
let sql: Sql | null = null;
let lockSql: Sql | null = null;

if (databaseUrl) {
  // The repository's Postgres suites share DATABASE_URL and truncate fixtures.
  // A dedicated connection serializes fixture setup while the test pool keeps
  // enough connections for real transaction races inside this suite.
  sql = postgres(databaseUrl, { connect_timeout: 2, max: 4 });
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

const firebaseIdentity = (subject: string, provider: VerifiedExternalIdentity["provider"] = "email_link"): VerifiedExternalIdentity => ({
  issuer: "https://securetoken.google.com/dotbot-test",
  subject,
  provider,
  authenticatedAt: Date.now(),
});

describe.skipIf(!databaseAvailable)("Postgres identity and social transactions", () => {
  beforeAll(async () => {
    await lockSql!`select pg_advisory_lock(4815162342)`;
    await sql!`truncate table players, match_results cascade`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await lockSql!`select pg_advisory_unlock(4815162342)`;
    await lockSql?.end({ timeout: 1 });
  });

  it("retries public-ID collisions, atomically merges guest progress, and replays without duplication", async () => {
    const candidates = ["ABCDEFGH", "abcdefgh", "JKLMNPQR"];
    const persistence = new PostgresPersistence(sql!, () => candidates.shift() ?? "STUVWXYZ");
    const target = await persistence.registerPlayer("Linked target");
    expect(target.publicPlayerId).toBe("ABCDEFGH");
    await sql!`insert into hold_items (player_id, item_type, qty) values (${target.playerId}, 'h', 2)`;
    await sql!`insert into learned_blueprints (player_id, blueprint_id) values (${target.playerId}, 'shelf')`;
    await sql!`update players set loadout = '["d"]'::jsonb where id = ${target.playerId}`;
    expect((await persistence.linkAccount(target.token, firebaseIdentity("same-account"))).merged).toBe(false);

    const source = await persistence.registerPlayer("Current guest");
    expect(source.publicPlayerId).toBe("JKLMNPQR");
    await sql!`insert into hold_items (player_id, item_type, qty) values (${source.playerId}, 'r', 3)`;
    await sql!`insert into learned_blueprints (player_id, blueprint_id) values (${source.playerId}, 'workbench')`;
    await sql!`update players set loadout = '["i"]'::jsonb where id = ${source.playerId}`;

    const mergeAttempts = await Promise.all([
      persistence.linkAccount(source.token, firebaseIdentity("same-account", "phone")),
      persistence.linkAccount(source.token, firebaseIdentity("same-account", "phone")),
    ]);
    const merged = mergeAttempts.find((attempt) => attempt.merged)!;
    expect(mergeAttempts.filter((attempt) => attempt.merged)).toHaveLength(1);
    expect(mergeAttempts.filter((attempt) => attempt.replayed)).toHaveLength(1);
    expect(merged).toMatchObject({ merged: true, replayed: false, account: { publicPlayerId: "ABCDEFGH", linked: true } });
    expect(merged.account.providers.sort()).toEqual(["email_link", "phone"]);
    expect(await persistence.helloPlayer(source.token)).toMatchObject({
      playerId: target.playerId,
      previousPublicPlayerIds: [source.publicPlayerId],
    });
    expect((await persistence.helloPlayer(target.token))?.playerId).toBe(target.playerId);

    const [counts] = await sql!<Array<{ source: number; health: number; radar: number; dash: number; incognito: number; receipts: number; aliases: number }>>`
      select
        (select count(*)::int from players where id = ${source.playerId}) as source,
        (select coalesce(sum(qty), 0)::int from hold_items where player_id = ${target.playerId} and item_type = 'h') as health,
        (select coalesce(sum(qty), 0)::int from hold_items where player_id = ${target.playerId} and item_type = 'r') as radar,
        (select coalesce(sum(qty), 0)::int from hold_items where player_id = ${target.playerId} and item_type = 'd') as dash,
        (select coalesce(sum(qty), 0)::int from hold_items where player_id = ${target.playerId} and item_type = 'i') as incognito,
        (select count(*)::int from identity_merge_receipts where source_player_id = ${source.playerId}) as receipts,
        (select count(*)::int from player_aliases where source_player_id = ${source.playerId}
          and source_public_player_id = ${source.publicPlayerId} and target_player_id = ${target.playerId}) as aliases
    `;
    expect(counts).toEqual({ source: 0, health: 2, radar: 3, dash: 1, incognito: 1, receipts: 1, aliases: 1 });
    expect((await sql!<Array<{ blueprintId: string }>>`
      select blueprint_id as "blueprintId" from learned_blueprints where player_id = ${target.playerId} order by blueprint_id
    `).map((row) => row.blueprintId)).toEqual(["shelf", "workbench"]);

    const afterTombstone = await persistence.registerPlayer("Collision after merge");
    expect(afterTombstone.publicPlayerId).toBe("STUVWXYZ");
    expect(afterTombstone.publicPlayerId).not.toBe(source.publicPlayerId);

    // A room admitted before linking still holds the retired guest UUID. Its
    // next authoritative write must resolve to the canonical linked account.
    const liveMatchId = "00000000-0000-4000-8000-000000000901";
    expect(await persistence.startMatch({
      matchId: liveMatchId,
      roomCode: "LINK",
      mapId: "downtown",
      startedAt: new Date(),
      playerIds: [source.playerId],
    })).toEqual({ loadouts: { [source.playerId]: [] } });
    await persistence.recordOutcome({ matchId: liveMatchId, playerId: source.playerId, outcome: "disconnected" });
    expect((await sql!<Array<{ playerId: string; outcome: string }>>`
      select player_id as "playerId", outcome from match_participants where match_id = ${liveMatchId}
    `)[0]).toEqual({ playerId: target.playerId, outcome: "disconnected" });

    const replay = await persistence.linkAccount(source.token, firebaseIdentity("same-account", "phone"));
    expect(replay).toMatchObject({ merged: false, replayed: true, account: { publicPlayerId: "ABCDEFGH" } });
    const [afterReplay] = await sql!<Array<{ items: number; receipts: number }>>`
      select
        (select coalesce(sum(qty), 0)::int from hold_items where player_id = ${target.playerId}) as items,
        (select count(*)::int from identity_merge_receipts where source_player_id = ${source.playerId}) as receipts
    `;
    expect(afterReplay).toEqual({ items: 7, receipts: 1 });
  });

  it("serializes concurrent first links and rejects cross-account merge conflicts without mutation", async () => {
    const persistence = new PostgresPersistence(sql!, (() => {
      let index = 0;
      const ids = ["STUVWXYZ", "23456789", "ABCDEFGJ"];
      return () => ids[index++] ?? "ABCDEFGK";
    })());
    const first = await persistence.registerPlayer("First concurrent guest");
    const second = await persistence.registerPlayer("Second concurrent guest");
    const shared = firebaseIdentity("concurrent-account");
    const results = await Promise.all([
      persistence.linkAccount(first.token, shared),
      persistence.linkAccount(second.token, shared),
    ]);
    expect(results.filter((result) => result.merged)).toHaveLength(1);
    expect((await persistence.helloPlayer(first.token))?.playerId).toBe((await persistence.helloPlayer(second.token))?.playerId);

    const third = await persistence.registerPlayer("Already linked elsewhere");
    await persistence.linkAccount(third.token, firebaseIdentity("other-account"));
    const canonicalBefore = (await persistence.helloPlayer(first.token))!.playerId;
    await expect(persistence.linkAccount(third.token, shared)).rejects.toThrow("already linked to a different account");
    expect((await persistence.helloPlayer(third.token))?.playerId).toBe(third.playerId);
    expect((await persistence.helloPlayer(first.token))?.playerId).toBe(canonicalBefore);
  });

  it("rejects a merge when both profiles are still active in the same match", async () => {
    const candidates = ["A2345678", "B2345678"];
    const persistence = new PostgresPersistence(sql!, () => candidates.shift() ?? "C2345678");
    const target = await persistence.registerPlayer("Active target");
    const source = await persistence.registerPlayer("Active source");
    await persistence.linkAccount(target.token, firebaseIdentity("active-overlap"));
    await persistence.startMatch({
      matchId: "00000000-0000-4000-8000-000000000903",
      roomCode: "DUPE",
      mapId: "downtown",
      startedAt: new Date(),
      playerIds: [target.playerId, source.playerId],
    });

    await expect(persistence.linkAccount(source.token, firebaseIdentity("active-overlap")))
      .rejects.toThrow("overlapping active match");
    expect((await persistence.helloPlayer(target.token))?.playerId).toBe(target.playerId);
    expect((await persistence.helloPlayer(source.token))?.playerId).toBe(source.playerId);
    expect((await sql!<Array<{ count: number }>>`
      select count(*)::int as count from match_participants
      where match_id = '00000000-0000-4000-8000-000000000903'
    `)[0].count).toBe(2);
  });

  it("enforces linked friend privacy, guest invite acceptance, and verified deletion boundaries", async () => {
    const candidates = ["BCDEFGHJ", "CDEFGHJK", "DEFGHJKL"];
    const persistence = new PostgresPersistence(sql!, () => candidates.shift() ?? "EFGHJKLM");
    const owner = await persistence.registerPlayer("Owner");
    const friend = await persistence.registerPlayer("Friend");
    const guest = await persistence.registerPlayer("Guest invitee");
    await persistence.linkAccount(owner.token, firebaseIdentity("owner"));
    await persistence.linkAccount(friend.token, firebaseIdentity("friend"));

    expect(await persistence.requestFriend(guest.token, owner.publicPlayerId)).toBeNull();
    expect(await persistence.requestFriend(owner.token, owner.publicPlayerId)).toBeNull();
    const reciprocalRequests = await Promise.all([
      persistence.requestFriend(owner.token, friend.publicPlayerId),
      persistence.requestFriend(friend.token, owner.publicPlayerId),
    ]);
    expect(reciprocalRequests.some((request) => request?.status === "friends")).toBe(true);
    expect(await persistence.acceptFriend(friend.token, owner.publicPlayerId)).toMatchObject({ status: "friends" });
    expect(await persistence.listFriends(owner.token)).toEqual([
      { publicPlayerId: friend.publicPlayerId, displayName: "Friend", status: "friends" },
    ]);
    await sql!`insert into player_blocks (blocker_player_id, blocked_player_id) values (${friend.playerId}, ${owner.playerId})`;
    expect(await persistence.listFriends(owner.token)).toEqual([]);
    await sql!`delete from player_blocks where blocker_player_id = ${friend.playerId} and blocked_player_id = ${owner.playerId}`;
    await persistence.updatePrivacy(friend.token, false);
    expect(await persistence.findPublicPlayer(owner.token, friend.publicPlayerId.toLowerCase())).toBeNull();

    const invite = await persistence.createPartyInvite(owner.token);
    expect(invite?.code).toHaveLength(32);
    expect(await persistence.acceptPartyInvite(owner.token, invite!.code)).toBeNull();
    expect(await persistence.acceptPartyInvite(guest.token, invite!.code)).toMatchObject({ durable: false });
    expect(await persistence.acceptPartyInvite(friend.token, invite!.code)).toMatchObject({ durable: true });
    expect(await persistence.acceptPartyInvite(friend.token, invite!.code)).toMatchObject({ durable: true });
    expect(Number((await sql!<Array<{ count: number }>>`
      select count(*)::int as count from party_invite_acceptances where player_id = ${friend.playerId}
    `)[0].count)).toBe(1);
    expect((await sql!<Array<{ tokenHash: string }>>`select token_hash as "tokenHash" from party_invites where owner_player_id = ${owner.playerId}`)[0].tokenHash)
      .not.toBe(invite!.code);
    const expired = await persistence.createPartyInvite(owner.token);
    await sql!`update party_invites set expires_at = now() - interval '1 second' where owner_player_id = ${owner.playerId} and expires_at > now()`;
    expect(await persistence.acceptPartyInvite(guest.token, expired!.code)).toBeNull();

    const deletionMatchId = "00000000-0000-4000-8000-000000000902";
    await sql!`insert into match_results (id, room_code, map_id, started_at, summary) values (
      ${deletionMatchId}, 'PRIV', 'downtown', now(), ${JSON.stringify({
        reason: "complete",
        participants: [{ playerId: owner.publicPlayerId, internalPlayerId: owner.playerId, displayName: "Owner" }],
        subject: "owner",
        token: owner.token,
      })}::jsonb
    )`;
    await sql!`insert into match_participants (match_id, player_id, outcome, starting_loadout)
      values (${deletionMatchId}, ${owner.playerId}, 'active', '[]'::jsonb)`;

    await expect(persistence.deleteLinkedAccount(owner.token, firebaseIdentity("wrong-owner")))
      .rejects.toThrow("does not own this DotBot account");
    expect(await persistence.helloPlayer(owner.token)).not.toBeNull();
    expect(await persistence.deleteLinkedAccount(owner.token, firebaseIdentity("owner"))).toBe(true);
    expect(await persistence.helloPlayer(owner.token)).toBeNull();
    expect(await persistence.helloPlayer(friend.token)).not.toBeNull();
    const scrubbed = JSON.stringify((await sql!<Array<{ summary: unknown }>>`
      select summary from match_results where id = ${deletionMatchId}
    `)[0].summary);
    for (const sensitive of [owner.publicPlayerId, owner.playerId, "Owner", "owner", owner.token]) {
      expect(scrubbed).not.toContain(sensitive);
    }
  });
});
