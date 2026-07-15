import type { WireItemCode } from "@dotbot/protocol";
import type { BaseLayout } from "@dotbot/game/types";

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
};

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
  layout: BaseLayout;
  stash: Array<{ itemType: WireItemCode; qty: number }>;
  learnedBlueprints: string[];
  loadout: WireItemCode[];
};

export interface Persistence {
  readonly live: boolean;
  registerPlayer(name: string): Promise<RegisteredPlayer>;
  helloPlayer(token: string): Promise<PlayerIdentity | null>;
  resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity>;
  getProfile(token: string): Promise<PlayerProfile | null>;
  getBase(token: string): Promise<PlayerBase | null>;
  saveBaseLayout(token: string, layout: BaseLayout): Promise<BaseLayout | null>;
  setLoadout(token: string, loadout: WireItemCode[]): Promise<PlayerBase | null>;
  consumeLoadout(playerId: string): Promise<WireItemCode[]>;
  startMatch(input: { matchId: string; roomCode: string; mapId: string; startedAt: Date }): Promise<void>;
  recordExtraction(input: {
    matchId: string;
    playerId: string;
    manifest: RunManifest;
    blueprintLearningThreshold: number;
  }): Promise<{ learnedBlueprints: string[] }>;
  recordOutcome(input: { matchId: string; playerId: string; outcome: "died" | "timeout" | "disconnected" }): Promise<void>;
  finishMatch(input: { matchId: string; endedAt: Date; summary: unknown }): Promise<void>;
  close(): Promise<void>;
}
