import type { GameConfig } from "./types";

export const defaultGameConfig: GameConfig = {
  tickHz: 60,
  botRadius: 24,
  dotRadius: 10,
  maxShields: 3,
  baySlots: 4,
  holdSlots: 12,
  radarDurationMs: 8000,
  radarPingIntervalMs: 2000,
  radarRadius: 600,
  radarPingTtlMs: 2000,
  mineSenseRadius: 300,
  mineSensePingMs: 2000,
  maxActiveMines: 3,
  signalIntelDurationMs: 60_000,
  dashOverchargeUses: 3,
  incognitoDurationMs: 10_000,
  powerupNoiseLoudness: 0.3,
  swapDurationMs: 2000,
  blueprintLearningThreshold: 3,
  playerSpeed: 230,
  botSpeed: 168,
  dashSpeed: 640,
  dashDurationMs: 145,
  dashCooldownMs: 1300,
  damageSpeed: 360,
  /** Alive bots shoulder past each other at most this fast (px/s). */
  // Must exceed playerSpeed so a walker cannot grind through a standing
  // body; the anchor rule (movers yield, stationary bots don't) keeps this
  // from ever shoving anyone.
  botSeparationSpeed: 300,
  /** A qualifying hit knocks the target back at this speed, decaying… */
  knockbackSpeed: 320,
  /** …over this window. Bounded feedback replaces solver shoves. */
  knockbackDurationMs: 140,
  shieldInvulnerabilityMs: 720,
  dotCaptureDurationMs: 1200,
  coverDurationMs: 1850,
  consumeDurationMs: 3000,
  reviveCleanDurationMs: 2500,
  lootThenReviveDurationMs: 4500,
  pleaCooldownMs: 10_000,
  minInsertionSpacing: 900,
  respawnDelayMs: 1200,
  coverCenterTolerance: 12,
  extractionDurationMs: 4000,
  runDurationMs: 480_000,
};
