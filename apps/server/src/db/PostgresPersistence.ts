import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { WireItemCode } from "@dotbot/protocol";
import { starterBaseLayout } from "@dotbot/game/content/base";
import type { BaseLayout } from "@dotbot/game/types";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type {
  Persistence,
  PlayerIdentity,
  PlayerProfile,
  RegisteredPlayer,
  RunManifest,
} from "./Persistence";
import { baseLayouts, learnedBlueprints, matchParticipants, matchResults, players, stashItems } from "./schema";

export class PostgresPersistence implements Persistence {
  readonly live = true;
  private readonly db: PostgresJsDatabase;

  constructor(private readonly client: Sql) {
    this.db = drizzle(client);
  }

  async registerPlayer(name: string): Promise<RegisteredPlayer> {
    const token = randomBytes(16).toString("hex");
    const player = await this.db.transaction(async (tx) => {
      const [created] = await tx.insert(players).values({
        displayName: name,
        deviceTokenHash: hashToken(token),
      }).returning({ id: players.id, name: players.displayName });
      await tx.insert(baseLayouts).values(layoutRows(created.id, starterBaseLayout));
      return created;
    });
    return { playerId: player.id, name: player.name, token };
  }

  async helloPlayer(token: string): Promise<PlayerIdentity | null> {
    const [player] = await this.db.update(players)
      .set({ lastSeenAt: new Date() })
      .where(eq(players.deviceTokenHash, hashToken(token)))
      .returning({ id: players.id, name: players.displayName });
    return player ? { playerId: player.id, name: player.name } : null;
  }

  async resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity> {
    const existing = await this.helloPlayer(token);
    if (existing) return existing;
    const tokenHash = hashToken(token);
    const [player] = await this.db.insert(players).values({
      displayName: offeredName,
      deviceTokenHash: tokenHash,
    }).onConflictDoUpdate({
      target: players.deviceTokenHash,
      set: { displayName: offeredName, lastSeenAt: new Date() },
    }).returning({ id: players.id, name: players.displayName });
    await this.ensureBaseLayout(player.id);
    return { playerId: player.id, name: player.name };
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
    const [layout, stash, learned, player] = await Promise.all([
      this.db.select({ slotId: baseLayouts.slotId, objectKind: baseLayouts.objectKind })
        .from(baseLayouts).where(eq(baseLayouts.playerId, identity.playerId)),
      this.db.select({ itemType: stashItems.itemType, qty: sql<number>`sum(${stashItems.qty})::int` })
        .from(stashItems).where(eq(stashItems.playerId, identity.playerId)).groupBy(stashItems.itemType),
      this.db.select({ blueprintId: learnedBlueprints.blueprintId })
        .from(learnedBlueprints).where(eq(learnedBlueprints.playerId, identity.playerId)),
      this.db.select({ loadout: players.loadout }).from(players).where(eq(players.id, identity.playerId)).limit(1),
    ]);
    return {
      layout: Object.fromEntries(layout.map((row) => [row.slotId, row.objectKind])) as BaseLayout,
      stash: stash.map((row) => ({ itemType: row.itemType as WireItemCode, qty: Number(row.qty) })),
      learnedBlueprints: learned.map((row) => row.blueprintId),
      loadout: player[0]?.loadout ?? [],
    };
  }

  async saveBaseLayout(token: string, layout: BaseLayout): Promise<BaseLayout | null> {
    const identity = await this.helloPlayer(token);
    if (!identity) return null;
    await this.db.transaction(async (tx) => {
      await tx.delete(baseLayouts).where(eq(baseLayouts.playerId, identity.playerId));
      const rows = layoutRows(identity.playerId, layout);
      if (rows.length > 0) await tx.insert(baseLayouts).values(rows);
    });
    return layout;
  }

  async setLoadout(token: string, loadout: WireItemCode[]) {
    const tokenHash = hashToken(token);
    await this.db.transaction(async (tx) => {
      const [player] = await tx.select({ id: players.id, loadout: players.loadout })
        .from(players).where(eq(players.deviceTokenHash, tokenHash)).limit(1).for("update");
      if (!player) throw new Error("Unknown device token.");

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
      await tx.update(players).set({ loadout }).where(eq(players.id, player.id));
    });
    return this.getBase(token);
  }

  async consumeLoadout(playerId: string): Promise<WireItemCode[]> {
    return this.db.transaction(async (tx) => {
      const [player] = await tx.select({ loadout: players.loadout })
        .from(players).where(eq(players.id, playerId)).limit(1).for("update");
      const loadout = player?.loadout ?? [];
      if (player && loadout.length > 0) await tx.update(players).set({ loadout: [] }).where(eq(players.id, playerId));
      return loadout;
    });
  }

  async startMatch(input: { matchId: string; roomCode: string; mapId: string; startedAt: Date }): Promise<void> {
    await this.db.insert(matchResults).values({
      id: input.matchId,
      roomCode: input.roomCode,
      mapId: input.mapId,
      startedAt: input.startedAt,
    });
  }

  async recordExtraction(input: {
    matchId: string;
    playerId: string;
    manifest: RunManifest;
    blueprintLearningThreshold: number;
  }): Promise<{ learnedBlueprints: string[] }> {
    return this.db.transaction(async (tx) => {
      if (input.manifest.keptItems.length > 0) {
        await tx.insert(stashItems).values(input.manifest.keptItems.map((itemType) => ({
          playerId: input.playerId,
          itemType,
          qty: 1,
          acquiredMatchId: input.matchId,
        })));
      }

      const newlyLearned: string[] = [];
      const extractedBlueprints = new Set(input.manifest.keptItems
        .filter((code): code is `b:${string}` => code.startsWith("b:"))
        .map((code) => code.slice(2)));
      for (const blueprintId of extractedBlueprints) {
        const code = `b:${blueprintId}`;
        const [existing] = await tx.select({ blueprintId: learnedBlueprints.blueprintId })
          .from(learnedBlueprints)
          .where(and(eq(learnedBlueprints.playerId, input.playerId), eq(learnedBlueprints.blueprintId, blueprintId)))
          .limit(1);
        const [count] = await tx.select({ total: sql<number>`coalesce(sum(${stashItems.qty}), 0)::int` })
          .from(stashItems)
          .where(and(eq(stashItems.playerId, input.playerId), eq(stashItems.itemType, code)));
        if (existing || Number(count?.total ?? 0) >= input.blueprintLearningThreshold) {
          if (!existing) {
            await tx.insert(learnedBlueprints).values({ playerId: input.playerId, blueprintId });
            newlyLearned.push(blueprintId);
          }
          await tx.delete(stashItems)
            .where(and(eq(stashItems.playerId, input.playerId), eq(stashItems.itemType, code)));
        }
      }

      const manifest = { ...input.manifest, learnedBlueprints: newlyLearned };
      await tx.insert(matchParticipants).values({
        matchId: input.matchId,
        playerId: input.playerId,
        outcome: "extracted",
        extractedManifest: manifest,
      }).onConflictDoUpdate({
        target: [matchParticipants.matchId, matchParticipants.playerId],
        set: { outcome: "extracted", extractedManifest: manifest },
      });
      return { learnedBlueprints: newlyLearned };
    });
  }

  async recordOutcome(input: { matchId: string; playerId: string; outcome: "died" | "timeout" | "disconnected" }): Promise<void> {
    await this.db.insert(matchParticipants).values(input).onConflictDoUpdate({
      target: [matchParticipants.matchId, matchParticipants.playerId],
      set: { outcome: input.outcome },
    });
  }

  async finishMatch(input: { matchId: string; endedAt: Date; summary: unknown }): Promise<void> {
    await this.db.update(matchResults).set({ endedAt: input.endedAt, summary: input.summary }).where(eq(matchResults.id, input.matchId));
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 2 });
  }

  private async ensureBaseLayout(playerId: string): Promise<void> {
    const [existing] = await this.db.select({ slotId: baseLayouts.slotId })
      .from(baseLayouts).where(eq(baseLayouts.playerId, playerId)).limit(1);
    if (existing) return;
    await this.db.insert(baseLayouts).values(layoutRows(playerId, starterBaseLayout)).onConflictDoNothing();
  }
}

export async function connectPostgres(databaseUrl: string): Promise<PostgresPersistence> {
  const client = postgres(databaseUrl, { connect_timeout: 5, max: 5 });
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

function isRunManifest(value: unknown): value is RunManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<RunManifest>;
  return Array.isArray(manifest.keptItems) && Array.isArray(manifest.lostItems) && Array.isArray(manifest.learnedBlueprints);
}

function layoutRows(playerId: string, layout: BaseLayout) {
  return Object.entries(layout).map(([slotId, objectKind]) => ({ playerId, slotId, objectKind }));
}
