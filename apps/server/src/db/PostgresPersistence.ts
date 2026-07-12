import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { WireItemCode } from "@dotbot/protocol";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type {
  Persistence,
  PlayerIdentity,
  PlayerProfile,
  RegisteredPlayer,
  RunManifest,
} from "./Persistence";
import { learnedBlueprints, matchParticipants, matchResults, players, stashItems } from "./schema";

export class PostgresPersistence implements Persistence {
  readonly live = true;
  private readonly db: PostgresJsDatabase;

  constructor(private readonly client: Sql) {
    this.db = drizzle(client);
  }

  async registerPlayer(name: string): Promise<RegisteredPlayer> {
    const token = randomBytes(16).toString("hex");
    const [player] = await this.db.insert(players).values({
      displayName: name,
      deviceTokenHash: hashToken(token),
    }).returning({ id: players.id, name: players.displayName });
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
