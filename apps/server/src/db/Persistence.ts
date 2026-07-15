import type { WireItemCode } from "@dotbot/protocol";
import type { BaseLayout, BaseShellId, ContractDefinition, Item, LoadoutPreset, WirePowerupCode } from "@dotbot/game/types";
import type { Recipe } from "@dotbot/game/content/recipes";

export type PlayerIdentity = {
  playerId: string;
  name: string;
};

export type RegisteredPlayer = PlayerIdentity & {
  token: string;
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
  shell: BaseShellId;
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
  missing: Array<{ itemType: WirePowerupCode; qty: number }>;
};

export interface Persistence {
  readonly live: boolean;
  registerPlayer(name: string): Promise<RegisteredPlayer>;
  helloPlayer(token: string): Promise<PlayerIdentity | null>;
  resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity>;
  getProfile(token: string): Promise<PlayerProfile | null>;
  getBase(token: string): Promise<PlayerBase | null>;
  saveBaseLayout(token: string, layout: BaseLayout): Promise<BaseLayout | null>;
  setBaseShell(token: string, shell: BaseShellId): Promise<PlayerBase | null>;
  setLoadout(token: string, loadout: WireItemCode[]): Promise<PlayerBase | null>;
  fabricate(token: string, recipeId: string, slotId?: string): Promise<FabricationResult | null>;
  savePresets(token: string, presets: LoadoutPreset[]): Promise<PlayerBase | null>;
  applyPreset(token: string, presetIndex: number): Promise<PresetApplyResult | null>;
  setInsertionPreference(token: string, insertionPointId: string | null): Promise<string | null>;
  getInsertionPreference(playerId: string): Promise<string | null>;
  acceptContract(token: string, contractId: string): Promise<void>;
  rerollContracts(token: string): Promise<void>;
  abandonContract(token: string, contractId: string): Promise<void>;
  consumeLoadout(playerId: string): Promise<WireItemCode[]>;
  startMatch(input: { matchId: string; roomCode: string; mapId: string; startedAt: Date }): Promise<void>;
  recordExtraction(input: {
    matchId: string;
    playerId: string;
    manifest: RunManifest;
    blueprintLearningThreshold: number;
  }): Promise<{ manifest: RunManifest }>;
  recordOutcome(input: { matchId: string; playerId: string; outcome: "died" | "timeout" | "disconnected" }): Promise<void>;
  finishMatch(input: { matchId: string; endedAt: Date; summary: unknown }): Promise<void>;
  close(): Promise<void>;
}
