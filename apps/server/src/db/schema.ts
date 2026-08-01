import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { BaseShellId, ContractDefinition, LoadoutPreset } from "@dotbot/game/types";
import type { WireItemCode } from "@dotbot/protocol";
import type { BaseTutorialPhase } from "@dotbot/game/baseTutorial";

export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicPlayerId: text("public_player_id").notNull(),
  displayName: text("display_name").notNull(),
  discoverableByPublicId: boolean("discoverable_by_public_id").notNull().default(true),
  deviceTokenHash: text("device_token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  loadout: jsonb("loadout").$type<WireItemCode[]>().notNull().default([]),
  /** Incremented for every loadout replacement or match-time consumption. */
  loadoutRevision: integer("loadout_revision").notNull().default(1),
  /** Cosmetic floor-plan choice; every shell has identical slots. */
  baseShell: text("base_shell").$type<BaseShellId>().notNull().default("workshop"),
  presets: jsonb("presets").$type<LoadoutPreset[]>().notNull().default([]),
  insertionPreference: text("insertion_pref"),
  contractReroll: integer("contract_reroll").notNull().default(0),
  /** Existing accounts migrate complete; new registrations explicitly start at movement. */
  baseTutorialPhase: text("base_tutorial_phase").$type<BaseTutorialPhase>().notNull().default("complete"),
  baseTutorialRevision: integer("base_tutorial_revision").notNull().default(4),
}, (table) => [
  uniqueIndex("players_device_token_hash_unique").on(table.deviceTokenHash),
  uniqueIndex("players_public_player_id_unique").on(table.publicPlayerId),
]);

export const playerDevices = pgTable("player_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("player_devices_token_hash_unique").on(table.tokenHash)]);

/** Redirects an in-memory dedicated session's former UUID after an account merge. */
export const playerAliases = pgTable("player_aliases", {
  sourcePlayerId: uuid("source_player_id").primaryKey(),
  sourcePublicPlayerId: text("source_public_player_id").notNull(),
  targetPlayerId: uuid("target_player_id").references(() => players.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("player_aliases_source_public_player_id_unique").on(table.sourcePublicPlayerId)]);

export const externalIdentities = pgTable("external_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("external_identities_player_unique").on(table.playerId),
  uniqueIndex("external_identities_issuer_subject_unique").on(table.issuer, table.subject),
]);

export const identityProviders = pgTable("identity_providers", {
  externalIdentityId: uuid("external_identity_id").notNull().references(() => externalIdentities.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  firstVerifiedAt: timestamp("first_verified_at", { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.externalIdentityId, table.provider] })]);

export const identityMergeReceipts = pgTable("identity_merge_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetPlayerId: uuid("target_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  sourcePlayerId: uuid("source_player_id").notNull(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  conflicts: jsonb("conflicts").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("identity_merge_source_external_unique").on(table.sourcePlayerId, table.issuer, table.subject)]);

export const friendships = pgTable("friendships", {
  playerLowId: uuid("player_low_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  playerHighId: uuid("player_high_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  requestedById: uuid("requested_by_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.playerLowId, table.playerHighId] })]);

export const playerBlocks = pgTable("player_blocks", {
  blockerPlayerId: uuid("blocker_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  blockedPlayerId: uuid("blocked_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.blockerPlayerId, table.blockedPlayerId] })]);

/** Durable pre-run party authority. The random matchmaking key, not this UUID,
 * crosses the signed control-plane/AWS boundary. */
export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchmakingKey: text("matchmaking_key").notNull(),
  version: integer("version").notNull().default(1),
  leaderPlayerId: uuid("leader_player_id").notNull().references(() => players.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("parties_matchmaking_key_unique").on(table.matchmakingKey)]);

export const partyMembers = pgTable("party_members", {
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "restrict" }),
  /** Present only while membership is owned by one unlinked guest device. */
  guestDeviceId: uuid("guest_device_id").references(() => playerDevices.id, { onDelete: "set null" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.partyId, table.playerId] }),
  uniqueIndex("party_members_player_unique").on(table.playerId),
]);

export const partyInvites = pgTable("party_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull(),
  ownerPlayerId: uuid("owner_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  partyId: uuid("party_id").references(() => parties.id, { onDelete: "cascade" }),
  rosterVersion: integer("roster_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revoked: boolean("revoked").notNull().default(false),
}, (table) => [uniqueIndex("party_invites_token_hash_unique").on(table.tokenHash)]);

export const partyInviteAcceptances = pgTable("party_invite_acceptances", {
  inviteId: uuid("invite_id").notNull().references(() => partyInvites.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  guestDeviceId: uuid("guest_device_id").references(() => playerDevices.id, { onDelete: "set null" }),
  durable: boolean("durable").notNull().default(false),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.inviteId, table.playerId] })]);

/** Cloud SQL lease that freezes one canonical roster while AWS allocates it. */
export const partyQueueClaims = pgTable("party_queue_claims", {
  id: uuid("id").primaryKey(),
  partyId: uuid("party_id").references(() => parties.id, { onDelete: "cascade" }),
  requestingPlayerId: uuid("requesting_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  partyVersion: integer("party_version").notNull(),
  buildId: text("build_id").notNull(),
  region: text("region").notNull(),
  loadoutSnapshots: jsonb("loadout_snapshots").$type<Array<{
    playerId: string;
    name: string;
    loadoutRevision: number;
    loadout: WireItemCode[];
  }>>().notNull().default([]),
  status: text("status").notNull().default("active"),
  startedMatchId: uuid("started_match_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("party_queue_claims_party_status_idx").on(table.partyId, table.status, table.expiresAt),
  index("party_queue_claims_requester_status_idx").on(table.requestingPlayerId, table.status, table.expiresAt),
]);

export const matchResults = pgTable("match_results", {
  id: uuid("id").primaryKey(),
  roomCode: text("room_code").notNull(),
  mapId: text("map_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  summary: jsonb("summary"),
});

/** Persistent STASH items. The physical M3 table remains `hold_items`; HOLD now means only the in-run backpack. */
export const stashItems = pgTable("hold_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  itemType: text("item_type").notNull(),
  qty: integer("qty").notNull(),
  acquiredMatchId: uuid("acquired_match_id").references(() => matchResults.id, { onDelete: "set null" }),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matchParticipants = pgTable("match_participants", {
  matchId: uuid("match_id").notNull().references(() => matchResults.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  startingLoadout: jsonb("starting_loadout").$type<WireItemCode[]>().notNull().default([]),
  extractedManifest: jsonb("extracted_manifest"),
}, (table) => [primaryKey({ columns: [table.matchId, table.playerId] })]);

/** Short-lived replay ledger for signed AWS-to-control-plane persistence calls. */
export const relayRequests = pgTable("relay_requests", {
  id: uuid("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const learnedBlueprints = pgTable("learned_blueprints", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  blueprintId: text("blueprint_id").notNull(),
  learnedAt: timestamp("learned_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.playerId, table.blueprintId] })]);

export const baseLayouts = pgTable("base_layouts", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  slotId: text("slot_id").notNull(),
  objectKind: text("object_kind").notNull(),
}, (table) => [primaryKey({ columns: [table.playerId, table.slotId] })]);

export const baseUpgrades = pgTable("base_upgrades", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  upgradeId: text("upgrade_id").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.playerId, table.upgradeId] })]);

export const contracts = pgTable("contracts", {
  id: text("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  contract: jsonb("contract").$type<ContractDefinition>().notNull(),
  status: text("status").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
});
