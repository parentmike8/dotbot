import { createHash, randomBytes } from "node:crypto";
import type { AccountSummary, FriendEntry, LinkAccountResult, PartyInviteAcceptance, Persistence, PlayerIdentity, PlayerProfile, PublicPlayer, RegisteredPlayer, VerifiedExternalIdentity } from "./Persistence";
import { DEFAULT_BASE_SHELL, starterBaseLayout } from "@dotbot/game/content/base";
import type { BaseLayout, BaseObjectKind } from "@dotbot/game/types";
import type { WireItemCode } from "@dotbot/protocol";
import { contractDayStamp, generateContractOffers } from "@dotbot/game/contracts";
import { downtownMap } from "@dotbot/game/content/downtown";
import {
  advanceBaseTutorial as advanceTutorialState,
  initialBaseTutorialState,
  type BaseTutorialAction,
  type BaseTutorialState,
} from "@dotbot/game/baseTutorial";
import { PUBLIC_PLAYER_ID_ALPHABET } from "../identity/publicPlayerId";

export class NoopPersistence implements Persistence {
  readonly live: boolean = false;
  private readonly tutorials = new Map<string, BaseTutorialState>();

  async registerPlayer(name: string): Promise<RegisteredPlayer> {
    const token = randomBytes(16).toString("hex");
    this.tutorials.set(token, { ...initialBaseTutorialState });
    return { ...fallbackIdentity(token, name), token };
  }

  async helloPlayer(token: string): Promise<PlayerIdentity | null> {
    return fallbackIdentity(token, "Player");
  }

  async resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity> {
    return fallbackIdentity(token, offeredName);
  }

  async getAccount(token: string): Promise<AccountSummary | null> {
    const identity = fallbackIdentity(token, "Player");
    return { publicPlayerId: identity.publicPlayerId, displayName: identity.name, linked: false, providers: [] };
  }

  async linkAccount(_token: string, _identity: VerifiedExternalIdentity): Promise<LinkAccountResult> {
    throw new Error("Account linking requires live persistence.");
  }

  async createLinkedSession(_identity: VerifiedExternalIdentity): Promise<RegisteredPlayer | null> { return null; }
  async updateDisplayName(_token: string, _displayName: string): Promise<AccountSummary | null> { return null; }
  async updatePrivacy(_token: string, _discoverableByPublicId: boolean): Promise<AccountSummary | null> { return null; }
  async deleteLinkedAccount(_token: string, _identity: VerifiedExternalIdentity): Promise<boolean> { return false; }
  async findPublicPlayer(_token: string, _publicPlayerId: string): Promise<PublicPlayer | null> { return null; }
  async listFriends(_token: string): Promise<FriendEntry[] | null> { return null; }
  async requestFriend(_token: string, _publicPlayerId: string): Promise<FriendEntry | null> { return null; }
  async acceptFriend(_token: string, _publicPlayerId: string): Promise<FriendEntry | null> { return null; }
  async createPartyInvite(_token: string): Promise<{ code: string; expiresAt: string } | null> { return null; }
  async acceptPartyInvite(_token: string, _code: string): Promise<PartyInviteAcceptance | null> { return null; }

  async getProfile(_token: string): Promise<PlayerProfile> {
    return { name: "Player", stash: [], learnedBlueprints: [], recentManifests: [] };
  }

  async getBase(token: string) {
    return { tutorial: { ...(this.tutorials.get(token) ?? initialBaseTutorialState) }, shell: DEFAULT_BASE_SHELL, upgrades: [], layout: { ...starterBaseLayout }, stash: [], learnedBlueprints: [], loadout: [], stashCapacity: 40, presets: [], insertionPreference: null, contractOffers: generateContractOffers(downtownMap, fallbackIdentity(token, "Player").playerId, contractDayStamp()), activeContracts: [] };
  }

  async getBaseTutorialForPlayer(playerId: string): Promise<BaseTutorialState | null> {
    for (const [token, tutorial] of this.tutorials) {
      if (fallbackIdentity(token, "Player").playerId === playerId) return { ...tutorial };
    }
    return null;
  }

  async advanceBaseTutorial(token: string, action: BaseTutorialAction, revision: number) {
    const current = this.tutorials.get(token) ?? { ...initialBaseTutorialState };
    const advanced = advanceTutorialState(current, action);
    if (advanced.changed && revision !== current.revision) throw new Error("Tutorial revision is stale.");
    this.tutorials.set(token, advanced.state);
    return this.getBase(token);
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
  async finishMatch(_input: Parameters<Persistence["finishMatch"]>[0]): Promise<void> {}
  async claimRelayRequest(_requestId: string, _expiresAt: Date): Promise<boolean> {
    throw new Error("Replay protection requires live persistence.");
  }
  async close(): Promise<void> {}
}

function fallbackIdentity(token: string, name: string): PlayerIdentity {
  const digest = createHash("sha256").update(token).digest();
  let publicPlayerId = "";
  for (let index = 0; index < 8; index += 1) {
    publicPlayerId += PUBLIC_PLAYER_ID_ALPHABET[digest[index] % PUBLIC_PLAYER_ID_ALPHABET.length];
  }
  return { playerId: `p-${digest.toString("hex").slice(0, 24)}`, publicPlayerId, name };
}
