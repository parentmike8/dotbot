import { randomBytes } from "node:crypto";
import type { Persistence, PlayerIdentity, PlayerProfile, RegisteredPlayer } from "./Persistence";
import { DEFAULT_BASE_SHELL, starterBaseLayout } from "@dotbot/game/content/base";
import type { BaseLayout, BaseObjectKind } from "@dotbot/game/types";
import type { WireItemCode } from "@dotbot/protocol";
import { contractDayStamp, generateContractOffers } from "@dotbot/game/contracts";
import { downtownMap } from "@dotbot/game/content/downtown";

export class NoopPersistence implements Persistence {
  readonly live: boolean = false;

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
    return { name: "Player", stash: [], learnedBlueprints: [], recentManifests: [] };
  }

  async getBase(token: string) {
    return { shell: DEFAULT_BASE_SHELL, upgrades: [], layout: { ...starterBaseLayout }, stash: [], learnedBlueprints: [], loadout: [], stashCapacity: 40, presets: [], insertionPreference: null, contractOffers: generateContractOffers(downtownMap, fallbackIdentity(token, "Player").playerId, contractDayStamp()), activeContracts: [] };
  }

  async saveBaseLayout(_token: string, layout: BaseLayout): Promise<BaseLayout> { return layout; }
  async setBaseShell(): Promise<null> { return null; }
  async setLoadout(): Promise<null> { return null; }
  async fabricate(): Promise<null> { return null; }
  async savePresets(): Promise<null> { return null; }
  async applyPreset(): Promise<null> { return null; }
  async setInsertionPreference(_token: string, _insertionPointId: string | null): Promise<string | null> { return null; }
  async getInsertionPreference(_playerId: string): Promise<string | null> { return null; }
  async getMatchIntelObjects(_playerId: string): Promise<BaseObjectKind[]> { return []; }
  async acceptContract(): Promise<void> {}
  async rerollContracts(): Promise<void> {}
  async abandonContract(): Promise<void> {}
  async consumeLoadout(): Promise<WireItemCode[]> { return []; }

  async startMatch(input: Parameters<Persistence["startMatch"]>[0]): ReturnType<Persistence["startMatch"]> {
    return { loadouts: Object.fromEntries(input.playerIds.map((playerId) => [playerId, []])) };
  }
  async recordExtraction(input: Parameters<Persistence["recordExtraction"]>[0]): Promise<{ manifest: import("./Persistence").RunManifest }> {
    return { manifest: input.manifest };
  }
  async recordOutcome(_input: Parameters<Persistence["recordOutcome"]>[0]): Promise<void> {}
  async finishMatch(): Promise<void> {}
  async claimRelayRequest(_requestId: string, _expiresAt: Date): Promise<boolean> {
    throw new Error("Replay protection requires live persistence.");
  }
  async close(): Promise<void> {}
}

function fallbackIdentity(token: string, name: string): PlayerIdentity {
  const safeToken = token.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "") || "anonymous";
  return { playerId: `p-${safeToken}`, name };
}
