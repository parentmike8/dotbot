import type { DashContactResult, HitResult, PingKind } from "@dotbot/game/types";

export type FeedbackPreferences = {
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
};

export type ImpactPerspective = "attacker" | "victim" | "observer";

export type AudioFeedbackStatus =
  | "off"
  | "idle"
  | "starting"
  | "ready"
  | "needsGesture"
  | "interrupted"
  | "unavailable"
  | "error";

type ImpactFeedbackOptions = {
  createAudioContext?: () => AudioContext | null;
  now?: () => number;
  onAudioStatusChange?: (status: AudioFeedbackStatus) => void;
  onAudioDiagnostic?: (message: string, error?: unknown) => void;
};

type PendingAudioCue =
  | { kind: "impact"; result: HitResult; pan: number; intensity: number; requestedAt: number }
  | { kind: "dashContact"; result: DashContactResult; pan: number; intensity: number; requestedAt: number }
  | { kind: "dash"; requestedAt: number }
  | { kind: "ping"; ping: PingKind; pan: number; requestedAt: number };

const storageKey = "dotbot.feedback.v1";
const pendingCueLifetimeMs = 220;
/** Longer than a network confirmation, shorter than the minimum time between
 * real clashes. Prediction and authority may both report the same parry. */
const clashCueDedupeMs = 750;

export function defaultFeedbackPreferences(): FeedbackPreferences {
  const reducedMotion = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return { sound: true, haptics: true, reducedMotion };
}

export function loadFeedbackPreferences(): FeedbackPreferences {
  const defaults = defaultFeedbackPreferences();
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<FeedbackPreferences> | null;
    return stored ? {
      sound: typeof stored.sound === "boolean" ? stored.sound : defaults.sound,
      haptics: typeof stored.haptics === "boolean" ? stored.haptics : defaults.haptics,
      reducedMotion: typeof stored.reducedMotion === "boolean" ? stored.reducedMotion : defaults.reducedMotion,
    } : defaults;
  } catch {
    return defaults;
  }
}

export function saveFeedbackPreferences(preferences: FeedbackPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Private browsing and embedded webviews can deny storage. Feedback still
    // works for the current run, so persistence is deliberately best-effort.
  }
}

export function impactHapticDuration(result: HitResult, perspective: ImpactPerspective): number {
  if (perspective === "observer") return 0;
  if (result === "downed") return perspective === "victim" ? 34 : 28;
  if (result === "plateBreak") return 18;
  return 12;
}

type NativeHapticsBridge = {
  impact?: (payload: { result: HitResult; perspective: ImpactPerspective }) => void;
};

type WebkitMessageHandler = { postMessage: (payload: unknown) => void };

type RumbleActuator = {
  playEffect: (type: string, params: {
    duration: number;
    startDelay: number;
    strongMagnitude: number;
    weakMagnitude: number;
  }) => Promise<unknown>;
};

/**
 * One low-latency sensory engine per live game. Sounds are synthesized once
 * through Web Audio, so the first production version does not depend on a
 * media fetch completing at the moment of contact. A native wrapper can
 * replace web vibration through the stable DotBotNativeHaptics bridge.
 */
export class ImpactFeedback {
  private preferences: FeedbackPreferences;
  private context: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private pendingCue: PendingAudioCue | null = null;
  private audioStatus: AudioFeedbackStatus;
  private readonly createAudioContext: () => AudioContext | null;
  private readonly now: () => number;
  private readonly onAudioStatusChange?: (status: AudioFeedbackStatus) => void;
  private readonly onAudioDiagnostic?: (message: string, error?: unknown) => void;
  private lastAudioDiagnostic: string | null = null;
  private lastClashCueAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(preferences: FeedbackPreferences, options: ImpactFeedbackOptions = {}) {
    this.preferences = preferences;
    this.audioStatus = preferences.sound ? "idle" : "off";
    this.createAudioContext = options.createAudioContext ?? createBrowserAudioContext;
    this.now = options.now ?? monotonicNow;
    this.onAudioStatusChange = options.onAudioStatusChange;
    this.onAudioDiagnostic = options.onAudioDiagnostic;
    this.onAudioStatusChange?.(this.audioStatus);
  }

  setPreferences(preferences: FeedbackPreferences): void {
    const soundWasEnabled = this.preferences.sound;
    this.preferences = preferences;
    if (!preferences.sound) {
      this.pendingCue = null;
      this.setAudioStatus("off");
      if (audioContextState(this.context) === "running") {
        void this.context?.suspend().catch((error: unknown) => {
          this.reportAudioDiagnostic("Unable to suspend audio", error);
        });
      }
    } else if (!soundWasEnabled) {
      this.setAudioStatus(audioContextState(this.context) === "running" ? "ready" : "idle");
    }
  }

  /** Call from a real pointer/key gesture so mobile autoplay policies are
   * satisfied before the later collision frame needs audio. */
  async unlock(): Promise<boolean> {
    if (this.disposed || !this.preferences.sound) return false;
    const context = this.ensureAudioContext();
    if (!context) return false;

    const state = audioContextState(context);
    if (state === "running") {
      this.setAudioStatus("ready");
      this.flushPendingCue();
      return true;
    }
    if (state === "closed") {
      this.setAudioStatus("error");
      return false;
    }

    this.setAudioStatus(state === "interrupted" ? "interrupted" : "starting");
    try {
      await context.resume();
    } catch (error) {
      if (!this.disposed) {
        this.setAudioStatus("needsGesture");
        this.reportAudioDiagnostic("Audio resume was blocked or failed", error);
      }
      return false;
    }

    if (this.disposed) return false;
    if (audioContextState(context) === "running") {
      this.setAudioStatus("ready");
      this.flushPendingCue();
      return true;
    }

    this.setAudioStatus(audioContextState(context) === "interrupted" ? "interrupted" : "needsGesture");
    return false;
  }

  /** Safari can interrupt Web Audio when the tab or another app takes focus.
   * This is safe to call on visibility return; a later gesture retries if the
   * browser still requires fresh activation. */
  recover(): void {
    if (this.disposed || !this.preferences.sound || !this.context) return;
    const state = audioContextState(this.context);
    if (state === "running") {
      this.setAudioStatus("ready");
      return;
    }
    this.setAudioStatus(state === "interrupted" ? "interrupted" : "needsGesture");
    void this.unlock();
  }

  /** A short, deliberately mid-forward cue for the settings control. */
  playTest(): void {
    this.requestAudio({
      kind: "impact",
      result: "plateBreak",
      pan: 0,
      intensity: 0.85,
      requestedAt: this.now(),
    });
  }

  playDash(): void {
    this.requestAudio({ kind: "dash", requestedAt: this.now() });
  }

  /**
   * A squadmate marked a place, and which kind is audible.
   *
   * The point of the sound is that it works when you are not looking at the map: "a audible
   * sound for my teammates to hear to know i've placed it and a different one for each of the
   * 3 so its distinguishable". So the three are separated by PITCH SHAPE rather than by
   * timbre — a rising pair, a falling pair, a single note — because pitch direction survives
   * a phone speaker and a noisy room, while two similar timbres do not.
   *
   * Panned toward where the mark is, so it also carries a rough direction before you look.
   */
  playPing(ping: PingKind, pan = 0): void {
    if (this.disposed) return;
    this.requestAudio({ kind: "ping", ping, pan: Math.max(-1, Math.min(1, pan)), requestedAt: this.now() });
  }

  playPredicted(result: HitResult, pan = 0): void {
    if (this.disposed) return;
    try {
      this.requestAudio({ kind: "impact", result, pan, intensity: 1, requestedAt: this.now() });
      this.playHaptic(result, "attacker");
    } catch {
      // Sensory feedback is optional and must never interrupt input or the
      // authoritative/render loop on a browser with a partial media API.
    }
  }

  playDashContact(
    result: DashContactResult,
    perspective: ImpactPerspective,
    alreadyPredicted: boolean,
    pan = 0,
    earshot = 1,
  ): void {
    if (this.disposed) return;
    try {
      const requestedAt = this.now();
      const duplicateClash = result === "clash"
        && requestedAt - this.lastClashCueAt < clashCueDedupeMs;
      // A clash is important enough that authority may supply the cue even
      // when rendering says it was predicted. Prediction can be absent,
      // misclassify the contact as a hit, or happen before audio unlock. The
      // time gate prevents an actual predicted parry from sounding twice.
      const shouldCue = result === "clash"
        ? !duplicateClash
        : !alreadyPredicted || perspective !== "attacker";
      if (shouldCue) {
        if (result === "clash") this.lastClashCueAt = requestedAt;
        const intensity = (perspective === "observer" ? 0.55 : 0.9) * earshot;
        if (intensity > 0) {
          this.requestAudio({ kind: "dashContact", result, pan, intensity, requestedAt });
        }
      }
      if (
        shouldCue
        && perspective !== "observer"
        && typeof navigator !== "undefined"
        && "vibrate" in navigator
      ) {
        navigator.vibrate(result === "clash" ? [18, 12, 30] : 10);
      }
    } catch {
      // Contact feedback is optional; combat authority never depends on it.
    }
  }

  /**
   * `earshot` scales the sound by how far away the contact was — see `earshot.ts`.
   * It multiplies the SOUND only: haptics still fire, because a hit that reaches your
   * own body is never out of earshot of it, and gating them would drop the cue for a
   * hit landed on you from off-screen.
   */
  playConfirmed(
    result: HitResult,
    perspective: ImpactPerspective,
    alreadyPredicted: boolean,
    pan = 0,
    earshot = 1,
  ): void {
    if (this.disposed) return;
    try {
      // Prediction already played the contact transient. Confirmation only
      // adds the heavier down accent; replaying the full sound feels like lag.
      if (!alreadyPredicted || perspective !== "attacker") {
        const intensity = (perspective === "observer" ? 0.55 : 0.9) * earshot;
        if (intensity > 0) {
          this.requestAudio({ kind: "impact", result, pan, intensity, requestedAt: this.now() });
        }
        this.playHaptic(result, perspective);
      } else if (result === "downed") {
        const intensity = 0.38 * earshot;
        if (intensity > 0) {
          this.requestAudio({ kind: "impact", result, pan, intensity, requestedAt: this.now() });
        }
      }
    } catch {
      // A media or native bridge failure cannot be allowed to stop gameplay.
    }
  }

  destroy(): void {
    this.disposed = true;
    this.pendingCue = null;
    if (this.context) this.context.onstatechange = null;
    if (this.context && audioContextState(this.context) !== "closed") {
      void this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.noiseBuffer = null;
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.context) return this.context;
    try {
      this.context = this.createAudioContext();
    } catch (error) {
      this.context = null;
      this.setAudioStatus("error");
      this.reportAudioDiagnostic("Unable to create an audio engine", error);
      return null;
    }
    if (!this.context) {
      this.setAudioStatus("unavailable");
      return null;
    }

    this.context.onstatechange = () => {
      if (this.disposed || !this.context) return;
      const state = audioContextState(this.context);
      if (state === "running") {
        this.setAudioStatus("ready");
        this.flushPendingCue();
      } else if (state === "interrupted") {
        this.setAudioStatus("interrupted");
      } else if (state === "suspended" && this.preferences.sound) {
        this.setAudioStatus("needsGesture");
      }
    };

    try {
      this.noiseBuffer = createNoiseBuffer(this.context);
    } catch (error) {
      // The tonal layers still work if a browser refuses the noise buffer.
      this.noiseBuffer = null;
      this.reportAudioDiagnostic("Impact noise layer is unavailable", error);
    }
    return this.context;
  }

  private requestAudio(cue: PendingAudioCue): void {
    if (this.disposed || !this.preferences.sound) return;
    if (audioContextState(this.context) === "running") {
      this.renderAudioCue(cue);
      return;
    }

    // Keep at most the newest contact. A stale impact played after a later tap
    // feels like network lag, so it expires quickly instead of building a queue.
    this.pendingCue = cue;
    void this.unlock().then((ready) => {
      if (ready) this.flushPendingCue();
    });
  }

  private flushPendingCue(): void {
    const cue = this.pendingCue;
    if (!cue || audioContextState(this.context) !== "running") return;
    this.pendingCue = null;
    if (this.now() - cue.requestedAt > pendingCueLifetimeMs) return;
    this.renderAudioCue(cue);
  }

  private renderAudioCue(cue: PendingAudioCue): void {
    const context = this.context;
    if (!context || context.state !== "running") return;
    if (cue.kind === "dash") {
      this.renderDashAudio(context);
      return;
    }

    if (cue.kind === "ping") {
      this.renderPingAudio(context, cue.ping, cue.pan);
      return;
    }

    if (cue.kind === "dashContact") {
      this.renderDashContactAudio(context, cue.result, cue.pan, cue.intensity);
      return;
    }

    this.renderImpactAudio(context, cue.result, cue.pan, cue.intensity);
  }

  private renderDashContactAudio(
    context: AudioContext,
    result: DashContactResult,
    pan: number,
    intensity: number,
  ): void {
    const now = context.currentTime;
    const output = context.createGain();
    output.gain.setValueAtTime(Math.max(0.0001, (result === "clash" ? 0.38 : 0.2) * intensity), now);
    output.gain.exponentialRampToValueAtTime(0.0001, now + (result === "clash" ? 0.34 : 0.08));
    const panner = typeof context.createStereoPanner === "function" ? context.createStereoPanner() : null;
    if (panner) {
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), now);
      output.connect(panner).connect(context.destination);
    } else {
      output.connect(context.destination);
    }

    if (result === "bump") {
      const body = context.createOscillator();
      const bodyGain = context.createGain();
      body.type = "sine";
      body.frequency.setValueAtTime(180, now);
      body.frequency.exponentialRampToValueAtTime(85, now + 0.07);
      bodyGain.gain.setValueAtTime(0.55, now);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      body.connect(bodyGain).connect(output);
      body.start(now);
      body.stop(now + 0.1);
      return;
    }

    // An unmistakable parry motif: high, low, HIGH. No hit, dash, bump, or
    // ping uses this three-strike contour. Spacing the notes across 190ms makes
    // it readable in the middle of several simultaneous impact transients.
    const strikes = [
      { offset: 0, startHz: 1_650, endHz: 1_260, gain: 0.72 },
      { offset: 0.065, startHz: 880, endHz: 660, gain: 0.62 },
      { offset: 0.13, startHz: 2_050, endHz: 1_480, gain: 0.78 },
    ];
    for (const strike of strikes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = now + strike.offset;
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(strike.startHz, at);
      oscillator.frequency.exponentialRampToValueAtTime(strike.endHz, at + 0.055);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.setValueAtTime(strike.gain, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.075);
      oscillator.connect(gain).connect(output);
      oscillator.start(at);
      oscillator.stop(at + 0.08);
    }

    // A bright filtered crack supplies the metallic attack that pure tones
    // lose on small phone speakers.
    if (this.noiseBuffer) {
      const crack = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const crackGain = context.createGain();
      crack.buffer = this.noiseBuffer;
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(3_400, now);
      filter.Q.setValueAtTime(1.6, now);
      crackGain.gain.setValueAtTime(1, now);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
      crack.connect(filter).connect(crackGain).connect(output);
      crack.start(now);
      crack.stop(now + 0.08);
    }
  }

  /**
   * Three marks, three shapes: up for a place, down for a threat, one note for loot.
   *
   * Quiet and short — this fires while somebody is being shot at, and a cue that competes with
   * the impact audio would make the fight harder to read rather than easier. Soft sine tones
   * on purpose, so it sits under the percussive impact sounds instead of alongside them.
   */
  private renderPingAudio(context: AudioContext, ping: PingKind, pan: number): void {
    const now = context.currentTime;
    // "here" rises, "enemy" falls, "loot" holds. Direction of pitch is the distinguishing
    // feature, so it survives a phone speaker.
    const steps: Record<PingKind, number[]> = {
      here: [660, 880],
      enemy: [760, 500],
      loot: [990],
    };
    const output = context.createGain();
    output.gain.setValueAtTime(0.0001, now);
    output.connect(context.destination);
    const panner = typeof context.createStereoPanner === "function" ? context.createStereoPanner() : null;
    if (panner) {
      panner.pan.setValueAtTime(pan, now);
      output.disconnect();
      output.connect(panner).connect(context.destination);
    }

    const notes = steps[ping];
    const each = 0.075;
    notes.forEach((frequency, index) => {
      const at = now + index * each;
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, at);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.11, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + each + 0.05);
      osc.connect(gain).connect(output);
      osc.start(at);
      osc.stop(at + each + 0.08);
    });
    output.gain.setValueAtTime(1, now);
  }

  private renderImpactAudio(context: AudioContext, result: HitResult, pan: number, intensity: number): void {

    const now = context.currentTime;
    const output = context.createGain();
    output.gain.setValueAtTime(Math.max(0.0001, 0.26 * intensity), now);
    output.gain.exponentialRampToValueAtTime(0.0001, now + (result === "downed" ? 0.16 : 0.1));
    const panner = typeof context.createStereoPanner === "function" ? context.createStereoPanner() : null;
    if (panner) {
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), now);
      output.connect(panner).connect(context.destination);
    } else {
      output.connect(context.destination);
    }

    const thud = context.createOscillator();
    const thudGain = context.createGain();
    // The old 38–145Hz-only thud largely disappeared on phone speakers. Keep
    // weight in the low end, but move the transient into an audible mid band.
    const startHz = result === "downed" ? 170 : result === "plateBreak" ? 270 : 215;
    thud.type = result === "downed" ? "triangle" : "sine";
    thud.frequency.setValueAtTime(startHz, now);
    thud.frequency.exponentialRampToValueAtTime(result === "downed" ? 68 : 105, now + 0.085);
    thudGain.gain.setValueAtTime(0.9, now);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + (result === "downed" ? 0.14 : 0.085));
    thud.connect(thudGain).connect(output);
    thud.start(now);
    thud.stop(now + 0.16);

    const knock = context.createOscillator();
    const knockGain = context.createGain();
    knock.type = "triangle";
    knock.frequency.setValueAtTime(result === "plateBreak" ? 620 : result === "downed" ? 360 : 470, now);
    knock.frequency.exponentialRampToValueAtTime(result === "plateBreak" ? 330 : 230, now + 0.045);
    knockGain.gain.setValueAtTime(result === "plateBreak" ? 0.48 : 0.32, now);
    knockGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    knock.connect(knockGain).connect(output);
    knock.start(now);
    knock.stop(now + 0.06);

    if (this.noiseBuffer) {
      const crack = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const crackGain = context.createGain();
      crack.buffer = this.noiseBuffer;
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(result === "plateBreak" ? 2100 : result === "downed" ? 720 : 1050, now);
      filter.Q.setValueAtTime(result === "plateBreak" ? 0.8 : 0.55, now);
      crackGain.gain.setValueAtTime(result === "plateBreak" ? 0.82 : 0.5, now);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, now + (result === "downed" ? 0.12 : 0.065));
      crack.connect(filter).connect(crackGain).connect(output);
      crack.start(now);
      crack.stop(now + 0.15);
    }
  }

  private renderDashAudio(context: AudioContext): void {
    const now = context.currentTime;
    const output = context.createGain();
    const sweep = context.createOscillator();
    output.gain.setValueAtTime(0.1, now);
    output.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);
    output.connect(context.destination);
    sweep.type = "triangle";
    sweep.frequency.setValueAtTime(360, now);
    sweep.frequency.exponentialRampToValueAtTime(150, now + 0.08);
    sweep.connect(output);
    sweep.start(now);
    sweep.stop(now + 0.09);
  }

  private setAudioStatus(status: AudioFeedbackStatus): void {
    if (this.audioStatus === status) return;
    this.audioStatus = status;
    if (status === "ready") this.lastAudioDiagnostic = null;
    this.onAudioStatusChange?.(status);
  }

  private reportAudioDiagnostic(message: string, error?: unknown): void {
    if (this.lastAudioDiagnostic === message) return;
    this.lastAudioDiagnostic = message;
    if (this.onAudioDiagnostic) {
      this.onAudioDiagnostic(message, error);
      return;
    }
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(`[DotBot audio] ${message}`, error);
    }
  }

  private playHaptic(result: HitResult, perspective: ImpactPerspective): void {
    if (!this.preferences.haptics || typeof window === "undefined") return;
    const duration = impactHapticDuration(result, perspective);
    if (duration <= 0) return;
    const payload = { result, perspective };
    const nativeWindow = window as typeof window & {
      DotBotNativeHaptics?: NativeHapticsBridge;
      webkit?: { messageHandlers?: { dotBotHaptics?: WebkitMessageHandler } };
    };

    if (nativeWindow.DotBotNativeHaptics?.impact) {
      nativeWindow.DotBotNativeHaptics.impact(payload);
      return;
    }
    if (nativeWindow.webkit?.messageHandlers?.dotBotHaptics) {
      nativeWindow.webkit.messageHandlers.dotBotHaptics.postMessage(payload);
      return;
    }

    if (typeof navigator.vibrate === "function" && navigator.vibrate(duration)) return;
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const actuator = pads.find(Boolean)?.vibrationActuator as RumbleActuator | undefined;
    if (actuator?.playEffect) {
      void actuator.playEffect("dual-rumble", {
        duration: Math.max(24, duration),
        startDelay: 0,
        strongMagnitude: result === "downed" ? 0.55 : 0.28,
        weakMagnitude: result === "plateBreak" ? 0.52 : 0.25,
      }).catch(() => undefined);
    }
  }
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function createBrowserAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const browserWindow = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  const AudioContextClass = browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    return new AudioContextClass({ latencyHint: "interactive" });
  } catch {
    return new AudioContextClass();
  }
}

function audioContextState(context: AudioContext | null): AudioContextState | "interrupted" | "missing" {
  return context ? context.state as AudioContextState | "interrupted" : "missing";
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const durationSeconds = 0.16;
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * durationSeconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x5f3759df;
  for (let index = 0; index < data.length; index += 1) {
    seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
    const random = ((seed ^ (seed >>> 14)) >>> 0) / 4_294_967_295;
    data[index] = (random * 2 - 1) * (1 - index / data.length);
  }
  return buffer;
}
