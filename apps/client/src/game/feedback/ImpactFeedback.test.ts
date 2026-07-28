import { describe, expect, it, vi } from "vitest";
import {
  ImpactFeedback,
  impactHapticDuration,
  type AudioFeedbackStatus,
  type FeedbackPreferences,
} from "./ImpactFeedback";

const preferences: FeedbackPreferences = {
  sound: true,
  haptics: false,
  reducedMotion: false,
};

describe("impact feedback", () => {
  it("keeps observers silent while making downs strongest", () => {
    // Two outcomes left now that a hit either breaks a plate or breaks the core,
    // and the down has to be the one you feel.
    expect(impactHapticDuration("plateBreak", "observer")).toBe(0);
    expect(impactHapticDuration("downed", "observer")).toBe(0);
    expect(impactHapticDuration("downed", "attacker"))
      .toBeGreaterThan(impactHapticDuration("plateBreak", "attacker"));
    expect(impactHapticDuration("downed", "victim"))
      .toBeGreaterThan(impactHapticDuration("plateBreak", "victim"));
  });

  it("holds a fresh cue until asynchronous audio startup finishes", async () => {
    const audio = fakeAudioContext();
    const statuses: AudioFeedbackStatus[] = [];
    const resume = deferred<void>();
    audio.context.resume.mockImplementation(() => resume.promise);
    const feedback = new ImpactFeedback(preferences, {
      createAudioContext: () => audio.context as unknown as AudioContext,
      now: () => 100,
      onAudioStatusChange: (status) => statuses.push(status),
    });

    feedback.playTest();
    expect(audio.context.resume).toHaveBeenCalledOnce();
    expect(audio.oscillators).toHaveLength(0);
    expect(statuses.at(-1)).toBe("starting");

    audio.setState("running");
    resume.resolve();
    await resume.promise;
    await Promise.resolve();

    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators.every((oscillator) => oscillator.start.mock.calls.length === 1)).toBe(true);
    expect(statuses.at(-1)).toBe("ready");
  });

  it("drops a startup cue that would be perceptibly late", async () => {
    const audio = fakeAudioContext();
    const resume = deferred<void>();
    let now = 0;
    audio.context.resume.mockImplementation(() => resume.promise);
    const feedback = new ImpactFeedback(preferences, {
      createAudioContext: () => audio.context as unknown as AudioContext,
      now: () => now,
    });

    feedback.playTest();
    now = 300;
    audio.setState("running");
    resume.resolve();
    await resume.promise;
    await Promise.resolve();

    expect(audio.oscillators).toHaveLength(0);
  });

  it("recovers an interrupted Safari audio context", async () => {
    const audio = fakeAudioContext("interrupted");
    const statuses: AudioFeedbackStatus[] = [];
    audio.context.resume.mockImplementation(async () => {
      audio.setState("running");
    });
    const feedback = new ImpactFeedback(preferences, {
      createAudioContext: () => audio.context as unknown as AudioContext,
      onAudioStatusChange: (status) => statuses.push(status),
    });

    feedback.playTest();
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.context.resume).toHaveBeenCalledOnce();
    expect(statuses).toContain("interrupted");
    expect(statuses.at(-1)).toBe("ready");
    expect(audio.oscillators).toHaveLength(2);
  });

  it("does not allocate audio hardware while sound is disabled", async () => {
    const createAudioContext = vi.fn();
    const statuses: AudioFeedbackStatus[] = [];
    const feedback = new ImpactFeedback(
      { ...preferences, sound: false },
      {
        createAudioContext,
        onAudioStatusChange: (status) => statuses.push(status),
      },
    );

    feedback.playTest();
    expect(await feedback.unlock()).toBe(false);
    expect(createAudioContext).not.toHaveBeenCalled();
    expect(statuses).toEqual(["off"]);
  });
});

type FakeAudioState = AudioContextState | "interrupted";

function fakeAudioContext(initialState: FakeAudioState = "suspended") {
  let state = initialState;
  const oscillators: Array<ReturnType<typeof fakeOscillator>> = [];
  const context = {
    get state() { return state; },
    currentTime: 0,
    sampleRate: 48_000,
    destination: {},
    onstatechange: null as ((event: Event) => void) | null,
    resume: vi.fn(async () => {
      state = "running";
    }),
    suspend: vi.fn(async () => {
      state = "suspended";
    }),
    close: vi.fn(async () => {
      state = "closed";
    }),
    createBuffer: vi.fn((_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    })),
    createGain: vi.fn(() => ({
      connect: vi.fn((destination: unknown) => destination),
      gain: fakeAudioParam(),
    })),
    createStereoPanner: vi.fn(() => ({
      connect: vi.fn((destination: unknown) => destination),
      pan: fakeAudioParam(),
    })),
    createOscillator: vi.fn(() => {
      const oscillator = fakeOscillator();
      oscillators.push(oscillator);
      return oscillator;
    }),
    createBufferSource: vi.fn(() => ({
      connect: vi.fn((destination: unknown) => destination),
      buffer: null,
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBiquadFilter: vi.fn(() => ({
      connect: vi.fn((destination: unknown) => destination),
      type: "bandpass",
      frequency: fakeAudioParam(),
      Q: fakeAudioParam(),
    })),
  };

  return {
    context,
    oscillators,
    setState(next: FakeAudioState) {
      state = next;
    },
  };
}

function fakeOscillator() {
  return {
    connect: vi.fn((destination: unknown) => destination),
    type: "sine",
    frequency: fakeAudioParam(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function fakeAudioParam() {
  return {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
