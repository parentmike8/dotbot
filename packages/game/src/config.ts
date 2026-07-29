import type { GameConfig } from "./types";

/**
 * Above this a body counts as moving under its own power (px/s).
 *
 * Shared, because separation splits responsibility for an overlap on it — the mover
 * yields, a standing bot is an anchor — and the client predictor has to split it the
 * same way or it rubber-bands the player's own body on every shoulder. It is also
 * what `DotBotEntity.moving` reports on the wire.
 */
export const MOVING_SPEED = 5;

export const defaultGameConfig: GameConfig = {
  tickHz: 60,
  botRadius: 24,
  dotRadius: 10,
  maxShields: 3,
  /**
   * Three, so the whole bank is one thumb's reach on a phone and one glance
   * anywhere. The controls are a stick and a dash; the bays are the only other
   * thing a player drives, and a fourth slot bought nothing a third does not.
   */
  baySlots: 3,
  /**
   * Six, so the reserve is twice the bank rather than four times it. Twelve made
   * every full body a wall of slots to read and meant a run's whole haul lived
   * somewhere the player never looked. Three you can reach, six you are carrying.
   */
  holdSlots: 6,
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
  /** Stripping a body is the slow, committing act — it was the consume channel. */
  lootDurationMs: 3000,
  pleaCooldownMs: 10_000,
  /**
   * How often one bot may mark a place.
   *
   * Short enough to point at a moving rival twice in a fight, long enough that holding the
   * button cannot paper the map. This IS the spam control — pings keep no state, so there
   * is nothing else to cap.
   */
  pingCooldownMs: 900,
  minInsertionSpacing: 900,
  coverCenterTolerance: 12,
  maxSquadSize: 4,
  extractionDurationMs: 4000,
  runDurationMs: 480_000,
};
