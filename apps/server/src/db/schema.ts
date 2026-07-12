import { integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  deviceTokenHash: text("device_token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("players_device_token_hash_unique").on(table.deviceTokenHash)]);

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
  extractedManifest: jsonb("extracted_manifest"),
}, (table) => [primaryKey({ columns: [table.matchId, table.playerId] })]);

export const learnedBlueprints = pgTable("learned_blueprints", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  blueprintId: text("blueprint_id").notNull(),
  learnedAt: timestamp("learned_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.playerId, table.blueprintId] })]);
