export type PlayerIdentity = {
  playerId: string;
  name: string;
};

export type RegisteredPlayer = PlayerIdentity & {
  token: string;
};

export type RunManifest = {
  reason: "extracted" | "died" | "timeout";
  keptDots: number;
  lostDots: number;
};

export type RecentManifest = {
  roomCode: string;
  outcome: string;
  keptDots: number;
  lostDots: number;
  endedAt: string | null;
};

export type PlayerProfile = {
  name: string;
  holdDots: number;
  recentManifests: RecentManifest[];
};

export interface Persistence {
  readonly live: boolean;
  registerPlayer(name: string): Promise<RegisteredPlayer>;
  helloPlayer(token: string): Promise<PlayerIdentity | null>;
  resolveOrRegisterPlayer(token: string, offeredName: string): Promise<PlayerIdentity>;
  getProfile(token: string): Promise<PlayerProfile | null>;
  startMatch(input: { matchId: string; roomCode: string; mapId: string; startedAt: Date }): Promise<void>;
  recordExtraction(input: { matchId: string; playerId: string; manifest: RunManifest }): Promise<void>;
  recordOutcome(input: { matchId: string; playerId: string; outcome: "died" | "timeout" | "disconnected" }): Promise<void>;
  finishMatch(input: { matchId: string; endedAt: Date; summary: unknown }): Promise<void>;
  close(): Promise<void>;
}
