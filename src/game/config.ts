import type { GameConfig } from "./types";

export const defaultGameConfig: GameConfig = {
  tickHz: 60,
  botRadius: 24,
  dotRadius: 10,
  maxShields: 3,
  maxInventoryDots: 4,
  playerSpeed: 230,
  botSpeed: 168,
  dashSpeed: 640,
  dashDurationMs: 145,
  dashCooldownMs: 1300,
  damageSpeed: 360,
  shieldInvulnerabilityMs: 720,
  dotCaptureDurationMs: 1200,
  coverDurationMs: 1850,
  respawnDelayMs: 1200,
  coverCenterTolerance: 12,
  stairHoldMs: 280,
  extractionDurationMs: 4000,
};
