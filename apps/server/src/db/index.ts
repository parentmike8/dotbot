import { NoopPersistence } from "./NoopPersistence";
import type { Persistence } from "./Persistence";
import { connectPostgres } from "./PostgresPersistence";

export type { Persistence, PlayerBase, PlayerIdentity, PlayerProfile, RecentManifest, RegisteredPlayer, RunManifest } from "./Persistence";
export { NoopPersistence } from "./NoopPersistence";

export async function createPersistence(databaseUrl: string | null | undefined = process.env.DATABASE_URL): Promise<Persistence> {
  if (!databaseUrl) {
    console.warn("[persistence] DATABASE_URL is unset; continuing without database persistence.");
    return new NoopPersistence();
  }
  try {
    const persistence = await connectPostgres(databaseUrl);
    console.info("[persistence] connected to Postgres.");
    return persistence;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[persistence] Postgres unavailable; continuing without database persistence. ${reason}`);
    return new NoopPersistence();
  }
}
