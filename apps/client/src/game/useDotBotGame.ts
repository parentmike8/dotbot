import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { getKeyboardVector, mergeMoveVectors, movementKeyCodes } from "./input";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import { GameRenderer, type InteractionChannelVisual } from "./renderer/GameRenderer";
import {
  ImpactFeedback,
  loadFeedbackPreferences,
  saveFeedbackPreferences,
  type AudioFeedbackStatus,
  type FeedbackPreferences,
  type ImpactPerspective,
} from "./feedback/ImpactFeedback";
import { selectSpectatedBot } from "./spectate";
import { createSession } from "./session/createSession";
import type { GameSession } from "./session/GameSession";
import type { DotBotEntity, DownedHostileVerb, GameSnapshot, Item, MapDocument, SimEvent, Vec2 } from "@dotbot/game/types";
import type { NetworkDebugStats } from "./session/netgraph";

export type RunOutcome = "extracted" | "died" | "timeout";

export type RunResult = {
  outcome: RunOutcome;
  keptItems: Item[];
  lostItems: Item[];
  learnedBlueprints: string[];
  contractCompletions: Array<{ contractId: string; title: string; payout: Item[] }>;
  persistenceStatus?: "saved" | "failed";
  runTimeMs: number;
};

type JoystickState = {
  active: boolean;
  pointerId: number | null;
  origin: Vec2;
  knob: Vec2;
  move: Vec2;
};

const joystickRadius = 54;

function isEditableTarget(event: KeyboardEvent): boolean {
  const element = event.target as HTMLElement | null;
  return Boolean(
    element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable),
  );
}

const emptyJoystick: JoystickState = {
  active: false,
  pointerId: null,
  origin: { x: 0, y: 0 },
  knob: { x: 0, y: 0 },
  move: { x: 0, y: 0 },
};

type UseDotBotGameOptions = {
  session?: GameSession;
  map?: MapDocument;
  spectate?: boolean;
};

export function useDotBotGame(options: UseDotBotGameOptions = {}) {
  const providedSession = options.session;
  const requestedMap = options.map ?? downtownMap;
  const spectateEnabled = options.spectate ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const feedbackRef = useRef<ImpactFeedback | null>(null);
  const keysRef = useRef(new Set<string>());
  const joystickRef = useRef<JoystickState>(emptyJoystick);
  const dashQueuedRef = useRef(false);
  const useBayQueuedRef = useRef<0 | 1 | 2 | 3 | undefined>(undefined);
  const swapQueuedRef = useRef<{ bayIndex: 0 | 1 | 2 | 3; holdIndex: number } | undefined>(undefined);
  const downedVerbRef = useRef<DownedHostileVerb | undefined>(undefined);
  const pleaQueuedRef = useRef(false);
  const spectateCycleQueuedRef = useRef(false);
  const spectatedBotIdRef = useRef<string | null>(null);
  const runEndedRef = useRef(false);
  const interactionChannelRef = useRef<InteractionChannelVisual | null>(null);
  const pendingDraftsRef = useRef<string[]>([]);
  const frameRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [spectating, setSpectating] = useState<DotBotEntity | null>(null);
  const [debugVisible, setDebugVisible] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("netgraph"),
  );
  const [networkDebug, setNetworkDebug] = useState<NetworkDebugStats | null>(null);
  const [legendVisible, setLegendVisible] = useState(false);
  const [joystickView, setJoystickView] = useState(emptyJoystick);
  const [feedbackPreferences, setFeedbackPreferences] = useState(loadFeedbackPreferences);
  const [audioStatus, setAudioStatus] = useState<AudioFeedbackStatus>(
    () => feedbackPreferences.sound ? "idle" : "off",
  );
  const feedbackPreferencesRef = useRef(feedbackPreferences);

  const resetJoystick = useCallback(() => {
    joystickRef.current = emptyJoystick;
    setJoystickView(emptyJoystick);
  }, []);

  const clearMovementInput = useCallback(() => {
    keysRef.current.clear();
    resetJoystick();
  }, [resetJoystick]);

  useEffect(() => {
    let disposed = false;
    let lastFrame = performance.now();
    let lastHudUpdate = 0;
    let frameCounter = 0;
    let fpsWindowStart = lastFrame;
    let fps = 0;
    let playerSquadId: string | null = null;
    let resizeObserver: ResizeObserver | undefined;
    const feedback = new ImpactFeedback(feedbackPreferencesRef.current, {
      onAudioStatusChange: (status) => {
        if (!disposed) setAudioStatus(status);
      },
    });
    feedbackRef.current = feedback;

    async function start() {
      const host = hostRef.current;

      if (!host) {
        return;
      }

      const session = providedSession ?? createSession("local", {
        map: requestedMap,
        config: defaultGameConfig,
        playerId: "player",
      });
      await session.start();
      const renderer = await GameRenderer.create(host, session.map);
      renderer.setReducedMotion(feedbackPreferencesRef.current.reducedMotion);

      if (disposed) {
        feedback.destroy();
        renderer.destroy();
        session.dispose();
        return;
      }

      sessionRef.current = session;
      rendererRef.current = renderer;
      for (const objectId of pendingDraftsRef.current.splice(0)) renderer.draftObject(objectId);
      const initialSnapshot = session.update(0);
      setSnapshot(initialSnapshot);
      playerSquadId = initialSnapshot?.bots.find((bot) => bot.id === session.playerId)?.squadId ?? null;

      resizeObserver = new ResizeObserver(([entry]) => {
        renderer.resize(entry.contentRect.width, entry.contentRect.height);
      });
      resizeObserver.observe(host);

      const loop = (now: number) => {
        if (disposed) {
          return;
        }

        const frameWorkStartedAt = performance.now();
        const elapsedMs = now - lastFrame;
        lastFrame = now;
        frameCounter += 1;

        if (now - fpsWindowStart >= 500) {
          fps = Math.round((frameCounter * 1000) / (now - fpsWindowStart));
          fpsWindowStart = now;
          frameCounter = 0;
        }

        if (runEndedRef.current) {
          session.sendInput({ move: { x: 0, y: 0 }, dash: false });
        } else {
          const keyboardMove = getKeyboardVector(keysRef.current);
          const joystickMove = joystickRef.current.move;
          session.sendInput({
            move: mergeMoveVectors(keyboardMove, joystickMove),
            dash: dashQueuedRef.current,
            useBay: useBayQueuedRef.current,
            swapBay: swapQueuedRef.current,
            downedVerb: downedVerbRef.current,
            plea: pleaQueuedRef.current,
          });
        }
        dashQueuedRef.current = false;
        useBayQueuedRef.current = undefined;
        swapQueuedRef.current = undefined;
        pleaQueuedRef.current = false;
        session.setMeasuredFps?.(fps);
        const nextSnapshot = session.update(elapsedMs);
        const frameEvents = session.drainEvents();
        const uiEvents = frameEvents.filter((event) => event.type !== "hit");
        if (uiEvents.length > 0) setEvents((current) => [...current, ...uiEvents]);

        if (!nextSnapshot) {
          session.recordClientFrame?.(elapsedMs, performance.now() - frameWorkStartedAt);
          frameRef.current = requestAnimationFrame(loop);
          return;
        }

        const predictedImpacts = session.drainPredictedImpacts?.() ?? [];
        for (const impact of predictedImpacts) {
          const result = renderer.queueImpact(impact, nextSnapshot);
          feedback.playPredicted(result, impactPan(nextSnapshot, session.playerId, { x: impact.x, y: impact.y }));
        }
        for (const event of frameEvents) {
          if (event.type === "plea") renderer.queuePlea(event);
          if (event.type === "mineSensor") renderer.queueMineSensor(event);
          if (event.type === "hit") {
            const alreadyPredicted = renderer.confirmImpact(event, nextSnapshot, session.playerId);
            const perspective: ImpactPerspective = event.byBotId === session.playerId
              ? "attacker"
              : event.botId === session.playerId
                ? "victim"
                : "observer";
            const worldPoint = event.tick > 0 || event.position.x !== 0 || event.position.y !== 0
              ? event.position
              : nextSnapshot.bots.find((bot) => bot.id === event.botId)?.position ?? event.position;
            feedback.playConfirmed(
              event.result,
              perspective,
              alreadyPredicted,
              impactPan(nextSnapshot, session.playerId, worldPoint),
            );
          }
        }

        const currentPlayer = nextSnapshot.bots.find((bot) => bot.id === session.playerId);
        if (currentPlayer) playerSquadId = currentPlayer.squadId;
        const runState = session.getRunState();

        if (!runEndedRef.current && runState.phase === "over") {
          const result: RunResult = {
            outcome: runState.reason,
            keptItems: runState.keptItems,
            lostItems: runState.lostItems,
            learnedBlueprints: runState.learnedBlueprints,
            contractCompletions: runState.contractCompletions ?? [],
            persistenceStatus: runState.persistenceStatus,
            runTimeMs: nextSnapshot.timeMs,
          };
          runEndedRef.current = true;
          keysRef.current.clear();
          joystickRef.current = emptyJoystick;
          setJoystickView(emptyJoystick);
          setRunResult(result);
        }

        const livingSquadmates = spectateEnabled && runState.phase === "over" && playerSquadId
          ? nextSnapshot.bots.filter((bot) => bot.id !== session.playerId && bot.squadId === playerSquadId && bot.state === "alive")
          : [];
        const spectator = selectSpectatedBot(livingSquadmates, spectatedBotIdRef.current, spectateCycleQueuedRef.current);
        spectateCycleQueuedRef.current = false;
        spectatedBotIdRef.current = spectator?.id ?? null;
        const renderPlayerId = spectator?.id ?? session.playerId;
        const presentedAt = renderer.render(
          nextSnapshot,
          renderPlayerId,
          spectateEnabled && runState.phase === "over" && spectator === null,
          interactionChannelRef.current,
          session.intel,
        );
        for (const impact of predictedImpacts) {
          session.recordImpactPresented?.(impact.predictionId, presentedAt);
        }
        session.recordClientFrame?.(elapsedMs, performance.now() - frameWorkStartedAt);

        if (now - lastHudUpdate >= 80) {
          setSnapshot(nextSnapshot);
          setSpectating(spectator);
          setNetworkDebug(session.getNetworkDebug?.() ?? null);
          lastHudUpdate = now;

          if (import.meta.env.DEV) {
            (window as unknown as { __dotbotSnapshot?: GameSnapshot }).__dotbotSnapshot = nextSnapshot;
          }
        }

        frameRef.current = requestAnimationFrame(loop);
      };

      frameRef.current = requestAnimationFrame(loop);
    }

    start();

    const onKeyDown = (event: KeyboardEvent) => {
      // Never capture game hotkeys while the player is typing in a form
      // field (callsign, preset names, room codes).
      if (isEditableTarget(event)) return;
      void feedback.unlock();

      if (event.code === "F3") {
        event.preventDefault();
        setDebugVisible((visible) => !visible);
        return;
      }

      if (event.code === "KeyL") {
        event.preventDefault();
        setLegendVisible((visible) => !visible);
        return;
      }

      const verbByCode: Partial<Record<string, DownedHostileVerb>> = {
        KeyC: "consume",
        KeyR: "reviveClean",
        KeyF: "lootThenRevive",
      };
      if (verbByCode[event.code]) {
        event.preventDefault();
        if (!runEndedRef.current) downedVerbRef.current = verbByCode[event.code];
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        if (!runEndedRef.current && !event.repeat) pleaQueuedRef.current = true;
        return;
      }

      if (["Digit1", "Digit2", "Digit3", "Digit4"].includes(event.code)) {
        event.preventDefault();
        if (!runEndedRef.current && !event.repeat) useBayQueuedRef.current = Number(event.code.slice(-1)) - 1 as 0 | 1 | 2 | 3;
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        if (runEndedRef.current && spectateEnabled) {
          spectateCycleQueuedRef.current = true;
        } else if (!runEndedRef.current) {
          dashQueuedRef.current = true;
          if (!event.repeat) feedback.playDash();
        }
        return;
      }

      if (movementKeyCodes.has(event.code)) {
        event.preventDefault();
        if (!runEndedRef.current) {
          keysRef.current.add(event.code);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isEditableTarget(event)) return;
      if (movementKeyCodes.has(event.code)) {
        event.preventDefault();
        keysRef.current.delete(event.code);
      }
    };

    const onPointerRelease = (event: globalThis.PointerEvent) => {
      if (joystickRef.current.pointerId === event.pointerId) {
        resetJoystick();
      }
    };

    const onAudioGesture = () => {
      void feedback.unlock();
    };

    const onWindowBlur = () => {
      clearMovementInput();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearMovementInput();
      } else {
        feedback.recover();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onAudioGesture, true);
    window.addEventListener("pointerup", onPointerRelease);
    window.addEventListener("pointercancel", onPointerRelease);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onAudioGesture, true);
      window.removeEventListener("pointerup", onPointerRelease);
      window.removeEventListener("pointercancel", onPointerRelease);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver?.disconnect();

      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }

      rendererRef.current?.destroy();
      feedbackRef.current?.destroy();
      sessionRef.current?.dispose();
      rendererRef.current = null;
      feedbackRef.current = null;
      sessionRef.current = null;
    };
  }, [clearMovementInput, providedSession, requestedMap, resetJoystick, spectateEnabled]);

  const queueDash = useCallback(() => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) {
      dashQueuedRef.current = true;
      feedbackRef.current?.playDash();
    }
  }, []);

  const useBay = useCallback((bayIndex: 0 | 1 | 2 | 3) => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) useBayQueuedRef.current = bayIndex;
  }, []);

  const swapBayItem = useCallback((bayIndex: 0 | 1 | 2 | 3, holdIndex: number) => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) swapQueuedRef.current = { bayIndex, holdIndex };
  }, []);

  const cycleSpectator = useCallback(() => {
    if (runEndedRef.current && spectateEnabled) {
      spectateCycleQueuedRef.current = true;
    }
  }, [spectateEnabled]);

  const giveUp = useCallback(() => {
    sessionRef.current?.giveUp();
  }, []);

  const selectDownedVerb = useCallback((verb: DownedHostileVerb) => {
    if (!runEndedRef.current) downedVerbRef.current = verb;
  }, []);

  const plea = useCallback(() => {
    void feedbackRef.current?.unlock();
    if (!runEndedRef.current) pleaQueuedRef.current = true;
  }, []);

  const setInteractionChannel = useCallback((visual: InteractionChannelVisual | null) => {
    interactionChannelRef.current = visual;
  }, []);

  const draftObjects = useCallback((objectIds: string[]) => {
    const renderer = rendererRef.current;
    if (renderer) {
      for (const objectId of objectIds) renderer.draftObject(objectId);
    } else {
      pendingDraftsRef.current.push(...objectIds);
    }
  }, []);

  const updateJoystick = useCallback((clientX: number, clientY: number) => {
    const state = joystickRef.current;
    const raw = {
      x: clientX - state.origin.x,
      y: clientY - state.origin.y,
    };
    const length = Math.hypot(raw.x, raw.y);
    const limited = length > joystickRadius ? { x: (raw.x / length) * joystickRadius, y: (raw.y / length) * joystickRadius } : raw;
    const move = normalizeInputVector({
      x: clamp(limited.x / joystickRadius, -1, 1),
      y: clamp(limited.y / joystickRadius, -1, 1),
    });
    const next = {
      ...state,
      knob: limited,
      move,
    };

    joystickRef.current = next;
    setJoystickView(next);
  }, []);

  const joystickHandlers = useMemo(
    () => ({
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        void feedbackRef.current?.unlock();
        event.currentTarget.setPointerCapture(event.pointerId);
        const origin = {
          x: event.clientX,
          y: event.clientY,
        };
        const next = {
          active: true,
          pointerId: event.pointerId,
          origin,
          knob: { x: 0, y: 0 },
          move: { x: 0, y: 0 },
        };
        joystickRef.current = next;
        setJoystickView(next);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const state = joystickRef.current;

        if (!state.active || state.pointerId !== event.pointerId) {
          return;
        }

        updateJoystick(event.clientX, event.clientY);
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (joystickRef.current.pointerId === event.pointerId) {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }

          resetJoystick();
        }
      },
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
        if (joystickRef.current.pointerId === event.pointerId) {
          resetJoystick();
        }
      },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (joystickRef.current.pointerId === event.pointerId) {
          resetJoystick();
        }
      },
    }),
    [resetJoystick, updateJoystick],
  );

  const toggleFeedbackPreference = useCallback((key: keyof FeedbackPreferences) => {
    const next = {
      ...feedbackPreferencesRef.current,
      [key]: !feedbackPreferencesRef.current[key],
    };
    feedbackPreferencesRef.current = next;
    feedbackRef.current?.setPreferences(next);
    rendererRef.current?.setReducedMotion(next.reducedMotion);
    saveFeedbackPreferences(next);
    setFeedbackPreferences(next);
    if (key === "sound" && next.sound) void feedbackRef.current?.unlock();
  }, []);

  const testSound = useCallback(() => {
    feedbackRef.current?.playTest();
  }, []);

  return {
    hostRef,
    snapshot,
    events,
    runResult,
    map: providedSession?.map ?? requestedMap,
    playerId: providedSession?.playerId ?? "player",
    spectating,
    debugVisible,
    networkDebug,
    legendVisible,
    toggleLegend: () => setLegendVisible((visible) => !visible),
    feedbackPreferences,
    audioStatus,
    toggleSound: () => toggleFeedbackPreference("sound"),
    toggleHaptics: () => toggleFeedbackPreference("haptics"),
    toggleReducedMotion: () => toggleFeedbackPreference("reducedMotion"),
    testSound,
    joystick: joystickView,
    joystickHandlers,
    queueDash,
    useBay,
    swapBayItem,
    giveUp,
    selectDownedVerb,
    plea,
    cycleSpectator,
    setInteractionChannel,
    draftObjects,
  };
}

function impactPan(snapshot: GameSnapshot, playerId: string, point: Vec2): number {
  const player = snapshot.bots.find((bot) => bot.id === playerId);
  if (!player) return 0;
  return clamp((point.x - player.position.x) / 320, -1, 1);
}
