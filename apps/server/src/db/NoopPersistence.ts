import { createHash, randomBytes } from "node:crypto";
import type { Persistence, PlayerIdentity, PlayerProfile, RegisteredPlayer } from "./Persistence";

export class NoopPersistence implements Persistence {
  readonly live = false;

  async registerPlayer(name: string): Promise<RegisteredPlayer> {
    const token = randomBytes(16).toString("hex");
    return { ...fallbackIdentity(token, name), token };
  }

  async helloPlayer(token: string): Promise<PlayerIdentity> {
    return fallbackIdentity(token, "Player");
  }

  async resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity> {
    return fallbackIdentity(token, offeredName);
  }

  async getProfile(_token: string): Promise<PlayerProfile> {
    return { name: "Player", holdDots: 0, recentManifests: [] };
  }

  async startMatch(): Promise<void> {}
  async recordExtraction(): Promise<void> {}
  async recordOutcome(): Promise<void> {}
  async finishMatch(): Promise<void> {}
  async close(): Promise<void> {}
}

function fallbackIdentity(token: string, name: string): PlayerIdentity {
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return { playerId: `p-${digest}`, name };
}
