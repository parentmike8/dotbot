import type { WireItemCode } from "@dotbot/protocol";
import type { BaseLayout, BaseObjectKind, BaseShellId, ContractDefinition, Item, LoadoutPreset, WireLoadoutCode } from "@dotbot/game/types";
import type { Recipe } from "@dotbot/game/content/recipes";
import type { BaseTutorialAction, BaseTutorialState } from "@dotbot/game/baseTutorial";

export class PersistenceConflictError extends Error {}

export type PartyConflictCode =
  | "party_full"
  | "party_queued"
  | "party_version_stale"
  | "party_leader_required"
  | "party_link_required"
  | "party_membership_conflict"
  | "party_invite_invalid";

export class PartyConflictError extends PersistenceConflictError {
  constructor(readonly code: PartyConflictCode, message: string) {
    super(message);
  }
}

export type PlayerIdentity = {
  /** Cloud SQL authority key. Never serialize this value to a public client. */
  playerId: string;
  /** Retired Cloud SQL keys accepted only at signed reservation/persistence boundaries. */
  previousPlayerIds?: string[];
  /** Immutable eight-character lookup id, stored without its display hyphen. */
  publicPlayerId: string;
  /** Retired public IDs accepted only for in-flight reservation reconciliation. */
  previousPublicPlayerIds?: string[];
  name: string;
};

export type RegisteredPlayer = PlayerIdentity & {
  token: string;
};

export type IdentityProviderKind = "email_link" | "phone";

export type VerifiedExternalIdentity = {
  issuer: string;
  subject: string;
  provider: IdentityProviderKind;
  /** Firebase auth_time in epoch milliseconds; used for destructive reauthentication. */
  authenticatedAt: number;
};

export type PublicPlayer = {
  publicPlayerId: string;
  displayName: string;
};

export type AccountSummary = PublicPlayer & {
  linked: boolean;
  providers: IdentityProviderKind[];
};

export type LinkAccountResult = {
  account: AccountSummary;
  merged: boolean;
  replayed: boolean;
};

export type FriendEntry = PublicPlayer & {
  status: "incoming" | "outgoing" | "friends";
};

export type PartyInviteAcceptance = {
  inviter: PublicPlayer;
  durable: boolean;
  expiresAt: string;
  party?: PartySummary;
  replayed?: boolean;
};

export type PartyMemberSummary = PublicPlayer & {
  leader: boolean;
};

export type PartySummary = {
  version: number;
  members: PartyMemberSummary[];
  canInvite: boolean;
};

export type DurablePartyInvite = {
  code: string;
  expiresAt: string;
  party: PartySummary;
};

export type PartyQueueClaim = {
  claimId: string;
  partyId: string;
  version: number;
  leaderPlayerId: string;
  requestingPlayerId: string;
  buildId: string;
  region: string;
  members: Array<{ playerId: string; name: string }>;
};

export type RunManifest = {
  reason: "extracted" | "died" | "timeout";
  keptItems: WireItemCode[];
  lostItems: WireItemCode[];
  learnedBlueprints: string[];
  cargo?: Item[];
  contractCompletions?: ContractCompletion[];
};

export type ContractCompletion = { contractId: string; title: string; payout: WireItemCode[] };

export type RecentManifest = {
  roomCode: string;
  outcome: string;
  keptItems: WireItemCode[];
  lostItems: WireItemCode[];
  learnedBlueprints: string[];
  endedAt: string | null;
};

export type PlayerProfile = {
  name: string;
  stash: Array<{ itemType: WireItemCode; qty: number }>;
  learnedBlueprints: string[];
  recentManifests: RecentManifest[];
};

export type PlayerBase = {
  tutorial: BaseTutorialState;
  shell: BaseShellId;
  upgrades: string[];
  layout: BaseLayout;
  stash: Array<{ itemType: WireItemCode; qty: number }>;
  learnedBlueprints: string[];
  loadout: WireItemCode[];
  stashCapacity: number;
  presets: LoadoutPreset[];
  insertionPreference: string | null;
  contractOffers: ContractDefinition[];
  activeContracts: ContractDefinition[];
};

export type FabricationResult = {
  base: PlayerBase;
  output: Recipe["output"];
  slotId?: string;
};

export type PresetApplyResult = {
  base: PlayerBase;
  missing: Array<{ itemType: WireLoadoutCode; qty: number }>;
};

export type MatchStartResult = {
  /** Loadouts are consumed once, in the same transaction that registers the match roster. */
  loadouts: Record<string, WireItemCode[]>;
};

export interface Persistence {
  readonly live: boolean;
  registerPlayer(name: string): Promise<RegisteredPlayer>;
  helloPlayer(token: string): Promise<PlayerIdentity | null>;
  resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity>;
  getAccount(token: string): Promise<AccountSummary | null>;
  linkAccount(token: string, identity: VerifiedExternalIdentity): Promise<LinkAccountResult>;
  createLinkedSession(identity: VerifiedExternalIdentity): Promise<RegisteredPlayer | null>;
  updateDisplayName(token: string, displayName: string): Promise<AccountSummary | null>;
  updatePrivacy(token: string, discoverableByPublicId: boolean): Promise<AccountSummary | null>;
  deleteLinkedAccount(token: string, identity: VerifiedExternalIdentity): Promise<boolean>;
  findPublicPlayer(token: string, publicPlayerId: string): Promise<PublicPlayer | null>;
  listFriends(token: string): Promise<FriendEntry[] | null>;
  requestFriend(token: string, publicPlayerId: string): Promise<FriendEntry | null>;
  acceptFriend(token: string, publicPlayerId: string): Promise<FriendEntry | null>;
  createPartyInvite(token: string): Promise<{ code: string; expiresAt: string } | null>;
  acceptPartyInvite(token: string, code: string): Promise<PartyInviteAcceptance | null>;
  getParty(token: string): Promise<PartySummary | null>;
  createDurablePartyInvite(token: string): Promise<DurablePartyInvite | null>;
  revokeDurablePartyInvites(token: string): Promise<PartySummary | null>;
  acceptDurablePartyInvite(token: string, code: string): Promise<PartyInviteAcceptance | null>;
  leaveParty(token: string, expectedVersion?: number): Promise<PartySummary | null>;
  disbandParty(token: string, expectedVersion?: number): Promise<boolean>;
  transferPartyLeader(token: string, publicPlayerId: string, expectedVersion?: number): Promise<PartySummary | null>;
  claimPartyQueue(token: string, input: { requestId: string; buildId: string; region: string }): Promise<PartyQueueClaim>;
  cancelPartyQueue(token: string, claimId: string): Promise<PartyQueueClaim | null>;
  completePartyQueueCancellation(token: string, claimId: string): Promise<boolean>;
  getProfile(token: string): Promise<PlayerProfile | null>;
  getBase(token: string): Promise<PlayerBase | null>;
  getBaseTutorialForPlayer(playerId: string): Promise<BaseTutorialState | null>;
  advanceBaseTutorial(token: string, action: BaseTutorialAction, revision: number): Promise<PlayerBase | null>;
  saveBaseLayout(token: string, layout: BaseLayout): Promise<BaseLayout | null>;
  setBaseShell(token: string, shell: BaseShellId): Promise<PlayerBase | null>;
  setLoadout(token: string, loadout: WireItemCode[]): Promise<PlayerBase | null>;
  fabricate(token: string, recipeId: string, slotId?: string): Promise<FabricationResult | null>;
  savePresets(token: string, presets: LoadoutPreset[]): Promise<PlayerBase | null>;
  applyPreset(token: string, presetIndex: number): Promise<PresetApplyResult | null>;
  setInsertionPreference(token: string, insertionPointId: string | null): Promise<string | null>;
  getInsertionPreference(playerId: string): Promise<string | null>;
  getMatchIntelObjects(playerId: string): Promise<BaseObjectKind[]>;
  acceptContract(token: string, contractId: string): Promise<void>;
  rerollContracts(token: string): Promise<void>;
  abandonContract(token: string, contractId: string): Promise<void>;
  consumeLoadout(playerId: string): Promise<WireItemCode[]>;
  startMatch(input: { matchId: string; roomCode: string; mapId: string; startedAt: Date; playerIds: string[] }): Promise<MatchStartResult>;
  recordExtraction(input: {
    matchId: string;
    playerId: string;
    manifest: RunManifest;
    blueprintLearningThreshold: number;
  }): Promise<{ manifest: RunManifest }>;
  recordOutcome(input: { matchId: string; playerId: string; outcome: "died" | "timeout" | "disconnected" }): Promise<void>;
  finishMatch(input: { matchId: string; endedAt: Date; summary: unknown }): Promise<void>;
  /** Atomically reserves a signed relay request id. False means it was already used. */
  claimRelayRequest(requestId: string, expiresAt: Date): Promise<boolean>;
  close(): Promise<void>;
}
