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

/** Narrow tolerance for literal body contact. Visible daylight is valid run-up. */
export const DASH_CONTACT_EPSILON_PX = 0.5;

/**
 * How long two bodies must stay touching before a dash between them is disarmed.
 *
 * The run-up rule used to disarm on a snapshot: touching on the tick you pressed
 * meant a bump, full stop. That reads as arbitrary from the keyboard, because a
 * single tick of contact is not something a player can see or avoid. A body closing
 * under dash covers 10.7 px in one tick — most of the daylight a hunter is told to
 * hold — so a charge can erase visible separation between the frame you reacted to
 * and the tick your dash is judged on, and the separation solver then parks the two
 * of you at a gap of exactly zero. Reported from play as bumps happening "even when
 * we didn't start as touching", which was an accurate description of the rule.
 *
 * So contact has to PERSIST to disarm anything. Eight ticks is about an eighth of a
 * second of two bodies genuinely stuck together — long past an incidental brush from
 * someone charging in, and nowhere near long enough to let anyone stand on a target
 * and grind dashes into it, which is the pattern the rule exists to kill. Any
 * daylight at all resets it, because breaking off is the counterplay and it should
 * work the instant you do it.
 *
 * Deliberately NOT hysteresis in the other direction. Making the disarmed state
 * sticky — touch once, then owe a fixed distance before you re-arm — is a rule that
 * produces MORE bumps than the one being replaced, in exactly the band where players
 * already complain about them.
 */
export const DASH_CLINCH_TICKS = 8;

/**
 * How long after a dash ends a body still counts as committed to it, for the parry.
 *
 * Two bodies charging each other should clash. Requiring both dashes to be ACTIVE on
 * the same tick makes that a coincidence rather than a read: a dash is 145 ms and
 * ends the moment it connects, so whoever committed first has usually spent theirs
 * by the time the two actually meet, and the later charge lands as a clean hit.
 * Reported from play as parries being almost impossible to get.
 *
 * A grace of roughly one more dash length means two charges begun within about a
 * quarter second of each other still meet as a parry, which is what "we both went
 * for it" feels like from either chair. It only ever widens the clash: the damage
 * path stays gated on an actually-active dash, so this can turn a hit into a parry
 * and never the other way round.
 */
export const DASH_PARRY_GRACE_MS = 120;

/** Swept-hit tolerance for simulation sampling and small network error. */
export const DASH_HIT_FORGIVENESS_PX = 4;

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
   * WAS 900, and that was a bug rather than a tuning choice: 900ms is over half a second, so a
   * second click at any normal pace landed inside the cooldown and was swallowed with nothing
   * to say so. Reported exactly as "every other click, the ping doesn't land".
   *
   * The mistake was reasoning about spam from the wrong input. A held key repeats; a mouse
   * button does not — `pointerdown` fires once per press — so there was never a stream to
   * defend against, and the cost of guessing wrong was silently dropping half the player's
   * deliberate clicks. Short enough now that no intended click is lost, still long enough to
   * swallow a double-fire from one press.
   *
   * The real limits are elsewhere and are the ones doing the work: the client keeps four live
   * marks, and the AI remembers one per kind per squad.
   */
  pingCooldownMs: 180,
  minInsertionSpacing: 900,
  coverCenterTolerance: 12,
  maxSquadSize: 4,
  extractionDurationMs: 4000,
  runDurationMs: 480_000,
};
