import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { itemToCode, PUBLIC_EXTRACTION_ROLE_COUNT, type WireItemCode } from "@dotbot/protocol";
import { BASE_SLOT_DEFS, DEFAULT_BASE_SHELL, isObjectAllowedInSlot, starterBaseLayout, validateBaseLayout } from "@dotbot/game/content/base";
import { recipeById, SECOND_FLOOR_UPGRADE_ID } from "@dotbot/game/content/recipes";
import { downtownMap } from "@dotbot/game/content/downtown";
import { CONTRACT_ACTIVE_CAP, contractDayStamp, contractSatisfied, generateContractOffers } from "@dotbot/game/contracts";
import type { BaseLayout, BaseShellId, ContractDefinition, LoadoutPreset, WireLoadoutCode } from "@dotbot/game/types";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import {
  advanceBaseTutorial as advanceTutorialState,
  initialBaseTutorialState,
  type BaseTutorialAction,
  type BaseTutorialState,
} from "@dotbot/game/baseTutorial";
import type {
  Persistence,
  AccountSummary,
  FriendEntry,
  DurablePartyInvite,
  IdentityProviderKind,
  LinkAccountResult,
  PartyInviteAcceptance,
  PartyQueueClaim,
  PartySummary,
  PlayerIdentity,
  PlayerProfile,
  PublicPlayer,
  RegisteredPlayer,
  RunManifest,
  MatchStartResult,
  MatchQueueClaim,
  VerifiedExternalIdentity,
} from "./Persistence";
import { PartyConflictError, PersistenceConflictError } from "./Persistence";
import {
  baseLayouts,
  baseUpgrades,
  contracts as contractRows,
  externalIdentities,
  friendships,
  identityMergeReceipts,
  identityProviders,
  learnedBlueprints,
  matchParticipants,
  matchResults,
  partyInviteAcceptances,
  partyInvites,
  partyMembers,
  partyQueueClaims,
  parties,
  playerAliases,
  playerBlocks,
  playerDevices,
  players,
  relayRequests,
  stashItems,
} from "./schema";
import { isAggregateMatchSummary } from "../matchSummary";
import { allocateUniquePublicPlayerId, generatePublicPlayerId, normalizePublicPlayerId, type PublicPlayerIdFactory } from "../identity/publicPlayerId";

export class PostgresPersistence implements Persistence {
  readonly live = true;
  private readonly db: PostgresJsDatabase;

  constructor(private readonly client: Sql, private readonly publicIdFactory: PublicPlayerIdFactory = generatePublicPlayerId) {
    this.db = drizzle(client);
  }

  async registerPlayer(name: string): Promise<RegisteredPlayer> {
    const token = randomBytes(16).toString("hex");
    const player = await this.createGuest(name, token);
    return { ...player, token };
  }

  async helloPlayer(token: string): Promise<PlayerIdentity | null> {
    const tokenHash = hashToken(token);
    let [device] = await this.db.update(playerDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(playerDevices.tokenHash, tokenHash))
      .returning({ playerId: playerDevices.playerId });
    if (!device) {
      const [legacy] = await this.db.select({ playerId: players.id }).from(players)
        .where(eq(players.deviceTokenHash, tokenHash)).limit(1);
      if (!legacy) return null;
      await this.db.insert(playerDevices).values({ playerId: legacy.playerId, tokenHash }).onConflictDoNothing();
      device = legacy;
    }
    await this.db.update(players).set({ lastSeenAt: new Date() }).where(eq(players.id, device.playerId));
    const [player] = await this.db.select({
      id: players.id,
      publicPlayerId: players.publicPlayerId,
      name: players.displayName,
    }).from(players).where(eq(players.id, device.playerId)).limit(1);
    if (!player) return null;
    const aliases = await this.db.select({
      sourcePlayerId: playerAliases.sourcePlayerId,
      sourcePublicPlayerId: playerAliases.sourcePublicPlayerId,
    }).from(playerAliases)
      .where(eq(playerAliases.targetPlayerId, player.id));
    const previousPlayerIds = aliases.map((alias) => alias.sourcePlayerId);
    const previousPublicPlayerIds = aliases.map((alias) => alias.sourcePublicPlayerId);
    return {
      playerId: player.id,
      ...(previousPlayerIds.length > 0 ? { previousPlayerIds } : {}),
      publicPlayerId: player.publicPlayerId,
      ...(previousPublicPlayerIds.length > 0 ? { previousPublicPlayerIds } : {}),
      name: player.name,
    };
  }

  async resolveOrRegisterPlayer(token: string, _offeredName: string): Promise<PlayerIdentity> {
    const existing = await this.helloPlayer(token);
    if (existing) return existing;
    // Keep this legacy method name for mixed dedicated-server revisions, but
    // never let WebSocket/Lambda admission bypass the rate-limited register
    // endpoint. A second lookup also closes the narrow guest-merge handoff race.
    const raced = await this.helloPlayer(token);
    if (raced) return raced;
    throw new Error("Unknown device token.");
  }

  async getAccount(token: string): Promise<AccountSummary | null> {
    const identity = await this.helloPlayer(token);
    return identity ? this.accountSummary(identity.playerId) : null;
  }

  async linkAccount(token: string, identity: VerifiedExternalIdentity): Promise<LinkAccountResult> {
    const tokenHash = hashToken(token);
    const result = await this.retryConcurrentPartyTransaction(() => this.db.transaction(async (tx) => {
      // Serialize every first-link and merge for one verified Firebase account
      // before locking either player. This closes the unique-insert race and
      // keeps opposite device replays from deadlocking on player rows.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${externalIdentityLockKey(identity)}, 0))`);
      // Resolve the device only after the Firebase-account lock. A winning
      // concurrent merge may have moved this token while a replay was waiting.
      let [currentDevice] = await tx.select({ playerId: playerDevices.playerId }).from(playerDevices)
        .where(eq(playerDevices.tokenHash, tokenHash)).limit(1);
      if (!currentDevice) {
        const [legacy] = await tx.select({ playerId: players.id }).from(players)
          .where(eq(players.deviceTokenHash, tokenHash)).limit(1).for("update");
        if (legacy) {
          await tx.insert(playerDevices).values({ playerId: legacy.playerId, tokenHash }).onConflictDoNothing();
          currentDevice = legacy;
        }
      }
      if (!currentDevice) throw new PersistenceConflictError("Unknown device token.");
      const lockedPlayers = await tx.select({
        id: players.id,
        name: players.displayName,
        publicPlayerId: players.publicPlayerId,
        loadout: players.loadout,
        loadoutRevision: players.loadoutRevision,
        shell: players.baseShell,
        presets: players.presets,
        insertionPreference: players.insertionPreference,
        tutorialPhase: players.baseTutorialPhase,
        tutorialRevision: players.baseTutorialRevision,
      }).from(players).where(eq(players.id, currentDevice.playerId)).for("update");
      const sourcePlayer = lockedPlayers[0];
      if (!sourcePlayer) {
        // A replay after a merge resolves the moved device to the canonical
        // player before entering this transaction.
        throw new PersistenceConflictError("Unknown device token.");
      }
      const [sourceExternal] = await tx.select({ id: externalIdentities.id, issuer: externalIdentities.issuer, subject: externalIdentities.subject })
        .from(externalIdentities).where(eq(externalIdentities.playerId, sourcePlayer.id)).for("update");
      if (sourceExternal && (sourceExternal.issuer !== identity.issuer || sourceExternal.subject !== identity.subject)) {
        throw new PersistenceConflictError("This device is already linked to a different account.");
      }
      let [external] = await tx.select({ id: externalIdentities.id, playerId: externalIdentities.playerId })
        .from(externalIdentities)
        .where(and(eq(externalIdentities.issuer, identity.issuer), eq(externalIdentities.subject, identity.subject)))
        .for("update");
      let merged = false;
      let replayed = false;
      let targetPlayerId = sourcePlayer.id;
      if (!external) {
        [external] = await tx.insert(externalIdentities).values({
          playerId: sourcePlayer.id,
          issuer: identity.issuer,
          subject: identity.subject,
        }).returning({ id: externalIdentities.id, playerId: externalIdentities.playerId });
      } else if (external.playerId === sourcePlayer.id) {
        replayed = true;
        await tx.update(externalIdentities).set({ lastVerifiedAt: new Date() }).where(eq(externalIdentities.id, external.id));
      } else {
        targetPlayerId = external.playerId;
        const [targetPlayer] = await tx.select({
          id: players.id,
          name: players.displayName,
          publicPlayerId: players.publicPlayerId,
          loadout: players.loadout,
          loadoutRevision: players.loadoutRevision,
          shell: players.baseShell,
          presets: players.presets,
          insertionPreference: players.insertionPreference,
          tutorialPhase: players.baseTutorialPhase,
          tutorialRevision: players.baseTutorialRevision,
        }).from(players).where(eq(players.id, targetPlayerId)).for("update");
        if (!targetPlayer) throw new PersistenceConflictError("Linked account is unavailable.");
        await this.mergeGuestTransaction(tx, sourcePlayer, targetPlayer, identity);
        merged = true;
      }
      if (!merged) {
        // Linking the same canonical player promotes device-scoped guest
        // membership to account ownership without changing roster identity or
        // its membership version.
        await tx.update(partyMembers).set({ guestDeviceId: null }).where(eq(partyMembers.playerId, targetPlayerId));
        await tx.update(partyInviteAcceptances).set({ guestDeviceId: null, durable: true })
          .where(eq(partyInviteAcceptances.playerId, targetPlayerId));
      }
      await tx.insert(identityProviders).values({ externalIdentityId: external.id, provider: identity.provider })
        .onConflictDoUpdate({
          target: [identityProviders.externalIdentityId, identityProviders.provider],
          set: { lastVerifiedAt: new Date() },
        });
      return { targetPlayerId, merged, replayed };
    }));
    const account = await this.accountSummary(result.targetPlayerId);
    if (!account) throw new PersistenceConflictError("Linked account is unavailable.");
    return { account, merged: result.merged, replayed: result.replayed };
  }

  async createLinkedSession(identity: VerifiedExternalIdentity): Promise<RegisteredPlayer | null> {
    const token = randomBytes(16).toString("hex");
    return this.db.transaction(async (tx) => {
      // Serialize cross-device issuance with link and deletion for this
      // external account. The outcome is linear: either the account exists
      // and owns the new device, or no bearer is returned.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${externalIdentityLockKey(identity)}, 0))`);
      const [external] = await tx.select({ id: externalIdentities.id, playerId: externalIdentities.playerId })
        .from(externalIdentities)
        .where(and(eq(externalIdentities.issuer, identity.issuer), eq(externalIdentities.subject, identity.subject)))
        .for("update");
      if (!external) return null;
      const [player] = await tx.select({ id: players.id, publicPlayerId: players.publicPlayerId, name: players.displayName })
        .from(players).where(eq(players.id, external.playerId)).for("update");
      if (!player) return null;
      await tx.insert(playerDevices).values({ playerId: external.playerId, tokenHash: hashToken(token) });
      await tx.insert(identityProviders).values({ externalIdentityId: external.id, provider: identity.provider })
        .onConflictDoUpdate({ target: [identityProviders.externalIdentityId, identityProviders.provider], set: { lastVerifiedAt: new Date() } });
      return { playerId: player.id, publicPlayerId: player.publicPlayerId, name: player.name, token };
    });
  }

  async updateDisplayName(token: string, displayName: string): Promise<AccountSummary | null> {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    await this.db.update(players).set({ displayName }).where(eq(players.id, identity.playerId));
    return this.accountSummary(identity.playerId);
  }

  async updatePrivacy(token: string, discoverableByPublicId: boolean): Promise<AccountSummary | null> {
    const identity = await this.linkedIdentityForToken(token);
    if (!identity) return null;
    await this.db.update(players).set({ discoverableByPublicId }).where(eq(players.id, identity.playerId));
    return this.accountSummary(identity.playerId);
  }

  async deleteLinkedAccount(token: string, identity: VerifiedExternalIdentity): Promise<boolean> {
    const tokenHash = hashToken(token);
    return this.retryConcurrentPartyTransaction(() => this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${externalIdentityLockKey(identity)}, 0))`);
      let [device] = await tx.select({ playerId: playerDevices.playerId }).from(playerDevices)
        .where(eq(playerDevices.tokenHash, tokenHash)).limit(1);
      if (!device) {
        [device] = await tx.select({ playerId: players.id }).from(players)
          .where(eq(players.deviceTokenHash, tokenHash)).limit(1);
      }
      if (!device) return false;
      const [actor] = await tx.select({ id: players.id, publicPlayerId: players.publicPlayerId }).from(players)
        .where(eq(players.id, device.playerId)).for("update");
      if (!actor) return false;
      const [external] = await tx.select({ id: externalIdentities.id }).from(externalIdentities)
        .where(and(
          eq(externalIdentities.playerId, actor.id),
          eq(externalIdentities.issuer, identity.issuer),
          eq(externalIdentities.subject, identity.subject),
      )).for("update");
      if (!external) throw new PersistenceConflictError("Verified identity does not own this DotBot account.");
      const participantMatches = await tx.select({ matchId: matchParticipants.matchId }).from(matchParticipants)
        .where(eq(matchParticipants.playerId, actor.id));
      if (participantMatches.length > 0) {
        await tx.update(matchResults).set({
          // Historical summaries used public IDs. Once any participant invokes
          // deletion, retain only the non-identifying end reason.
          summary: sql`jsonb_build_object('reason', coalesce(${matchResults.summary}->>'reason', 'redacted'), 'redacted', true)`,
        }).where(inArray(matchResults.id, participantMatches.map((row) => row.matchId)));
      }
      await this.removePartyMembershipForDeletion(tx, actor.id);
      // Deletion retires the current public ID as well as every ID from prior
      // guest merges. Share the allocator's candidate lock so an old or new
      // writer cannot slip the ID into a fresh row between delete and tombstone.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dotbot-public-player-id:${actor.publicPlayerId}`}, 0))`);
      await tx.insert(playerAliases).values({
        sourcePlayerId: actor.id,
        sourcePublicPlayerId: actor.publicPlayerId,
        targetPlayerId: null,
      }).onConflictDoUpdate({
        target: playerAliases.sourcePlayerId,
        set: { sourcePublicPlayerId: actor.publicPlayerId, targetPlayerId: null },
      });
      const deleted = await tx.delete(players).where(eq(players.id, actor.id)).returning({ id: players.id });
      return deleted.length === 1;
    }));
  }

  async findPublicPlayer(token: string, requestedId: string): Promise<PublicPlayer | null> {
    const actor = await this.linkedIdentityForToken(token);
    const publicPlayerId = normalizePublicPlayerId(requestedId);
    if (!actor || !publicPlayerId) return null;
    const [target] = await this.db.select({
      playerId: players.id,
      publicPlayerId: players.publicPlayerId,
      displayName: players.displayName,
    }).from(players)
      .innerJoin(externalIdentities, eq(externalIdentities.playerId, players.id))
      .where(and(eq(players.publicPlayerId, publicPlayerId), eq(players.discoverableByPublicId, true)))
      .limit(1);
    if (!target || target.playerId === actor.playerId) return null;
    const [blocked] = await this.db.select({ blocker: playerBlocks.blockerPlayerId }).from(playerBlocks)
      .where(or(
        and(eq(playerBlocks.blockerPlayerId, actor.playerId), eq(playerBlocks.blockedPlayerId, target.playerId)),
        and(eq(playerBlocks.blockerPlayerId, target.playerId), eq(playerBlocks.blockedPlayerId, actor.playerId)),
      )).limit(1);
    return blocked ? null : { publicPlayerId: target.publicPlayerId, displayName: target.displayName };
  }

  async listFriends(token: string): Promise<FriendEntry[] | null> {
    const actor = await this.linkedIdentityForToken(token);
    if (!actor) return null;
    const rows = await this.db.select({
      low: friendships.playerLowId,
      high: friendships.playerHighId,
      requestedBy: friendships.requestedById,
      status: friendships.status,
    }).from(friendships).where(or(eq(friendships.playerLowId, actor.playerId), eq(friendships.playerHighId, actor.playerId)));
    const blocks = await this.db.select({ blocker: playerBlocks.blockerPlayerId, blocked: playerBlocks.blockedPlayerId })
      .from(playerBlocks).where(or(eq(playerBlocks.blockerPlayerId, actor.playerId), eq(playerBlocks.blockedPlayerId, actor.playerId)));
    const blockedIds = new Set(blocks.map((block) => block.blocker === actor.playerId ? block.blocked : block.blocker));
    const visibleRows = rows.filter((row) => !blockedIds.has(row.low === actor.playerId ? row.high : row.low));
    const otherIds = visibleRows.map((row) => row.low === actor.playerId ? row.high : row.low);
    if (otherIds.length === 0) return [];
    const people = await this.db.select({ id: players.id, publicPlayerId: players.publicPlayerId, displayName: players.displayName })
      .from(players).where(inArray(players.id, otherIds));
    const personById = new Map(people.map((person) => [person.id, person]));
    return visibleRows.flatMap((row) => {
      const other = personById.get(row.low === actor.playerId ? row.high : row.low);
      if (!other) return [];
      const status: FriendEntry["status"] = row.status === "accepted"
        ? "friends"
        : row.requestedBy === actor.playerId ? "outgoing" : "incoming";
      return [{ publicPlayerId: other.publicPlayerId, displayName: other.displayName, status }];
    });
  }

  async requestFriend(token: string, requestedId: string): Promise<FriendEntry | null> {
    const actor = await this.linkedIdentityForToken(token);
    const target = await this.findPublicPlayer(token, requestedId);
    if (!actor || !target) return null;
    const [targetRow] = await this.db.select({ id: players.id }).from(players)
      .where(eq(players.publicPlayerId, target.publicPlayerId)).limit(1);
    if (!targetRow) return null;
    const [low, high] = canonicalPair(actor.playerId, targetRow.id);
    const [friendship] = await this.db.insert(friendships)
      .values({ playerLowId: low, playerHighId: high, requestedById: actor.playerId, status: "pending" })
      .onConflictDoUpdate({
        target: [friendships.playerLowId, friendships.playerHighId],
        set: {
          status: sql`case when ${friendships.status} = 'accepted' or ${friendships.requestedById} <> ${actor.playerId}::uuid then 'accepted' else 'pending' end`,
          acceptedAt: sql`case when ${friendships.status} = 'accepted' then ${friendships.acceptedAt} when ${friendships.requestedById} <> ${actor.playerId}::uuid then now() else null end`,
        },
      })
      .returning({ status: friendships.status, requestedBy: friendships.requestedById });
    return { ...target, status: friendship.status === "accepted" ? "friends" : friendship.requestedBy === actor.playerId ? "outgoing" : "incoming" };
  }

  async acceptFriend(token: string, requestedId: string): Promise<FriendEntry | null> {
    const actor = await this.linkedIdentityForToken(token);
    const publicPlayerId = normalizePublicPlayerId(requestedId);
    if (!actor || !publicPlayerId) return null;
    const [target] = await this.db.select({ id: players.id, publicPlayerId: players.publicPlayerId, displayName: players.displayName })
      .from(players).where(eq(players.publicPlayerId, publicPlayerId)).limit(1);
    if (!target) return null;
    const [low, high] = canonicalPair(actor.playerId, target.id);
    const updated = await this.db.update(friendships).set({ status: "accepted", acceptedAt: new Date() })
      .where(and(
        eq(friendships.playerLowId, low),
        eq(friendships.playerHighId, high),
        eq(friendships.status, "pending"),
        eq(friendships.requestedById, target.id),
      )).returning({ low: friendships.playerLowId });
    if (updated.length === 1) return { publicPlayerId: target.publicPlayerId, displayName: target.displayName, status: "friends" };
    const [accepted] = await this.db.select({ status: friendships.status }).from(friendships)
      .where(and(eq(friendships.playerLowId, low), eq(friendships.playerHighId, high), eq(friendships.status, "accepted")))
      .limit(1);
    return accepted ? { publicPlayerId: target.publicPlayerId, displayName: target.displayName, status: "friends" } : null;
  }

  async createPartyInvite(token: string): Promise<{ code: string; expiresAt: string } | null> {
    const actor = await this.linkedIdentityForToken(token);
    if (!actor) return null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
      const inserted = await this.db.insert(partyInvites).values({ ownerPlayerId: actor.playerId, tokenHash: hashToken(code), expiresAt })
        .onConflictDoNothing().returning({ id: partyInvites.id });
      if (inserted.length === 1) return { code, expiresAt: expiresAt.toISOString() };
    }
    throw new Error("Could not allocate a party invite.");
  }

  async acceptPartyInvite(token: string, code: string): Promise<PartyInviteAcceptance | null> {
    const actor = await this.helloPlayer(token);
    if (!actor) return null;
    return this.db.transaction(async (tx) => {
      const [invite] = await tx.select({
        id: partyInvites.id,
        ownerPlayerId: partyInvites.ownerPlayerId,
        expiresAt: partyInvites.expiresAt,
        revoked: partyInvites.revoked,
      }).from(partyInvites).where(eq(partyInvites.tokenHash, hashToken(code))).for("update");
      if (!invite || invite.revoked || invite.expiresAt <= new Date()) return null;
      if (invite.ownerPlayerId === actor.playerId) return null;
      const [inviter] = await tx.select({ publicPlayerId: players.publicPlayerId, displayName: players.displayName })
        .from(players).where(eq(players.id, invite.ownerPlayerId)).limit(1);
      if (!inviter) return null;
      const [linked] = await tx.select({ id: externalIdentities.id }).from(externalIdentities)
        .where(eq(externalIdentities.playerId, actor.playerId)).limit(1);
      if (linked) {
        await tx.insert(partyInviteAcceptances).values({ inviteId: invite.id, playerId: actor.playerId }).onConflictDoNothing();
      }
      return { inviter, durable: Boolean(linked), expiresAt: invite.expiresAt.toISOString() };
    });
  }

  async getParty(token: string): Promise<PartySummary | null> {
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      const membership = await this.partyMembershipForActor(tx, actor, false);
      return membership ? this.partySummaryById(tx, membership.partyId, actor.playerId) : null;
    });
  }

  async createDurablePartyInvite(token: string): Promise<DurablePartyInvite | null> {
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      if (!actor.linked) throw new PartyConflictError("party_link_required", "Link an account to create a durable party invitation.");
      let membership = await this.partyMembershipForActor(tx, actor);
      if (!membership) {
        const [created] = await tx.insert(parties).values({
          matchmakingKey: `party-${randomBytes(16).toString("hex")}`,
          leaderPlayerId: actor.playerId,
        }).returning({ id: parties.id });
        await tx.insert(partyMembers).values({ partyId: created.id, playerId: actor.playerId });
        membership = { partyId: created.id, guestDeviceId: null };
      }
      const party = await this.lockParty(tx, membership.partyId);
      if (!party || party.leaderPlayerId !== actor.playerId) {
        throw new PartyConflictError("party_leader_required", "Only the linked party leader can create an invitation.");
      }
      if (!await this.isPartyMember(tx, party.id, actor.playerId)) {
        throw new PartyConflictError("party_membership_conflict", "Party membership changed before the invitation was created.");
      }
      await this.assertPartyNotQueued(tx, party.id);
      const members = await this.readPartyMembers(tx, party.id);
      if (members.length >= 3) throw new PartyConflictError("party_full", "A three-player party cannot create another invitation.");
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = randomBytes(24).toString("base64url");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
        const inserted = await tx.insert(partyInvites).values({
          ownerPlayerId: actor.playerId,
          partyId: party.id,
          rosterVersion: party.version,
          tokenHash: hashToken(code),
          expiresAt,
        }).onConflictDoNothing().returning({ id: partyInvites.id });
        if (inserted.length === 1) {
          return {
            code,
            expiresAt: expiresAt.toISOString(),
            party: await this.partySummaryById(tx, party.id, actor.playerId),
          };
        }
      }
      throw new Error("Could not allocate a durable party invite.");
    });
  }

  async revokeDurablePartyInvites(token: string): Promise<PartySummary | null> {
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      if (!actor.linked) throw new PartyConflictError("party_link_required", "Link an account to revoke durable party invitations.");
      const membership = await this.partyMembershipForActor(tx, actor);
      if (!membership) return null;
      const party = await this.lockParty(tx, membership.partyId);
      if (!party || party.leaderPlayerId !== actor.playerId) {
        throw new PartyConflictError("party_leader_required", "Only the linked party leader can revoke invitations.");
      }
      if (!await this.isPartyMember(tx, party.id, actor.playerId)) return null;
      await tx.update(partyInvites).set({ revoked: true }).where(eq(partyInvites.partyId, party.id));
      return this.partySummaryById(tx, party.id, actor.playerId);
    });
  }

  async acceptDurablePartyInvite(token: string, code: string): Promise<PartyInviteAcceptance | null> {
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      const current = await this.partyMembershipForActor(tx, actor);
      const tokenHash = hashToken(code);
      const [inviteHint] = await tx.select({ partyId: partyInvites.partyId })
        .from(partyInvites).where(eq(partyInvites.tokenHash, tokenHash)).limit(1);
      if (!inviteHint?.partyId) return null;
      if (current && current.partyId !== inviteHint.partyId) {
        throw new PartyConflictError("party_membership_conflict", "Leave the current party before accepting another invitation.");
      }
      const party = await this.lockParty(tx, inviteHint.partyId);
      if (!party) return null;
      const currentPartyId = (await this.partyMembershipForActor(tx, actor))?.partyId ?? null;
      if (currentPartyId && currentPartyId !== party.id) {
        throw new PartyConflictError("party_membership_conflict", "Leave the current party before accepting another invitation.");
      }
      const [invite] = await tx.select({
        id: partyInvites.id,
        ownerPlayerId: partyInvites.ownerPlayerId,
        partyId: partyInvites.partyId,
        expiresAt: partyInvites.expiresAt,
        revoked: partyInvites.revoked,
      }).from(partyInvites).where(and(eq(partyInvites.tokenHash, tokenHash), eq(partyInvites.partyId, party.id))).for("update");
      if (!invite?.partyId || invite.revoked || invite.expiresAt <= new Date()) return null;
      const [inviter] = await tx.select({ publicPlayerId: players.publicPlayerId, displayName: players.displayName })
        .from(players).where(eq(players.id, invite.ownerPlayerId)).limit(1);
      if (!inviter) return null;
      if (currentPartyId === party.id) {
        const acceptance = tx.insert(partyInviteAcceptances).values({
          inviteId: invite.id,
          playerId: actor.playerId,
          guestDeviceId: actor.linked ? null : actor.deviceId,
          durable: actor.linked,
        });
        if (actor.linked) {
          await acceptance.onConflictDoUpdate({
            target: [partyInviteAcceptances.inviteId, partyInviteAcceptances.playerId],
            set: { guestDeviceId: null, durable: true },
          });
        } else {
          await acceptance.onConflictDoNothing();
        }
        return {
          inviter,
          durable: actor.linked,
          expiresAt: invite.expiresAt.toISOString(),
          party: await this.partySummaryById(tx, party.id, actor.playerId),
          replayed: true,
        };
      }
      await this.assertPlayerNotQueuedSolo(tx, actor.playerId);
      await this.assertPartyNotQueued(tx, party.id);
      const members = await this.readPartyMembers(tx, party.id);
      if (members.length >= 3) throw new PartyConflictError("party_full", "That party already has three members.");
      await tx.insert(partyMembers).values({
        partyId: party.id,
        playerId: actor.playerId,
        guestDeviceId: actor.linked ? null : actor.deviceId,
      });
      await tx.update(parties).set({ version: party.version + 1, updatedAt: new Date() }).where(eq(parties.id, party.id));
      const acceptance = tx.insert(partyInviteAcceptances).values({
        inviteId: invite.id,
        playerId: actor.playerId,
        guestDeviceId: actor.linked ? null : actor.deviceId,
        durable: actor.linked,
      });
      if (actor.linked) {
        await acceptance.onConflictDoUpdate({
          target: [partyInviteAcceptances.inviteId, partyInviteAcceptances.playerId],
          set: { guestDeviceId: null, durable: true },
        });
      } else {
        await acceptance.onConflictDoNothing();
      }
      return {
        inviter,
        durable: actor.linked,
        expiresAt: invite.expiresAt.toISOString(),
        party: await this.partySummaryById(tx, party.id, actor.playerId),
        replayed: false,
      };
    });
  }

  async leaveParty(token: string, expectedVersion?: number): Promise<PartySummary | null> {
    return this.retryConcurrentPartyTransaction(() => this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      const membership = await this.partyMembershipForActor(tx, actor);
      if (!membership) return null;
      const [authorityHint] = await tx.select({ leaderPlayerId: parties.leaderPlayerId }).from(parties)
        .where(eq(parties.id, membership.partyId)).limit(1);
      if (authorityHint?.leaderPlayerId === actor.playerId) {
        // A leader leave may write a successor FK. Lock every possible
        // successor before the party so another member cannot hold its player
        // row while waiting on the party row in the opposite order.
        await this.lockPotentialPartySuccessors(tx, membership.partyId, actor.playerId);
      }
      const party = await this.lockParty(tx, membership.partyId);
      if (!party) return null;
      if ((await this.partyMembershipForActor(tx, actor))?.partyId !== party.id) return null;
      assertPartyVersion(party.version, expectedVersion);
      await this.assertPartyNotQueued(tx, party.id);
      await this.removePartyMember(tx, party, actor.playerId);
      return null;
    }));
  }

  async disbandParty(token: string, expectedVersion?: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return false;
      const membership = await this.partyMembershipForActor(tx, actor);
      if (!membership) return false;
      const party = await this.lockParty(tx, membership.partyId);
      if (!party) return false;
      if ((await this.partyMembershipForActor(tx, actor))?.partyId !== party.id) return false;
      assertPartyVersion(party.version, expectedVersion);
      if (party.leaderPlayerId !== actor.playerId) throw new PartyConflictError("party_leader_required", "Only the party leader can disband the party.");
      await this.assertPartyNotQueued(tx, party.id);
      await tx.delete(parties).where(eq(parties.id, party.id));
      return true;
    });
  }

  async transferPartyLeader(token: string, requestedId: string, expectedVersion?: number): Promise<PartySummary | null> {
    const normalized = normalizePublicPlayerId(requestedId);
    if (!normalized) return null;
    return this.retryConcurrentPartyTransaction(() => this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      const membershipHint = await this.partyMembershipForActor(tx, actor);
      if (!membershipHint) return null;
      const [authorityHint] = await tx.select({ leaderPlayerId: parties.leaderPlayerId }).from(parties)
        .where(eq(parties.id, membershipHint.partyId)).limit(1);
      if (!authorityHint) return null;
      if (authorityHint.leaderPlayerId !== actor.playerId) {
        throw new PartyConflictError("party_leader_required", "Only the party leader can transfer leadership.");
      }
      // Lock the proposed leader before the party row. Updating the leader FK
      // otherwise waits on a concurrent operation by that player while that
      // operation waits on this party row.
      const [target] = await tx.select({ id: players.id }).from(players)
        .innerJoin(partyMembers, and(eq(partyMembers.playerId, players.id), eq(partyMembers.partyId, membershipHint.partyId)))
        .where(eq(players.publicPlayerId, normalized))
        .for("update", { of: players });
      if (!target) return null;
      const party = await this.lockParty(tx, membershipHint.partyId);
      if (!party) return null;
      if ((await this.partyMembershipForActor(tx, actor))?.partyId !== party.id) return null;
      assertPartyVersion(party.version, expectedVersion);
      if (party.leaderPlayerId !== actor.playerId) throw new PartyConflictError("party_leader_required", "Only the party leader can transfer leadership.");
      await this.assertPartyNotQueued(tx, party.id);
      if (!await this.isPartyMember(tx, party.id, target.id)) return null;
      if (target.id !== actor.playerId) {
        await tx.update(parties).set({ leaderPlayerId: target.id, version: party.version + 1, updatedAt: new Date() })
          .where(eq(parties.id, party.id));
      }
      return this.partySummaryById(tx, party.id, actor.playerId);
    }));
  }

  async claimPartyQueue(token: string, input: { requestId: string; buildId: string; region: string }): Promise<PartyQueueClaim> {
    if (!isUuid(input.requestId) || !safeInternalMetadata(input.buildId, 64) || !safeInternalMetadata(input.region, 64)) {
      throw new PartyConflictError("party_membership_conflict", "Invalid party queue claim metadata.");
    }
    return this.retryConcurrentPartyTransaction(() => this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) throw new PartyConflictError("party_membership_conflict", "Unknown device token.");
      const membership = await this.partyMembershipForActor(tx, actor);
      if (!membership) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dotbot-solo-party:${actor.playerId}`}, 0))`);
        const [existing] = await tx.select().from(partyQueueClaims).where(and(
          isNull(partyQueueClaims.partyId),
          eq(partyQueueClaims.requestingPlayerId, actor.playerId),
          inArray(partyQueueClaims.status, ["active", "cancelling"]),
          gt(partyQueueClaims.expiresAt, new Date()),
        )).for("update");
        if (existing) {
          if (existing.status === "cancelling") throw new PartyConflictError("party_queued", "Quick-play cancellation is still reconciling.");
          assertQueueCompatibility(existing, input);
          return this.soloQueueClaim(existing, actor);
        }
        const loadoutSnapshots = await this.lockQueueLoadoutSnapshots(tx, [actor.playerId]);
        await tx.insert(partyQueueClaims).values({
          id: input.requestId,
          requestingPlayerId: actor.playerId,
          partyVersion: 1,
          buildId: input.buildId,
          region: input.region,
          loadoutSnapshots,
          expiresAt: new Date(Date.now() + 6 * 60 * 60_000),
        });
        return this.soloQueueClaim({
          id: input.requestId,
          partyId: null,
          requestingPlayerId: actor.playerId,
          partyVersion: 1,
          buildId: input.buildId,
          region: input.region,
          loadoutSnapshots,
          status: "active",
          startedMatchId: null,
          expiresAt: new Date(Date.now() + 6 * 60 * 60_000),
        }, actor);
      }
      const party = await this.lockParty(tx, membership.partyId);
      if (!party) throw new PartyConflictError("party_membership_conflict", "Party no longer exists.");
      if ((await this.partyMembershipForActor(tx, actor))?.partyId !== party.id) {
        throw new PartyConflictError("party_membership_conflict", "Party membership changed before queue entry.");
      }
      const [existing] = await tx.select().from(partyQueueClaims).where(and(
        eq(partyQueueClaims.partyId, party.id),
        inArray(partyQueueClaims.status, ["active", "cancelling"]),
        gt(partyQueueClaims.expiresAt, new Date()),
      )).for("update");
      if (existing) {
        if (existing.status === "cancelling") throw new PartyConflictError("party_queued", "Quick-play cancellation is still reconciling.");
        assertQueueCompatibility(existing, input);
        if (existing.partyVersion !== party.version) {
          throw new PartyConflictError("party_version_stale", "The queued party roster is stale. Cancel before retrying.");
        }
        return this.partyQueueClaimById(tx, existing.id, party, actor.playerId, input.buildId, input.region);
      }
      if (party.leaderPlayerId !== actor.playerId) throw new PartyConflictError("party_leader_required", "Only the party leader can start queueing.");
      const roster = await this.readPartyMembers(tx, party.id);
      const loadoutSnapshots = await this.lockQueueLoadoutSnapshots(tx, roster.map((member) => member.playerId));
      await tx.insert(partyQueueClaims).values({
        id: input.requestId,
        partyId: party.id,
        requestingPlayerId: actor.playerId,
        partyVersion: party.version,
        buildId: input.buildId,
        region: input.region,
        loadoutSnapshots,
        expiresAt: new Date(Date.now() + 6 * 60 * 60_000),
      });
      return this.partyQueueClaimById(tx, input.requestId, party, actor.playerId, input.buildId, input.region);
    }));
  }

  async getPartyQueueStatus(token: string, claimId: string): Promise<PartyQueueClaim | null> {
    if (!isUuid(claimId)) return null;
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      const [claim] = await tx.select().from(partyQueueClaims).where(eq(partyQueueClaims.id, claimId)).limit(1);
      if (!claim) return null;
      const membership = await this.partyMembershipForActor(tx, actor, false);
      if (claim.partyId) {
        if (membership?.partyId !== claim.partyId) return null;
        const party = await this.lockParty(tx, claim.partyId);
        if (!party || !await this.isPartyMember(tx, party.id, actor.playerId)) return null;
        return this.partyQueueClaimByRecord(claim, party, actor.playerId);
      }
      return claim.requestingPlayerId === actor.playerId ? this.soloQueueClaim(claim, actor) : null;
    });
  }

  async cancelPartyQueue(token: string, claimId: string): Promise<PartyQueueClaim | null> {
    if (!isUuid(claimId)) return null;
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return null;
      const membership = await this.partyMembershipForActor(tx, actor);
      if (membership) {
        const party = await this.lockParty(tx, membership.partyId);
        if (!party) return null;
        if ((await this.partyMembershipForActor(tx, actor))?.partyId !== party.id) return null;
        const [claim] = await tx.select().from(partyQueueClaims).where(eq(partyQueueClaims.id, claimId)).for("update");
        if (!claim || claim.partyId !== party.id || !["active", "cancelling", "cancelled"].includes(claim.status)) return null;
        const fenced = claim.status === "active"
          ? (await tx.update(partyQueueClaims).set({ status: "cancelling", updatedAt: new Date() })
            .where(and(eq(partyQueueClaims.id, claim.id), eq(partyQueueClaims.status, "active")))
            .returning())[0]
          : claim;
        return fenced ? this.partyQueueClaimByRecord(fenced, party, actor.playerId) : null;
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dotbot-solo-party:${actor.playerId}`}, 0))`);
      const [claim] = await tx.select().from(partyQueueClaims).where(eq(partyQueueClaims.id, claimId)).for("update");
      if (!claim || claim.partyId !== null || claim.requestingPlayerId !== actor.playerId
        || !["active", "cancelling", "cancelled"].includes(claim.status)) return null;
      const fenced = claim.status === "active"
        ? (await tx.update(partyQueueClaims).set({ status: "cancelling", updatedAt: new Date() })
          .where(and(eq(partyQueueClaims.id, claim.id), eq(partyQueueClaims.status, "active")))
          .returning())[0]
        : claim;
      return fenced ? this.soloQueueClaim(fenced, actor) : null;
    });
  }

  async completePartyQueueCancellation(token: string, claimId: string): Promise<boolean> {
    if (!isUuid(claimId)) return false;
    return this.db.transaction(async (tx) => {
      const actor = await this.partyActor(tx, token);
      if (!actor) return false;
      const membership = await this.partyMembershipForActor(tx, actor);
      if (membership) {
        const party = await this.lockParty(tx, membership.partyId);
        if (!party) return false;
        if ((await this.partyMembershipForActor(tx, actor))?.partyId !== party.id) return false;
      } else {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dotbot-solo-party:${actor.playerId}`}, 0))`);
      }
      const [claim] = await tx.select().from(partyQueueClaims).where(eq(partyQueueClaims.id, claimId)).for("update");
      if (!claim || (claim.partyId ? claim.partyId !== membership?.partyId : claim.requestingPlayerId !== actor.playerId)) return false;
      if (claim.status === "cancelled") return true;
      if (claim.status !== "cancelling") return false;
      const updated = await tx.update(partyQueueClaims).set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(partyQueueClaims.id, claim.id), eq(partyQueueClaims.status, "cancelling")))
        .returning({ id: partyQueueClaims.id });
      return updated.length === 1;
    });
  }

  async getProfile(token: string): Promise<PlayerProfile | null> {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    const stash = await this.db.select({ itemType: stashItems.itemType, qty: sql<number>`sum(${stashItems.qty})::int` })
      .from(stashItems)
      .where(eq(stashItems.playerId, identity.playerId))
      .groupBy(stashItems.itemType);
    const learned = await this.db.select({ blueprintId: learnedBlueprints.blueprintId })
      .from(learnedBlueprints)
      .where(eq(learnedBlueprints.playerId, identity.playerId));
    const rows = await this.db.select({
      roomCode: matchResults.roomCode,
      outcome: matchParticipants.outcome,
      manifest: matchParticipants.extractedManifest,
      endedAt: matchResults.endedAt,
    }).from(matchParticipants)
      .innerJoin(matchResults, eq(matchParticipants.matchId, matchResults.id))
      .where(eq(matchParticipants.playerId, identity.playerId))
      .orderBy(desc(matchResults.startedAt))
      .limit(10);
    return {
      name: identity.name,
      stash: stash.map((row) => ({ itemType: row.itemType as WireItemCode, qty: Number(row.qty) })),
      learnedBlueprints: learned.map((row) => row.blueprintId),
      recentManifests: rows.map((row) => {
        const manifest = isRunManifest(row.manifest) ? row.manifest : null;
        return {
          roomCode: row.roomCode,
          outcome: row.outcome,
          keptItems: manifest?.keptItems ?? [],
          lostItems: manifest?.lostItems ?? [],
          learnedBlueprints: manifest?.learnedBlueprints ?? [],
          endedAt: row.endedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  async getBase(token: string) {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    await this.ensureBaseLayout(identity.playerId);
    const [layout, upgrades, stash, learned, player, activeContracts] = await Promise.all([
      this.db.select({ slotId: baseLayouts.slotId, objectKind: baseLayouts.objectKind })
        .from(baseLayouts).where(eq(baseLayouts.playerId, identity.playerId)),
      this.db.select({ upgradeId: baseUpgrades.upgradeId })
        .from(baseUpgrades).where(eq(baseUpgrades.playerId, identity.playerId)),
      this.db.select({ itemType: stashItems.itemType, qty: sql<number>`sum(${stashItems.qty})::int` })
        .from(stashItems).where(eq(stashItems.playerId, identity.playerId)).groupBy(stashItems.itemType),
      this.db.select({ blueprintId: learnedBlueprints.blueprintId })
        .from(learnedBlueprints).where(eq(learnedBlueprints.playerId, identity.playerId)),
      this.db.select({
        id: players.id,
        loadout: players.loadout,
        baseShell: players.baseShell,
        presets: players.presets,
        insertionPreference: players.insertionPreference,
        contractReroll: players.contractReroll,
        baseTutorialPhase: players.baseTutorialPhase,
        baseTutorialRevision: players.baseTutorialRevision,
      })
        .from(players).where(eq(players.id, identity.playerId)).limit(1),
      this.db.select({ contract: contractRows.contract }).from(contractRows)
        .where(and(eq(contractRows.playerId, identity.playerId), eq(contractRows.status, "active")))
        .orderBy(contractRows.acceptedAt),
    ]);
    const active = activeContracts.map((row) => row.contract);
    const offers = generateContractOffers(downtownMap, identity.playerId, contractDayStamp(), player[0]?.contractReroll ?? 0)
      .filter((offer) => !active.some((contract) => contract.id === offer.id));
    return {
      tutorial: {
        phase: player[0]?.baseTutorialPhase ?? "complete",
        revision: player[0]?.baseTutorialRevision ?? 4,
      },
      shell: player[0]?.baseShell ?? DEFAULT_BASE_SHELL,
      upgrades: upgrades.map((row) => row.upgradeId),
      layout: Object.fromEntries(layout.map((row) => [row.slotId, row.objectKind])) as BaseLayout,
      stash: stash.map((row) => ({ itemType: row.itemType as WireItemCode, qty: Number(row.qty) })),
      learnedBlueprints: learned.map((row) => row.blueprintId),
      loadout: player[0]?.loadout ?? [],
      stashCapacity: layout.filter((row) => row.objectKind === "locker").length * 20,
      presets: player[0]?.presets ?? [],
      insertionPreference: player[0]?.insertionPreference ?? null,
      contractOffers: offers,
      activeContracts: active,
    };
  }

  async getBaseTutorialForPlayer(playerId: string): Promise<BaseTutorialState | null> {
    playerId = await this.canonicalPlayerId(playerId);
    const [player] = await this.db.select({
      phase: players.baseTutorialPhase,
      revision: players.baseTutorialRevision,
    }).from(players).where(eq(players.id, playerId)).limit(1);
    return player ? { phase: player.phase, revision: player.revision } : null;
  }

  async advanceBaseTutorial(token: string, action: BaseTutorialAction, revision: number) {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    const result = await this.db.transaction(async (tx) => {
      const [player] = await tx.select({
        id: players.id,
        phase: players.baseTutorialPhase,
        revision: players.baseTutorialRevision,
      }).from(players).where(eq(players.id, identity.playerId)).for("update");
      if (!player) return null;
      const current: BaseTutorialState = { phase: player.phase, revision: player.revision };
      const advanced = advanceTutorialState(current, action);
      if (advanced.changed && revision !== current.revision) throw new Error("Tutorial revision is stale.");
      if (advanced.changed) {
        await tx.update(players).set({
          baseTutorialPhase: advanced.state.phase,
          baseTutorialRevision: advanced.state.revision,
        }).where(eq(players.id, player.id));
      }
      return player.id;
    });
    if (!result) return null;
    return this.getBase(token);
  }

  async setBaseShell(token: string, shell: BaseShellId) {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    const playerId = await this.db.transaction(async (tx) => {
      const [player] = await tx.select({ id: players.id }).from(players)
        .where(eq(players.id, identity.playerId)).for("update");
      if (!player) return null;
      const [draftingTable] = await tx.select({ slotId: baseLayouts.slotId }).from(baseLayouts)
        .where(and(eq(baseLayouts.playerId, player.id), eq(baseLayouts.objectKind, "draftingTable")));
      if (!draftingTable) throw new Error("REQUIRES DRAFTING TABLE");
      await tx.update(players).set({ baseShell: shell }).where(eq(players.id, player.id));
      return player.id;
    });
    if (!playerId) return null;
    return this.getBase(token);
  }

  async saveBaseLayout(token: string, layout: BaseLayout): Promise<BaseLayout | null> {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    await this.db.transaction(async (tx) => {
      const upgrades = await tx.select({ upgradeId: baseUpgrades.upgradeId })
        .from(baseUpgrades).where(eq(baseUpgrades.playerId, identity.playerId)).for("update");
      validateBaseLayout(layout, { expanded: upgrades.some((row) => row.upgradeId === SECOND_FLOOR_UPGRADE_ID) });
      await tx.delete(baseLayouts).where(eq(baseLayouts.playerId, identity.playerId));
      const rows = layoutRows(identity.playerId, layout);
      if (rows.length > 0) await tx.insert(baseLayouts).values(rows);
    });
    return layout;
  }

  async setLoadout(token: string, loadout: WireItemCode[]) {
    const identity = await this.helloPlayer(token);
    if (!identity) throw new Error("Unknown device token.");
    await this.db.transaction(async (tx) => {
      const [player] = await tx.select({ id: players.id, loadout: players.loadout })
        .from(players).where(eq(players.id, identity.playerId)).limit(1).for("update");
      if (!player) throw new Error("Unknown device token.");
      await this.assertPlayerLoadoutUnlocked(tx, player.id);

      if (player.loadout.length > 0) {
        await tx.insert(stashItems).values(player.loadout.map((itemType) => ({ playerId: player.id, itemType, qty: 1 })));
      }
      for (const itemType of loadout) {
        const [row] = await tx.select({ id: stashItems.id, qty: stashItems.qty })
          .from(stashItems)
          .where(and(eq(stashItems.playerId, player.id), eq(stashItems.itemType, itemType)))
          .orderBy(stashItems.acquiredAt)
          .limit(1)
          .for("update");
        if (!row) throw new Error(`STASH does not contain ${itemType}.`);
        if (row.qty > 1) await tx.update(stashItems).set({ qty: row.qty - 1 }).where(eq(stashItems.id, row.id));
        else await tx.delete(stashItems).where(eq(stashItems.id, row.id));
      }
      await tx.update(players).set({ loadout, loadoutRevision: sql`${players.loadoutRevision} + 1` }).where(eq(players.id, player.id));
    });
    return this.getBase(token);
  }

  async consumeLoadout(playerId: string): Promise<WireItemCode[]> {
    return this.db.transaction(async (tx) => {
      const [alias] = await tx.select({ targetPlayerId: playerAliases.targetPlayerId }).from(playerAliases)
        .where(eq(playerAliases.sourcePlayerId, playerId)).limit(1);
      playerId = alias?.targetPlayerId ?? playerId;
      const [player] = await tx.select({ loadout: players.loadout })
        .from(players).where(eq(players.id, playerId)).limit(1).for("update");
      const loadout = player?.loadout ?? [];
      if (player) await this.assertPlayerLoadoutUnlocked(tx, playerId);
      if (player && loadout.length > 0) await tx.update(players)
        .set({ loadout: [], loadoutRevision: sql`${players.loadoutRevision} + 1` }).where(eq(players.id, playerId));
      return loadout;
    });
  }

  async getMatchIntelObjects(playerId: string) {
    playerId = await this.canonicalPlayerId(playerId);
    const rows = await this.db.select({ objectKind: baseLayouts.objectKind })
      .from(baseLayouts)
      .where(eq(baseLayouts.playerId, playerId));
    return rows
      .map((row) => row.objectKind)
      .filter((kind): kind is "listeningPost" | "signalMast" => kind === "listeningPost" || kind === "signalMast");
  }

  async fabricate(token: string, recipeId: string, slotId?: string) {
    const recipe = recipeById(recipeId);
    if (!recipe) throw new Error("Unknown fabrication recipe.");
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    const fabrication = await this.db.transaction(async (tx) => {
      const [player] = await tx.select({ id: players.id })
        .from(players).where(eq(players.id, identity.playerId)).limit(1).for("update");
      if (!player) return null;

      const layoutRowsLocked = await tx.select({ slotId: baseLayouts.slotId, objectKind: baseLayouts.objectKind })
        .from(baseLayouts).where(eq(baseLayouts.playerId, player.id)).for("update");
      const layout = Object.fromEntries(layoutRowsLocked.map((row) => [row.slotId, row.objectKind])) as BaseLayout;
      const ownedUpgrades = await tx.select({ upgradeId: baseUpgrades.upgradeId })
        .from(baseUpgrades).where(eq(baseUpgrades.playerId, player.id)).for("update");
      const expanded = ownedUpgrades.some((row) => row.upgradeId === SECOND_FLOOR_UPGRADE_ID);

      if (recipe.output.kind === "expansion") {
        const upgradeId = recipe.output.upgradeId;
        if (ownedUpgrades.some((row) => row.upgradeId === upgradeId)) throw new Error("EXPANSION ALREADY OWNED.");
      }

      if (recipe.requiresBlueprint) {
        const [learned] = await tx.select({ blueprintId: learnedBlueprints.blueprintId })
          .from(learnedBlueprints)
          .where(and(eq(learnedBlueprints.playerId, player.id), eq(learnedBlueprints.blueprintId, recipe.requiresBlueprint)))
          .limit(1);
        if (!learned) throw new Error(`REQUIRES BLUEPRINT: ${recipe.requiresBlueprint}`);
      }
      if (recipe.requiresObject && !Object.values(layout).includes(recipe.requiresObject)) {
        throw new Error(`REQUIRES: ${recipe.requiresObject === "repairBench" ? "REPAIR BENCH" : recipe.requiresObject}`);
      }

      if (recipe.output.kind === "furniture") {
        if (!slotId) throw new Error("SELECT A COMPATIBLE EMPTY SLOT.");
        const slot = BASE_SLOT_DEFS.find((candidate) => candidate.id === slotId);
        if (!slot) throw new Error("UNKNOWN BASE PLACEMENT SLOT.");
        if (!isObjectAllowedInSlot(recipe.output.objectKind, slot)) {
          throw new Error(`${recipe.output.objectKind} CANNOT BE PLACED IN ${slot.zone.toUpperCase()} SLOT ${slot.id}.`);
        }
        if (layout[slotId]) throw new Error(`SLOT ${slotId} IS OCCUPIED.`);
        validateBaseLayout({ ...layout, [slotId]: recipe.output.objectKind }, { expanded });
      }

      const lockedStash = await tx.select({ id: stashItems.id, itemType: stashItems.itemType, qty: stashItems.qty })
        .from(stashItems)
        .where(eq(stashItems.playerId, player.id))
        .orderBy(stashItems.acquiredAt)
        .for("update");
      for (const cost of recipe.costs) {
        const available = lockedStash
          .filter((row) => row.itemType === cost.itemType)
          .reduce((total, row) => total + row.qty, 0);
        if (available < cost.qty) throw new Error(`MISSING ${cost.qty - available}× ${cost.itemType}.`);
      }
      for (const cost of recipe.costs) {
        let remaining = cost.qty;
        for (const row of lockedStash.filter((candidate) => candidate.itemType === cost.itemType)) {
          if (remaining === 0) break;
          const used = Math.min(row.qty, remaining);
          if (used === row.qty) await tx.delete(stashItems).where(eq(stashItems.id, row.id));
          else await tx.update(stashItems).set({ qty: row.qty - used }).where(eq(stashItems.id, row.id));
          remaining -= used;
        }
      }

      if (recipe.output.kind === "furniture") {
        await tx.insert(baseLayouts).values({ playerId: player.id, slotId: slotId!, objectKind: recipe.output.objectKind });
      } else if (recipe.output.kind === "item") {
        const outputCode = itemToCode(recipe.output.item);
        if (outputCode.startsWith("b:")) throw new Error("Fabrication cannot output blueprint cargo.");
        await tx.insert(stashItems).values({ playerId: player.id, itemType: outputCode, qty: 1 });
      } else {
        await tx.insert(baseUpgrades).values({ playerId: player.id, upgradeId: recipe.output.upgradeId });
      }
      return { output: recipe.output, slotId: recipe.output.kind === "furniture" ? slotId : undefined };
    });
    if (!fabrication) return null;
    const base = await this.getBase(token);
    return base ? { base, ...fabrication } : null;
  }

  async savePresets(token: string, presets: LoadoutPreset[]) {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    const updated = await this.db.update(players).set({ presets })
      .where(eq(players.id, identity.playerId)).returning({ id: players.id });
    if (updated.length === 0) return null;
    return this.getBase(token);
  }

  async applyPreset(token: string, presetIndex: number) {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    const missing = await this.db.transaction(async (tx) => {
      const [player] = await tx.select({ id: players.id, loadout: players.loadout, presets: players.presets })
        .from(players).where(eq(players.id, identity.playerId)).limit(1).for("update");
      if (!player) return null;
      await this.assertPlayerLoadoutUnlocked(tx, player.id);
      const preset = player.presets[presetIndex];
      if (!preset) throw new Error("Unknown loadout preset.");
      if (player.loadout.length > 0) {
        await tx.insert(stashItems).values(player.loadout.map((itemType) => ({ playerId: player.id, itemType, qty: 1 })));
      }
      const rows = await tx.select({ id: stashItems.id, itemType: stashItems.itemType, qty: stashItems.qty })
        .from(stashItems).where(eq(stashItems.playerId, player.id)).orderBy(stashItems.acquiredAt).for("update");
      const applied: WireItemCode[] = [];
      const missingCounts = new Map<WireLoadoutCode, number>();
      for (const itemType of preset.items) {
        const row = rows.find((candidate) => candidate.itemType === itemType && candidate.qty > 0);
        if (!row) {
          missingCounts.set(itemType, (missingCounts.get(itemType) ?? 0) + 1);
          continue;
        }
        row.qty -= 1;
        if (row.qty === 0) await tx.delete(stashItems).where(eq(stashItems.id, row.id));
        else await tx.update(stashItems).set({ qty: row.qty }).where(eq(stashItems.id, row.id));
        applied.push(itemType);
      }
      await tx.update(players).set({ loadout: applied, loadoutRevision: sql`${players.loadoutRevision} + 1` }).where(eq(players.id, player.id));
      return [...missingCounts].map(([itemType, qty]) => ({ itemType, qty }));
    });
    if (!missing) return null;
    const base = await this.getBase(token);
    return base ? { base, missing } : null;
  }

  async setInsertionPreference(token: string, insertionPointId: string | null): Promise<string | null> {
    const identity = await this.helloPlayer(token);
    if (!identity) throw new Error("Unknown device token.");
    const updated = await this.db.update(players).set({ insertionPreference: insertionPointId })
      .where(eq(players.id, identity.playerId)).returning({ insertionPreference: players.insertionPreference });
    if (updated.length === 0) throw new Error("Unknown device token.");
    return updated[0].insertionPreference;
  }

  async getInsertionPreference(playerId: string): Promise<string | null> {
    playerId = await this.canonicalPlayerId(playerId);
    const [player] = await this.db.select({ insertionPreference: players.insertionPreference })
      .from(players).where(eq(players.id, playerId)).limit(1);
    return player?.insertionPreference ?? null;
  }

  async acceptContract(token: string, contractId: string): Promise<void> {
    const identity = await this.helloPlayer(token);
    if (!identity) throw new Error("Unknown device token.");
    await this.db.transaction(async (tx) => {
      const [player] = await tx.select({ id: players.id, contractReroll: players.contractReroll })
        .from(players).where(eq(players.id, identity.playerId)).limit(1).for("update");
      if (!player) throw new Error("Unknown device token.");
      const active = await tx.select({ id: contractRows.id }).from(contractRows)
        .where(and(eq(contractRows.playerId, player.id), eq(contractRows.status, "active"))).for("update");
      if (active.length >= CONTRACT_ACTIVE_CAP) throw new Error(`ACTIVE CONTRACT CAP IS ${CONTRACT_ACTIVE_CAP}.`);
      const offer = generateContractOffers(downtownMap, player.id, contractDayStamp(), player.contractReroll)
        .find((candidate) => candidate.id === contractId);
      if (!offer) throw new Error("CONTRACT OFFER IS NO LONGER AVAILABLE.");
      await tx.insert(contractRows).values({ id: offer.id, playerId: player.id, contract: offer, status: "active" });
    });
  }

  async rerollContracts(token: string): Promise<void> {
    const identity = await this.helloPlayer(token);
    if (!identity) throw new Error("Unknown device token.");
    const updated = await this.db.update(players).set({ contractReroll: sql`${players.contractReroll} + 1` })
      .where(eq(players.id, identity.playerId)).returning({ id: players.id });
    if (updated.length === 0) throw new Error("Unknown device token.");
  }

  async abandonContract(token: string, contractId: string): Promise<void> {
    const identity = await this.helloPlayer(token);
    if (!identity) throw new Error("Unknown device token.");
    const updated = await this.db.update(contractRows).set({ status: "abandoned" })
      .where(and(eq(contractRows.id, contractId), eq(contractRows.playerId, identity.playerId), eq(contractRows.status, "active")))
      .returning({ id: contractRows.id });
    if (updated.length === 0) throw new Error("ACTIVE CONTRACT NOT FOUND.");
  }

  async startMatch(input: {
    matchId: string;
    roomCode: string;
    mapId: string;
    startedAt: Date;
    playerIds: string[];
    queueClaims?: MatchQueueClaim[];
  }): Promise<MatchStartResult> {
    const requestedPlayerIds = [...new Set(input.playerIds)];
    if (requestedPlayerIds.length === 0 || requestedPlayerIds.length > PUBLIC_EXTRACTION_ROLE_COUNT) {
      throw new Error(`A match must register between one and ${PUBLIC_EXTRACTION_ROLE_COUNT} players.`);
    }
    return this.db.transaction(async (tx) => {
      const aliases = await tx.select({ sourcePlayerId: playerAliases.sourcePlayerId, targetPlayerId: playerAliases.targetPlayerId })
        .from(playerAliases).where(inArray(playerAliases.sourcePlayerId, requestedPlayerIds));
      const aliasBySource = new Map(aliases.map((alias) => [alias.sourcePlayerId, alias.targetPlayerId]));
      const canonicalByRequested = new Map(requestedPlayerIds.map((playerId) => [playerId, aliasBySource.get(playerId) ?? playerId]));
      const playerIds = [...new Set(canonicalByRequested.values())];
      if (playerIds.length !== requestedPlayerIds.length) throw new Error("Match roster resolves multiple sessions to the same player.");
      const created = await tx.insert(matchResults).values({
        id: input.matchId,
        roomCode: input.roomCode,
        mapId: input.mapId,
        startedAt: input.startedAt,
      }).onConflictDoNothing().returning({ id: matchResults.id });
      const [match] = await tx.select({ roomCode: matchResults.roomCode, mapId: matchResults.mapId })
        .from(matchResults).where(eq(matchResults.id, input.matchId)).limit(1);
      if (!match || match.roomCode !== input.roomCode || match.mapId !== input.mapId) {
        throw new Error("Match id is already registered with different metadata.");
      }
      if (created.length === 1) {
        const lockedPlayers = await tx.select({ id: players.id, loadout: players.loadout, loadoutRevision: players.loadoutRevision }).from(players)
          .where(inArray(players.id, [...playerIds].sort())).orderBy(asc(players.id)).for("update");
        if (lockedPlayers.length !== playerIds.length) throw new Error("Match roster contains an unknown player.");
        let canonicalLoadouts: Record<string, WireItemCode[]>;
        const completedClaimIds: string[] = [];
        if (input.queueClaims) {
          if (input.queueClaims.length !== requestedPlayerIds.length) throw new Error("Match queue claim roster is incomplete.");
          const claimsByCanonical = new Map<string, MatchQueueClaim>();
          for (const entry of input.queueClaims) {
            const canonicalPlayerId = canonicalByRequested.get(entry.playerId) ?? entry.playerId;
            if (!playerIds.includes(canonicalPlayerId) || claimsByCanonical.has(canonicalPlayerId) || !isUuid(entry.claimId)
              || !Number.isSafeInteger(entry.partyVersion) || entry.partyVersion < 1
              || !Number.isSafeInteger(entry.loadoutRevision) || entry.loadoutRevision < 1) {
              throw new Error("Match queue claim roster is invalid.");
            }
            claimsByCanonical.set(canonicalPlayerId, { ...entry, playerId: canonicalPlayerId });
          }
          if (claimsByCanonical.size !== playerIds.length) throw new Error("Match queue claim roster is incomplete.");
          const claimIds = [...new Set([...claimsByCanonical.values()].map((entry) => entry.claimId))].sort();
          const claimRows = await tx.select().from(partyQueueClaims)
            .where(inArray(partyQueueClaims.id, claimIds)).orderBy(asc(partyQueueClaims.id)).for("update");
          if (claimRows.length !== claimIds.length) throw new Error("Match queue claim no longer exists.");
          const playerById = new Map(lockedPlayers.map((player) => [player.id, player]));
          canonicalLoadouts = {};
          for (const claim of claimRows) {
            if (claim.status !== "active" || claim.expiresAt <= new Date() || claim.startedMatchId) {
              throw new Error("Match queue claim is no longer active.");
            }
            const claimEntries = [...claimsByCanonical.values()].filter((entry) => entry.claimId === claim.id);
            const snapshots = validatedLoadoutSnapshots(claim.loadoutSnapshots);
            if (claimEntries.length !== snapshots.length || claimEntries.some((entry) => entry.partyVersion !== claim.partyVersion)) {
              throw new Error("Match queue claim party version is stale.");
            }
            const snapshotByPlayer = new Map(snapshots.map((snapshot) => [snapshot.playerId, snapshot]));
            for (const entry of claimEntries) {
              const snapshot = snapshotByPlayer.get(entry.playerId);
              const player = playerById.get(entry.playerId);
              if (!snapshot || !player || entry.loadoutRevision !== snapshot.loadoutRevision
                || player.loadoutRevision !== snapshot.loadoutRevision) {
                throw new Error("Match queue claim loadout revision is stale.");
              }
              if (JSON.stringify(player.loadout) !== JSON.stringify(snapshot.loadout)) {
                throw new Error("Match queue claim loadout snapshot is stale.");
              }
              canonicalLoadouts[entry.playerId] = [...snapshot.loadout];
            }
            completedClaimIds.push(claim.id);
          }
        } else {
          for (const playerId of playerIds) await this.assertPlayerLoadoutUnlocked(tx, playerId);
          canonicalLoadouts = Object.fromEntries(lockedPlayers.map((player) => [player.id, [...player.loadout]]));
        }
        await tx.insert(matchParticipants).values(playerIds.map((playerId) => ({
          matchId: input.matchId,
          playerId,
          outcome: "active",
          startingLoadout: canonicalLoadouts[playerId] ?? [],
        })));
        await tx.update(players).set({ loadout: [], loadoutRevision: sql`${players.loadoutRevision} + 1` })
          .where(inArray(players.id, playerIds));
        if (completedClaimIds.length > 0) {
          const completed = await tx.update(partyQueueClaims)
            .set({ status: "completed", startedMatchId: input.matchId, updatedAt: new Date() })
            .where(and(inArray(partyQueueClaims.id, completedClaimIds), eq(partyQueueClaims.status, "active")))
            .returning({ id: partyQueueClaims.id });
          if (completed.length !== completedClaimIds.length) throw new Error("Match queue claim completion lost its transaction race.");
        }
        return { loadouts: Object.fromEntries(requestedPlayerIds.map((requested) => [requested, canonicalLoadouts[canonicalByRequested.get(requested)!] ?? []])) };
      }

      const participants = await tx.select({ playerId: matchParticipants.playerId, loadout: matchParticipants.startingLoadout })
        .from(matchParticipants).where(eq(matchParticipants.matchId, input.matchId));
      const registeredIds = new Set(participants.map((participant) => participant.playerId));
      if (registeredIds.size !== playerIds.length || playerIds.some((playerId) => !registeredIds.has(playerId))) {
        throw new Error("Match id is already registered with a different player roster.");
      }
      if (input.queueClaims) {
        const claimIds = [...new Set(input.queueClaims.map((entry) => entry.claimId))];
        const completed = await tx.select({ id: partyQueueClaims.id, startedMatchId: partyQueueClaims.startedMatchId })
          .from(partyQueueClaims).where(inArray(partyQueueClaims.id, claimIds));
        if (completed.length !== claimIds.length || completed.some((claim) => claim.startedMatchId !== input.matchId)) {
          throw new Error("Match idempotency does not match the completed queue claims.");
        }
      }
      const canonicalLoadouts = Object.fromEntries(participants.map((participant) => [participant.playerId, participant.loadout]));
      return { loadouts: Object.fromEntries(requestedPlayerIds.map((requested) => [requested, canonicalLoadouts[canonicalByRequested.get(requested)!] ?? []])) };
    });
  }

  async recordExtraction(input: {
    matchId: string;
    playerId: string;
    manifest: RunManifest;
    blueprintLearningThreshold: number;
  }): Promise<{ manifest: RunManifest }> {
    return this.db.transaction(async (tx) => {
      const [alias] = await tx.select({ targetPlayerId: playerAliases.targetPlayerId }).from(playerAliases)
        .where(eq(playerAliases.sourcePlayerId, input.playerId)).limit(1);
      const playerId = alias?.targetPlayerId ?? input.playerId;
      const [participant] = await tx.select({
        outcome: matchParticipants.outcome,
        manifest: matchParticipants.extractedManifest,
      }).from(matchParticipants)
        .where(and(eq(matchParticipants.matchId, input.matchId), eq(matchParticipants.playerId, playerId)))
        .limit(1)
        .for("update");
      if (!participant) throw new Error("Player is not registered for this match.");
      if (participant.outcome === "extracted" && isRunManifest(participant.manifest)) {
        return { manifest: participant.manifest };
      }
      if (participant.outcome !== "active") throw new Error(`Player match outcome is already ${participant.outcome}.`);

      const newlyLearned: string[] = [];
      const completedContracts: Array<{ contractId: string; title: string; payout: WireItemCode[] }> = [];
      const layout = await tx.select({ objectKind: baseLayouts.objectKind })
        .from(baseLayouts).where(eq(baseLayouts.playerId, playerId)).for("update");
      const capacity = layout.filter((row) => row.objectKind === "locker").length * 20;
      const lockedStash = await tx.select({ qty: stashItems.qty })
        .from(stashItems).where(eq(stashItems.playerId, playerId)).for("update");
      let stashCount = lockedStash.reduce((total, row) => total + row.qty, 0);
      const bankOrder = [...input.manifest.keptItems].sort((left, right) => Number(right.startsWith("b:")) - Number(left.startsWith("b:")));
      const keptItems: WireItemCode[] = [];
      const overflow: WireItemCode[] = [];

      for (const itemType of bankOrder) {
        if (stashCount >= capacity) {
          overflow.push(itemType);
          continue;
        }
        await tx.insert(stashItems).values({ playerId, itemType, qty: 1, acquiredMatchId: input.matchId });
        stashCount += 1;
        keptItems.push(itemType);

        if (!itemType.startsWith("b:")) continue;
        const blueprintId = itemType.slice(2);
        const [existing] = await tx.select({ blueprintId: learnedBlueprints.blueprintId })
          .from(learnedBlueprints)
          .where(and(eq(learnedBlueprints.playerId, playerId), eq(learnedBlueprints.blueprintId, blueprintId)))
          .limit(1);
        const [count] = await tx.select({ total: sql<number>`coalesce(sum(${stashItems.qty}), 0)::int` })
          .from(stashItems)
          .where(and(eq(stashItems.playerId, playerId), eq(stashItems.itemType, itemType)));
        const fragmentCount = Number(count?.total ?? 0);
        if (existing || fragmentCount >= input.blueprintLearningThreshold) {
          if (!existing) {
            await tx.insert(learnedBlueprints).values({ playerId, blueprintId });
            newlyLearned.push(blueprintId);
          }
          await tx.delete(stashItems)
            .where(and(eq(stashItems.playerId, playerId), eq(stashItems.itemType, itemType)));
          stashCount -= fragmentCount;
        }
      }

      const active = await tx.select({ id: contractRows.id, contract: contractRows.contract })
        .from(contractRows)
        .where(and(eq(contractRows.playerId, playerId), eq(contractRows.status, "active")))
        .for("update");
      for (const row of active) {
        if (!contractSatisfied(row.contract, input.manifest.cargo ?? [])) continue;
        const payout: WireItemCode[] = [];
        for (const item of row.contract.payout.items) {
          if (stashCount >= capacity) break;
          const itemType = itemToCode(item);
          await tx.insert(stashItems).values({ playerId, itemType, qty: 1, acquiredMatchId: input.matchId });
          stashCount += 1;
          payout.push(itemType);
        }
        await tx.update(contractRows).set({ status: "completed" })
          .where(and(eq(contractRows.id, row.id), eq(contractRows.playerId, playerId)));
        completedContracts.push({ contractId: row.id, title: row.contract.title, payout });
      }

      const manifest: RunManifest = {
        ...input.manifest,
        keptItems,
        lostItems: [...input.manifest.lostItems, ...overflow],
        learnedBlueprints: newlyLearned,
        ...(completedContracts.length > 0 ? { contractCompletions: completedContracts } : {}),
      };
      const updated = await tx.update(matchParticipants)
        .set({ outcome: "extracted", extractedManifest: manifest })
        .where(and(eq(matchParticipants.matchId, input.matchId), eq(matchParticipants.playerId, playerId)))
        .returning({ playerId: matchParticipants.playerId });
      if (updated.length !== 1) throw new Error("Player match outcome could not be saved.");
      return { manifest };
    });
  }

  async recordOutcome(input: { matchId: string; playerId: string; outcome: "died" | "timeout" | "disconnected" }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [alias] = await tx.select({ targetPlayerId: playerAliases.targetPlayerId }).from(playerAliases)
        .where(eq(playerAliases.sourcePlayerId, input.playerId)).limit(1);
      const playerId = alias?.targetPlayerId ?? input.playerId;
      const [participant] = await tx.select({ outcome: matchParticipants.outcome }).from(matchParticipants)
        .where(and(eq(matchParticipants.matchId, input.matchId), eq(matchParticipants.playerId, playerId)))
        .limit(1)
        .for("update");
      if (!participant) throw new Error("Player is not registered for this match.");
      if (participant.outcome === input.outcome) return;
      if (participant.outcome !== "active") throw new Error(`Player match outcome is already ${participant.outcome}.`);
      await tx.update(matchParticipants).set({ outcome: input.outcome })
        .where(and(eq(matchParticipants.matchId, input.matchId), eq(matchParticipants.playerId, playerId)));
    });
  }

  async finishMatch(input: { matchId: string; endedAt: Date; summary: unknown }): Promise<void> {
    if (!isAggregateMatchSummary(input.summary)) throw new Error("Match summary must contain aggregate outcome counts only.");
    await this.db.transaction(async (tx) => {
      const active = await tx.select({ playerId: matchParticipants.playerId })
        .from(matchParticipants)
        .where(and(eq(matchParticipants.matchId, input.matchId), eq(matchParticipants.outcome, "active")))
        .limit(1)
        .for("update");
      if (active.length > 0) throw new Error("Match still has an unsettled participant outcome.");
      const updated = await tx.update(matchResults).set({ endedAt: input.endedAt, summary: input.summary })
        .where(eq(matchResults.id, input.matchId)).returning({ id: matchResults.id });
      if (updated.length !== 1) throw new Error("Match is not registered.");
    });
  }

  async claimRelayRequest(requestId: string, expiresAt: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.delete(relayRequests).where(lt(relayRequests.expiresAt, new Date()));
      const claimed = await tx.insert(relayRequests).values({ id: requestId, expiresAt })
        .onConflictDoNothing()
        .returning({ id: relayRequests.id });
      return claimed.length === 1;
    });
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 2 });
  }

  private async retryConcurrentPartyTransaction<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 2 || !isRetryableTransactionConflict(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  }

  private async partyActor(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    token: string,
  ): Promise<{ playerId: string; publicPlayerId: string; name: string; deviceId: string; linked: boolean } | null> {
    const tokenHash = hashToken(token);
    let [device] = await tx.select({
      deviceId: playerDevices.id,
      playerId: players.id,
      publicPlayerId: players.publicPlayerId,
      name: players.displayName,
    }).from(playerDevices)
      .innerJoin(players, eq(players.id, playerDevices.playerId))
      .where(eq(playerDevices.tokenHash, tokenHash))
      .for("update");
    if (!device) {
      const [legacy] = await tx.select({
        playerId: players.id,
        publicPlayerId: players.publicPlayerId,
        name: players.displayName,
      }).from(players).where(eq(players.deviceTokenHash, tokenHash)).for("update");
      if (!legacy) return null;
      const [inserted] = await tx.insert(playerDevices).values({ playerId: legacy.playerId, tokenHash })
        .onConflictDoNothing()
        .returning({ deviceId: playerDevices.id });
      if (inserted) device = { ...legacy, deviceId: inserted.deviceId };
      else {
        [device] = await tx.select({
          deviceId: playerDevices.id,
          playerId: players.id,
          publicPlayerId: players.publicPlayerId,
          name: players.displayName,
        }).from(playerDevices)
          .innerJoin(players, eq(players.id, playerDevices.playerId))
          .where(eq(playerDevices.tokenHash, tokenHash))
          .for("update");
      }
    }
    if (!device) return null;
    const [linked] = await tx.select({ id: externalIdentities.id }).from(externalIdentities)
      .where(eq(externalIdentities.playerId, device.playerId)).limit(1);
    return { ...device, linked: Boolean(linked) };
  }

  private async partyMembershipForActor(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    actor: { playerId: string; deviceId: string; linked: boolean },
    rejectMismatch = true,
  ): Promise<{ partyId: string; guestDeviceId: string | null } | null> {
    const [membership] = await tx.select({
      partyId: partyMembers.partyId,
      guestDeviceId: partyMembers.guestDeviceId,
    }).from(partyMembers).where(eq(partyMembers.playerId, actor.playerId)).limit(1);
    if (!membership) return null;
    const ownsMembership = actor.linked
      ? membership.guestDeviceId === null
      : membership.guestDeviceId === actor.deviceId;
    if (!ownsMembership) {
      if (!rejectMismatch) return null;
      throw new PartyConflictError("party_membership_conflict", "This guest party membership belongs to another device.");
    }
    return membership;
  }

  private async lockParty(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    partyId: string,
  ): Promise<{ id: string; matchmakingKey: string; version: number; leaderPlayerId: string } | undefined> {
    const [party] = await tx.select({
      id: parties.id,
      matchmakingKey: parties.matchmakingKey,
      version: parties.version,
      leaderPlayerId: parties.leaderPlayerId,
    }).from(parties).where(eq(parties.id, partyId)).for("update");
    return party;
  }

  private async readPartyMembers(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    partyId: string,
  ) {
    // Call only after lockParty(). The party row is the canonical membership
    // lock, which avoids opposite members deadlocking while each holds its own
    // membership row and waits for the other.
    return tx.select({
      playerId: partyMembers.playerId,
      guestDeviceId: partyMembers.guestDeviceId,
      joinedAt: partyMembers.joinedAt,
    }).from(partyMembers).where(eq(partyMembers.partyId, partyId)).orderBy(asc(partyMembers.joinedAt), asc(partyMembers.playerId));
  }

  private async partyIdForPlayer(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    playerId: string,
  ): Promise<string | null> {
    const [membership] = await tx.select({ partyId: partyMembers.partyId }).from(partyMembers)
      .where(eq(partyMembers.playerId, playerId)).limit(1);
    return membership?.partyId ?? null;
  }

  private async isPartyMember(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    partyId: string,
    playerId: string,
  ): Promise<boolean> {
    return await this.partyIdForPlayer(tx, playerId) === partyId;
  }

  private async lockPotentialPartySuccessors(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    partyId: string,
    leavingPlayerId: string,
  ): Promise<void> {
    await tx.select({ id: players.id }).from(players)
      .innerJoin(partyMembers, and(eq(partyMembers.playerId, players.id), eq(partyMembers.partyId, partyId)))
      .where(ne(players.id, leavingPlayerId))
      .orderBy(asc(players.id))
      .for("update", { of: players });
  }

  private async partySummaryForPlayer(playerId: string): Promise<PartySummary | null> {
    const [membership] = await this.db.select({ partyId: partyMembers.partyId }).from(partyMembers)
      .where(eq(partyMembers.playerId, playerId)).limit(1);
    return membership ? this.partySummaryById(this.db, membership.partyId, playerId) : null;
  }

  private async partySummaryById(
    db: PostgresJsDatabase | Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    partyId: string,
    actorPlayerId: string,
  ): Promise<PartySummary> {
    const [party] = await db.select({ version: parties.version, leaderPlayerId: parties.leaderPlayerId })
      .from(parties).where(eq(parties.id, partyId)).limit(1);
    if (!party) throw new PartyConflictError("party_membership_conflict", "Party no longer exists.");
    const members = await db.select({
      playerId: players.id,
      publicPlayerId: players.publicPlayerId,
      displayName: players.displayName,
      joinedAt: partyMembers.joinedAt,
    }).from(partyMembers)
      .innerJoin(players, eq(players.id, partyMembers.playerId))
      .where(eq(partyMembers.partyId, partyId))
      .orderBy(asc(partyMembers.joinedAt), asc(partyMembers.playerId));
    const [linkedActor] = await db.select({ id: externalIdentities.id }).from(externalIdentities)
      .where(eq(externalIdentities.playerId, actorPlayerId)).limit(1);
    return {
      version: party.version,
      members: members.map((member) => ({
        publicPlayerId: member.publicPlayerId,
        displayName: member.displayName,
        leader: member.playerId === party.leaderPlayerId,
      })),
      canInvite: party.leaderPlayerId === actorPlayerId && Boolean(linkedActor) && members.length < 3,
    };
  }

  private async assertPartyNotQueued(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    partyId: string,
  ): Promise<void> {
    const [claim] = await tx.select({ id: partyQueueClaims.id }).from(partyQueueClaims).where(and(
      eq(partyQueueClaims.partyId, partyId),
      inArray(partyQueueClaims.status, ["active", "cancelling"]),
      gt(partyQueueClaims.expiresAt, new Date()),
    )).limit(1).for("update");
    if (claim) throw new PartyConflictError("party_queued", "Cancel public queueing before changing party membership.");
  }

  private async assertPlayerNotQueuedSolo(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    playerId: string,
  ): Promise<void> {
    const [claim] = await tx.select({ id: partyQueueClaims.id }).from(partyQueueClaims).where(and(
      isNull(partyQueueClaims.partyId),
      eq(partyQueueClaims.requestingPlayerId, playerId),
      inArray(partyQueueClaims.status, ["active", "cancelling"]),
      gt(partyQueueClaims.expiresAt, new Date()),
    )).limit(1).for("update");
    if (claim) throw new PartyConflictError("party_queued", "Cancel public queueing before joining a party.");
  }

  private async removePartyMember(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    party: { id: string; version: number; leaderPlayerId: string },
    playerId: string,
  ): Promise<void> {
    await tx.delete(partyMembers).where(and(eq(partyMembers.partyId, party.id), eq(partyMembers.playerId, playerId)));
    const remaining = await tx.select({
      playerId: partyMembers.playerId,
      joinedAt: partyMembers.joinedAt,
      linked: sql<boolean>`${externalIdentities.id} is not null`,
    }).from(partyMembers)
      .leftJoin(externalIdentities, eq(externalIdentities.playerId, partyMembers.playerId))
      .where(eq(partyMembers.partyId, party.id))
      .orderBy(desc(sql`${externalIdentities.id} is not null`), asc(partyMembers.joinedAt), asc(partyMembers.playerId));
    if (remaining.length === 0) {
      await tx.delete(parties).where(eq(parties.id, party.id));
      return;
    }
    const leaderPlayerId = party.leaderPlayerId === playerId ? remaining[0].playerId : party.leaderPlayerId;
    await tx.update(parties).set({ leaderPlayerId, version: party.version + 1, updatedAt: new Date() })
      .where(eq(parties.id, party.id));
  }

  private async partyQueueClaimById(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    claimId: string,
    party: { id: string; matchmakingKey: string; version: number; leaderPlayerId: string },
    requestingPlayerId: string,
    _buildId: string,
    _region: string,
  ): Promise<PartyQueueClaim> {
    const [claim] = await tx.select().from(partyQueueClaims).where(eq(partyQueueClaims.id, claimId)).limit(1);
    if (!claim) throw new PartyConflictError("party_membership_conflict", "Party queue claim no longer exists.");
    return this.partyQueueClaimByRecord(claim, party, requestingPlayerId);
  }

  private partyQueueClaimByRecord(
    claim: typeof partyQueueClaims.$inferSelect,
    party: { id: string; matchmakingKey: string; version: number; leaderPlayerId: string },
    requestingPlayerId: string,
  ): PartyQueueClaim {
    const members = validatedLoadoutSnapshots(claim.loadoutSnapshots);
    if (claim.partyId !== party.id || claim.partyVersion !== party.version || members.length < 1 || members.length > 3
      || !members.some((member) => member.playerId === requestingPlayerId)
      || !members.some((member) => member.playerId === party.leaderPlayerId)) {
      throw new PartyConflictError("party_membership_conflict", "Canonical party roster is invalid.");
    }
    return {
      claimId: claim.id,
      partyId: party.matchmakingKey,
      version: claim.partyVersion,
      leaderPlayerId: party.leaderPlayerId,
      requestingPlayerId,
      buildId: claim.buildId,
      region: claim.region,
      status: queueClaimStatus(claim),
      ...(claim.startedMatchId ? { startedMatchId: claim.startedMatchId } : {}),
      members: members.map(({ playerId, name, loadoutRevision }) => ({ playerId, name, loadoutRevision })),
    };
  }

  private soloQueueClaim(
    claim: typeof partyQueueClaims.$inferSelect | {
      id: string;
      partyId: null;
      requestingPlayerId: string;
      partyVersion: number;
      buildId: string;
      region: string;
      loadoutSnapshots: typeof partyQueueClaims.$inferSelect["loadoutSnapshots"];
      status: string;
      startedMatchId: string | null;
      expiresAt: Date;
    },
    actor: { playerId: string; name: string },
  ): PartyQueueClaim {
    const [snapshot] = validatedLoadoutSnapshots(claim.loadoutSnapshots);
    if (!snapshot || snapshot.playerId !== actor.playerId || claim.requestingPlayerId !== actor.playerId) {
      throw new PartyConflictError("party_membership_conflict", "Canonical solo queue claim is invalid.");
    }
    return {
      claimId: claim.id,
      partyId: `solo-${createHash("sha256").update(actor.playerId).digest("hex").slice(0, 24)}`,
      version: 1,
      leaderPlayerId: actor.playerId,
      requestingPlayerId: actor.playerId,
      buildId: claim.buildId,
      region: claim.region,
      status: queueClaimStatus(claim),
      ...(claim.startedMatchId ? { startedMatchId: claim.startedMatchId } : {}),
      members: [{ playerId: actor.playerId, name: snapshot.name, loadoutRevision: snapshot.loadoutRevision }],
    };
  }

  private async lockQueueLoadoutSnapshots(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    playerIds: readonly string[],
  ): Promise<Array<{ playerId: string; name: string; loadoutRevision: number; loadout: WireItemCode[] }>> {
    const uniqueIds = [...new Set(playerIds)];
    if (uniqueIds.length < 1 || uniqueIds.length > 3) {
      throw new PartyConflictError("party_membership_conflict", "Canonical party roster is invalid.");
    }
    const locked = await tx.select({
      playerId: players.id,
      name: players.displayName,
      loadoutRevision: players.loadoutRevision,
      loadout: players.loadout,
    }).from(players).where(inArray(players.id, [...uniqueIds].sort())).orderBy(asc(players.id)).for("update");
    if (locked.length !== uniqueIds.length) throw new PartyConflictError("party_membership_conflict", "Canonical party roster is invalid.");
    const byId = new Map(locked.map((entry) => [entry.playerId, entry]));
    return uniqueIds.map((playerId) => {
      const entry = byId.get(playerId);
      if (!entry) throw new PartyConflictError("party_membership_conflict", "Canonical party roster is invalid.");
      return { ...entry, loadout: [...entry.loadout] };
    });
  }

  private async assertPlayerLoadoutUnlocked(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    playerId: string,
  ): Promise<void> {
    const membership = await tx.select({ partyId: partyMembers.partyId }).from(partyMembers)
      .where(eq(partyMembers.playerId, playerId)).limit(1);
    const [claim] = await tx.select({ id: partyQueueClaims.id }).from(partyQueueClaims).where(and(
      membership[0]
        ? eq(partyQueueClaims.partyId, membership[0].partyId)
        : and(isNull(partyQueueClaims.partyId), eq(partyQueueClaims.requestingPlayerId, playerId)),
      inArray(partyQueueClaims.status, ["active", "cancelling"]),
      gt(partyQueueClaims.expiresAt, new Date()),
    )).limit(1).for("update");
    if (claim) throw new PartyConflictError("party_queued", "Cancel public queueing before changing loadout.");
  }

  private async removePartyMembershipForDeletion(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    playerId: string,
  ): Promise<void> {
    const [membership] = await tx.select({ partyId: partyMembers.partyId }).from(partyMembers)
      .where(eq(partyMembers.playerId, playerId));
    if (!membership) {
      await this.assertPlayerNotQueuedSolo(tx, playerId);
      return;
    }
    const [authorityHint] = await tx.select({ leaderPlayerId: parties.leaderPlayerId }).from(parties)
      .where(eq(parties.id, membership.partyId)).limit(1);
    if (authorityHint?.leaderPlayerId === playerId) {
      await this.lockPotentialPartySuccessors(tx, membership.partyId, playerId);
    }
    const party = await this.lockParty(tx, membership.partyId);
    if (!party) return;
    if (!await this.isPartyMember(tx, party.id, playerId)) return;
    await this.assertPartyNotQueued(tx, party.id);
    await this.removePartyMember(tx, party, playerId);
  }

  private async mergePartyMembership(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    sourcePlayerId: string,
    targetPlayerId: string,
  ): Promise<void> {
    const membershipHints = await tx.select({ partyId: partyMembers.partyId, playerId: partyMembers.playerId })
      .from(partyMembers)
      .where(inArray(partyMembers.playerId, [sourcePlayerId, targetPlayerId]))
      .orderBy(asc(partyMembers.partyId));
    const sourceMembershipHint = membershipHints.find((membership) => membership.playerId === sourcePlayerId);
    const targetMembershipHint = membershipHints.find((membership) => membership.playerId === targetPlayerId);
    if (sourceMembershipHint && targetMembershipHint?.partyId !== sourceMembershipHint.partyId) {
      const [sourceAuthorityHint] = await tx.select({ leaderPlayerId: parties.leaderPlayerId }).from(parties)
        .where(eq(parties.id, sourceMembershipHint.partyId)).limit(1);
      if (sourceAuthorityHint?.leaderPlayerId === sourcePlayerId) {
        await this.lockPotentialPartySuccessors(tx, sourceMembershipHint.partyId, sourcePlayerId);
      }
    }
    const partyIds = [...new Set(membershipHints.map((membership) => membership.partyId))].sort();
    const lockedParties = new Map<string, { id: string; matchmakingKey: string; version: number; leaderPlayerId: string }>();
    for (const partyId of partyIds) {
      const party = await this.lockParty(tx, partyId);
      if (party) {
        await this.assertPartyNotQueued(tx, party.id);
        lockedParties.set(party.id, party);
      }
    }
    // Membership can disappear while party locks are pending (for example, a
    // different leader can disband). Re-read only after every involved party
    // is locked, then perform all roster changes under those locks.
    const memberships = await tx.select({ partyId: partyMembers.partyId, playerId: partyMembers.playerId })
      .from(partyMembers)
      .where(inArray(partyMembers.playerId, [sourcePlayerId, targetPlayerId]))
      .orderBy(asc(partyMembers.partyId));
    const sourceMembership = memberships.find((membership) => membership.playerId === sourcePlayerId);
    const targetMembership = memberships.find((membership) => membership.playerId === targetPlayerId);
    if (!sourceMembership) {
      await this.assertPlayerNotQueuedSolo(tx, sourcePlayerId);
      await tx.update(partyInvites).set({ ownerPlayerId: targetPlayerId }).where(eq(partyInvites.ownerPlayerId, sourcePlayerId));
      return;
    }
    if (!targetMembership) await this.assertPlayerNotQueuedSolo(tx, targetPlayerId);
    const sourceParty = lockedParties.get(sourceMembership.partyId);
    if (!sourceParty) return;

    if (!targetMembership) {
      await tx.update(partyMembers).set({ playerId: targetPlayerId, guestDeviceId: null })
        .where(and(eq(partyMembers.partyId, sourceParty.id), eq(partyMembers.playerId, sourcePlayerId)));
      await tx.update(parties).set({
        leaderPlayerId: sourceParty.leaderPlayerId === sourcePlayerId ? targetPlayerId : sourceParty.leaderPlayerId,
        version: sourceParty.version + 1,
        updatedAt: new Date(),
      }).where(eq(parties.id, sourceParty.id));
      await tx.update(partyInvites).set({ ownerPlayerId: targetPlayerId }).where(eq(partyInvites.ownerPlayerId, sourcePlayerId));
      return;
    }

    if (targetMembership.partyId === sourceParty.id) {
      await tx.delete(partyMembers).where(and(eq(partyMembers.partyId, sourceParty.id), eq(partyMembers.playerId, sourcePlayerId)));
      await tx.update(parties).set({
        leaderPlayerId: sourceParty.leaderPlayerId === sourcePlayerId ? targetPlayerId : sourceParty.leaderPlayerId,
        version: sourceParty.version + 1,
        updatedAt: new Date(),
      }).where(eq(parties.id, sourceParty.id));
      await tx.update(partyInvites).set({ ownerPlayerId: targetPlayerId }).where(eq(partyInvites.ownerPlayerId, sourcePlayerId));
      return;
    }

    // An established linked account's durable party wins. The guest leaves
    // its source party atomically; its old invite authority is revoked rather
    // than being transferred into an unrelated roster.
    await tx.update(partyInvites).set({ revoked: true }).where(eq(partyInvites.ownerPlayerId, sourcePlayerId));
    await this.removePartyMember(tx, sourceParty, sourcePlayerId);
  }

  private async createGuest(name: string, token: string): Promise<PlayerIdentity> {
    const tokenHash = hashToken(token);
    return allocateUniquePublicPlayerId(async (candidate) => {
      return this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dotbot-public-player-id:${candidate}`}, 0))`);
        const [retired] = await tx.select({ sourcePlayerId: playerAliases.sourcePlayerId }).from(playerAliases)
          .where(eq(playerAliases.sourcePublicPlayerId, candidate)).limit(1);
        if (retired) return null;
        const [player] = await tx.insert(players).values({
          publicPlayerId: candidate,
          displayName: name,
          deviceTokenHash: tokenHash,
          baseTutorialPhase: initialBaseTutorialState.phase,
          baseTutorialRevision: initialBaseTutorialState.revision,
        }).onConflictDoNothing({ target: players.publicPlayerId })
          .returning({ id: players.id, publicPlayerId: players.publicPlayerId, name: players.displayName });
        if (!player) return null;
        await tx.insert(playerDevices).values({ playerId: player.id, tokenHash });
        await tx.insert(baseLayouts).values(layoutRows(player.id, starterBaseLayout));
        return { playerId: player.id, publicPlayerId: player.publicPlayerId, name: player.name };
      });
    }, this.publicIdFactory);
  }

  private async accountSummary(playerId: string): Promise<AccountSummary | null> {
    const [player] = await this.db.select({ publicPlayerId: players.publicPlayerId, displayName: players.displayName })
      .from(players).where(eq(players.id, playerId)).limit(1);
    if (!player) return null;
    const [external] = await this.db.select({ id: externalIdentities.id }).from(externalIdentities)
      .where(eq(externalIdentities.playerId, playerId)).limit(1);
    const providerRows = external
      ? await this.db.select({ provider: identityProviders.provider }).from(identityProviders)
        .where(eq(identityProviders.externalIdentityId, external.id))
      : [];
    return {
      publicPlayerId: player.publicPlayerId,
      displayName: player.displayName,
      linked: Boolean(external),
      providers: providerRows.map((row) => row.provider).filter(isIdentityProviderKind),
    };
  }

  private async linkedIdentityForToken(token: string): Promise<PlayerIdentity | null> {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    const [external] = await this.db.select({ id: externalIdentities.id }).from(externalIdentities)
      .where(eq(externalIdentities.playerId, identity.playerId)).limit(1);
    return external ? identity : null;
  }

  private async mergeGuestTransaction(
    tx: Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0],
    source: {
      id: string;
      name: string;
      publicPlayerId: string;
      loadout: WireItemCode[];
      loadoutRevision: number;
      shell: BaseShellId;
      presets: LoadoutPreset[];
      insertionPreference: string | null;
      tutorialPhase: BaseTutorialState["phase"];
      tutorialRevision: number;
    },
    target: {
      id: string;
      name: string;
      publicPlayerId: string;
      loadout: WireItemCode[];
      loadoutRevision: number;
      shell: BaseShellId;
      presets: LoadoutPreset[];
      insertionPreference: string | null;
      tutorialPhase: BaseTutorialState["phase"];
      tutorialRevision: number;
    },
    identity: VerifiedExternalIdentity,
  ): Promise<void> {
    if (source.id === target.id) return;
    const sourceLayout = await tx.select({ slotId: baseLayouts.slotId, objectKind: baseLayouts.objectKind })
      .from(baseLayouts).where(eq(baseLayouts.playerId, source.id)).for("update");
    const sourceContracts = await tx.select({ id: contractRows.id, contract: contractRows.contract, status: contractRows.status })
      .from(contractRows).where(eq(contractRows.playerId, source.id)).for("update");
    const sourceMatches = await tx.select({
      matchId: matchParticipants.matchId,
      outcome: matchParticipants.outcome,
      extractedManifest: matchParticipants.extractedManifest,
      startingLoadout: matchParticipants.startingLoadout,
    }).from(matchParticipants).where(eq(matchParticipants.playerId, source.id)).for("update");
    const targetOverlaps = sourceMatches.length > 0
      ? await tx.select({ matchId: matchParticipants.matchId, outcome: matchParticipants.outcome })
        .from(matchParticipants)
        .where(and(
          eq(matchParticipants.playerId, target.id),
          inArray(matchParticipants.matchId, sourceMatches.map((match) => match.matchId)),
        ))
        .for("update")
      : [];
    const sourceOutcomeByMatch = new Map(sourceMatches.map((match) => [match.matchId, match.outcome]));
    if (targetOverlaps.some((match) => match.outcome === "active" || sourceOutcomeByMatch.get(match.matchId) === "active")) {
      throw new PersistenceConflictError("Account linking must wait until the overlapping active match ends.");
    }
    await this.mergePartyMembership(tx, source.id, target.id);
    const conflicts = {
      source: {
        displayName: source.name,
        publicPlayerId: source.publicPlayerId,
        loadout: source.loadout,
        shell: source.shell,
        presets: source.presets,
        insertionPreference: source.insertionPreference,
        layout: Object.fromEntries(sourceLayout.map((row) => [row.slotId, row.objectKind])),
        contracts: sourceContracts,
        matches: sourceMatches,
      },
      policy: "linked-target-wins",
    };

    // A source loadout has already been withdrawn from its STASH. Returning
    // both active loadouts before clearing them preserves every item without
    // deciding which device should risk it in the next run.
    const returnedLoadout = [...source.loadout, ...target.loadout];
    if (returnedLoadout.length > 0) {
      await tx.insert(stashItems).values(returnedLoadout.map((itemType) => ({ playerId: target.id, itemType, qty: 1 })));
    }
    await tx.update(stashItems).set({ playerId: target.id }).where(eq(stashItems.playerId, source.id));

    await tx.insert(learnedBlueprints)
      .select(tx.select({
        playerId: sql<string>`${target.id}::uuid`.as("player_id"),
        blueprintId: learnedBlueprints.blueprintId,
        learnedAt: learnedBlueprints.learnedAt,
      }).from(learnedBlueprints).where(eq(learnedBlueprints.playerId, source.id)))
      .onConflictDoNothing();
    await tx.delete(learnedBlueprints).where(eq(learnedBlueprints.playerId, source.id));

    await tx.insert(baseUpgrades)
      .select(tx.select({
        playerId: sql<string>`${target.id}::uuid`.as("player_id"),
        upgradeId: baseUpgrades.upgradeId,
        acquiredAt: baseUpgrades.acquiredAt,
      }).from(baseUpgrades).where(eq(baseUpgrades.playerId, source.id)))
      .onConflictDoNothing();
    await tx.delete(baseUpgrades).where(eq(baseUpgrades.playerId, source.id));

    await tx.insert(baseLayouts)
      .select(tx.select({
        playerId: sql<string>`${target.id}::uuid`.as("player_id"),
        slotId: baseLayouts.slotId,
        objectKind: baseLayouts.objectKind,
      }).from(baseLayouts).where(eq(baseLayouts.playerId, source.id)))
      .onConflictDoNothing();
    await tx.delete(baseLayouts).where(eq(baseLayouts.playerId, source.id));

    // Contract ids are globally unique today. Preserve the source definitions,
    // but an established linked account's active set wins the merge.
    await tx.update(contractRows).set({ status: "abandoned" })
      .where(and(eq(contractRows.playerId, source.id), eq(contractRows.status, "active")));
    await tx.update(contractRows).set({ playerId: target.id }).where(eq(contractRows.playerId, source.id));

    const duplicateMatches = targetOverlaps;
    if (duplicateMatches.length > 0) {
      await tx.delete(matchParticipants).where(and(
        eq(matchParticipants.playerId, source.id),
        inArray(matchParticipants.matchId, duplicateMatches.map((row) => row.matchId)),
      ));
    }
    await tx.update(matchParticipants).set({ playerId: target.id }).where(eq(matchParticipants.playerId, source.id));

    const sourceFriendships = await tx.select({
      low: friendships.playerLowId,
      high: friendships.playerHighId,
      requestedBy: friendships.requestedById,
      status: friendships.status,
      createdAt: friendships.createdAt,
      acceptedAt: friendships.acceptedAt,
    }).from(friendships).where(or(eq(friendships.playerLowId, source.id), eq(friendships.playerHighId, source.id))).for("update");
    await tx.delete(friendships).where(or(eq(friendships.playerLowId, source.id), eq(friendships.playerHighId, source.id)));
    for (const friendship of sourceFriendships) {
      const otherId = friendship.low === source.id ? friendship.high : friendship.low;
      if (otherId === target.id) continue;
      const [low, high] = canonicalPair(target.id, otherId);
      await tx.insert(friendships).values({
        playerLowId: low,
        playerHighId: high,
        requestedById: friendship.requestedBy === source.id ? target.id : friendship.requestedBy,
        status: friendship.status,
        createdAt: friendship.createdAt,
        acceptedAt: friendship.acceptedAt,
      }).onConflictDoUpdate({
        target: [friendships.playerLowId, friendships.playerHighId],
        set: {
          status: sql`case
            when ${friendships.status} = 'accepted'
              or excluded.status = 'accepted'
              or ${friendships.requestedById} <> excluded.requested_by_id
            then 'accepted' else 'pending' end`,
          acceptedAt: sql`case
            when ${friendships.status} = 'accepted'
              or excluded.status = 'accepted'
              or ${friendships.requestedById} <> excluded.requested_by_id
            then coalesce(${friendships.acceptedAt}, excluded.accepted_at, now())
            else null end`,
          createdAt: sql`least(${friendships.createdAt}, excluded.created_at)`,
        },
      });
    }

    const sourceBlocks = await tx.select({ blocker: playerBlocks.blockerPlayerId, blocked: playerBlocks.blockedPlayerId, createdAt: playerBlocks.createdAt })
      .from(playerBlocks).where(or(eq(playerBlocks.blockerPlayerId, source.id), eq(playerBlocks.blockedPlayerId, source.id))).for("update");
    await tx.delete(playerBlocks).where(or(eq(playerBlocks.blockerPlayerId, source.id), eq(playerBlocks.blockedPlayerId, source.id)));
    for (const block of sourceBlocks) {
      const blocker = block.blocker === source.id ? target.id : block.blocker;
      const blocked = block.blocked === source.id ? target.id : block.blocked;
      if (blocker === blocked) continue;
      await tx.insert(playerBlocks).values({ blockerPlayerId: blocker, blockedPlayerId: blocked, createdAt: block.createdAt }).onConflictDoNothing();
    }

    const sourceAcceptances = await tx.select({
      inviteId: partyInviteAcceptances.inviteId,
      acceptedAt: partyInviteAcceptances.acceptedAt,
      durable: partyInviteAcceptances.durable,
    })
      .from(partyInviteAcceptances).where(eq(partyInviteAcceptances.playerId, source.id));
    for (const acceptance of sourceAcceptances) {
      await tx.insert(partyInviteAcceptances).values({
        inviteId: acceptance.inviteId,
        playerId: target.id,
        acceptedAt: acceptance.acceptedAt,
        durable: true,
      }).onConflictDoUpdate({
        target: [partyInviteAcceptances.inviteId, partyInviteAcceptances.playerId],
        set: { durable: true, guestDeviceId: null },
      });
    }
    await tx.delete(partyInviteAcceptances).where(eq(partyInviteAcceptances.playerId, source.id));
    const targetInviteRows = await tx.select({ id: partyInvites.id }).from(partyInvites)
      .where(eq(partyInvites.ownerPlayerId, target.id));
    if (targetInviteRows.length > 0) {
      await tx.delete(partyInviteAcceptances).where(and(
        eq(partyInviteAcceptances.playerId, target.id),
        inArray(partyInviteAcceptances.inviteId, targetInviteRows.map((invite) => invite.id)),
      ));
    }

    await tx.update(playerDevices).set({ playerId: target.id }).where(eq(playerDevices.playerId, source.id));
    await tx.update(players).set({
      loadout: [],
      loadoutRevision: Math.max(source.loadoutRevision, target.loadoutRevision) + 1,
      baseTutorialPhase: source.tutorialRevision > target.tutorialRevision ? source.tutorialPhase : target.tutorialPhase,
      baseTutorialRevision: Math.max(source.tutorialRevision, target.tutorialRevision),
      lastSeenAt: new Date(),
    }).where(eq(players.id, target.id));
    await tx.insert(identityMergeReceipts).values({
      targetPlayerId: target.id,
      sourcePlayerId: source.id,
      issuer: identity.issuer,
      subject: identity.subject,
      conflicts,
    }).onConflictDoNothing();
    // Live rooms can retain the guest UUID across a link. Keep an internal
    // redirect after the source row is removed so later run writes remain
    // authoritative without exposing either UUID to clients.
    await tx.insert(playerAliases).values({ sourcePlayerId: source.id, sourcePublicPlayerId: source.publicPlayerId, targetPlayerId: target.id })
      .onConflictDoUpdate({
        target: playerAliases.sourcePlayerId,
        set: { sourcePublicPlayerId: source.publicPlayerId, targetPlayerId: target.id },
      });
    await tx.delete(players).where(eq(players.id, source.id));
  }

  private async canonicalPlayerId(playerId: string): Promise<string> {
    const [alias] = await this.db.select({ targetPlayerId: playerAliases.targetPlayerId }).from(playerAliases)
      .where(eq(playerAliases.sourcePlayerId, playerId)).limit(1);
    return alias?.targetPlayerId ?? playerId;
  }

  private async ensureBaseLayout(playerId: string): Promise<void> {
    const [existing] = await this.db.select({ slotId: baseLayouts.slotId })
      .from(baseLayouts).where(eq(baseLayouts.playerId, playerId)).limit(1);
    if (existing) return;
    await this.db.insert(baseLayouts).values(layoutRows(playerId, starterBaseLayout)).onConflictDoNothing();
  }
}

export async function connectPostgres(databaseUrl: string): Promise<PostgresPersistence> {
  // Cloud SQL connects over a unix socket passed as ?host=/cloudsql/… — the
  // query param must be lifted into an explicit option (postgres-js ignores
  // it in the URL form, and an empty-authority URL fails to parse at all).
  const socketHost = /[?&]host=([^&]+)/.exec(databaseUrl)?.[1];
  // Strip the param from the URL too: postgres-js forwards leftover query
  // params as server startup parameters, and Postgres rejects "host".
  const cleanedUrl = databaseUrl.replace(/[?&]host=[^&]+/, (match) => (match.startsWith("?") ? "?" : "")).replace(/\?&/, "?").replace(/[?&]$/, "");
  const client = postgres(cleanedUrl, {
    connect_timeout: 5,
    max: 5,
    ...(socketHost?.startsWith("/") ? { host: decodeURIComponent(socketHost) } : {}),
  });
  try {
    await client`select 1`;
    return new PostgresPersistence(client);
  } catch (error) {
    await client.end({ timeout: 1 }).catch(() => undefined);
    throw error;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isRetryableTransactionConflict(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth += 1) {
    const value = candidate as { code?: unknown; cause?: unknown };
    if (value.code === "40P01" || value.code === "40001") return true;
    candidate = value.cause;
  }
  return false;
}

function assertPartyVersion(actual: number, expected: number | undefined): void {
  if (expected !== undefined && (!Number.isInteger(expected) || expected !== actual)) {
    throw new PartyConflictError("party_version_stale", "Party membership changed. Refresh before retrying.");
  }
}

function assertQueueCompatibility(
  claim: { buildId: string; region: string },
  input: { buildId: string; region: string },
): void {
  if (claim.buildId !== input.buildId || claim.region !== input.region) {
    throw new PartyConflictError("party_queued", "This party is already queued for another compatible build or region.");
  }
}

function queueClaimStatus(claim: { status: string; expiresAt: Date }): PartyQueueClaim["status"] {
  if ((claim.status === "active" || claim.status === "cancelling") && claim.expiresAt <= new Date()) return "expired";
  if (claim.status === "active" || claim.status === "cancelling" || claim.status === "cancelled" || claim.status === "completed") {
    return claim.status;
  }
  throw new PartyConflictError("party_membership_conflict", "Party queue claim has an invalid status.");
}

function validatedLoadoutSnapshots(value: unknown): Array<{
  playerId: string;
  name: string;
  loadoutRevision: number;
  loadout: WireItemCode[];
}> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new PartyConflictError("party_membership_conflict", "Party queue claim has an invalid loadout snapshot.");
  }
  const snapshots = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PartyConflictError("party_membership_conflict", "Party queue claim has an invalid loadout snapshot.");
    }
    const candidate = entry as Record<string, unknown>;
    if (Object.keys(candidate).length !== 4 || !["playerId", "name", "loadoutRevision", "loadout"].every((key) => key in candidate)
      || typeof candidate.playerId !== "string" || !isUuid(candidate.playerId)
      || typeof candidate.name !== "string" || candidate.name.length < 1 || candidate.name.length > 24
      || !Number.isSafeInteger(candidate.loadoutRevision) || (candidate.loadoutRevision as number) < 1
      || !Array.isArray(candidate.loadout) || candidate.loadout.length > 4
      || !candidate.loadout.every((item) => typeof item === "string" && (item === "h" || item === "r" || item === "d" || item === "i" || item === "m"))) {
      throw new PartyConflictError("party_membership_conflict", "Party queue claim has an invalid loadout snapshot.");
    }
    return {
      playerId: candidate.playerId.toLowerCase(),
      name: candidate.name,
      loadoutRevision: candidate.loadoutRevision as number,
      loadout: [...candidate.loadout] as WireItemCode[],
    };
  });
  if (new Set(snapshots.map((entry) => entry.playerId)).size !== snapshots.length) {
    throw new PartyConflictError("party_membership_conflict", "Party queue claim has a duplicate loadout snapshot.");
  }
  return snapshots;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeInternalMetadata(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function externalIdentityLockKey(identity: VerifiedExternalIdentity): string {
  return `${identity.issuer.length}:${identity.issuer}${identity.subject}`;
}

function isRunManifest(value: unknown): value is RunManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<RunManifest>;
  return Array.isArray(manifest.keptItems) && Array.isArray(manifest.lostItems) && Array.isArray(manifest.learnedBlueprints);
}

function layoutRows(playerId: string, layout: BaseLayout) {
  return Object.entries(layout).map(([slotId, objectKind]) => ({ playerId, slotId, objectKind }));
}

function canonicalPair(left: string, right: string): [string, string] {
  if (left === right) throw new Error("A player cannot target their own social identity.");
  return left.localeCompare(right) < 0 ? [left, right] : [right, left];
}

function isIdentityProviderKind(value: string): value is IdentityProviderKind {
  return value === "email_link" || value === "phone";
}
