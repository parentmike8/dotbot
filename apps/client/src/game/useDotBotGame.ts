import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { getKeyboardVector, mergeMoveVectors, movementKeyCodes } from "./input";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import { GameRenderer } from "./renderer/GameRenderer";
import { createSession } from "./session/createSession";
import type { GameSession } from "./session/GameSession";
import type { DotBotEntity, GameSnapshot, Item, SimEvent, Vec2 } from "@dotbot/game/types";

export type RunOutcome = "extracted" | "died" | "timeout";

export type RunResult = {
  outcome: RunOutcome;
  keptItems: Item[];
  lostItems: Item[];
  learnedBlueprints: string[];
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

const emptyJoystick: JoystickState = {
  active: false,
  pointerId: null,
  origin: { x: 0, y: 0 },
  knob: { x: 0, y: 0 },
  move: { x: 0, y: 0 },
};

type UseDotBotGameOptions = {
  session?: GameSession;
  spectate?: boolean;
};

export function useDotBotGame(options: UseDotBotGameOptions = {}) {
  const providedSession = options.session;
  const spectateEnabled = options.spectate ?? false;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const keysRef = useRef(new Set<string>());
  const joystickRef = useRef<JoystickState>(emptyJoystick);
  const dashQueuedRef = useRef(false);
  const useBayQueuedRef = useRef<0 | 1 | 2 | 3 | undefined>(undefined);
  const swapQueuedRef = useRef<{ bayIndex: 0 | 1 | 2 | 3; holdIndex: number } | undefined>(undefined);
  const spectateCycleQueuedRef = useRef(false);
  const spectatedBotIdRef = useRef<string | null>(null);
  const runEndedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [spectating, setSpectating] = useState<DotBotEntity | null>(null);
  const [debugVisible, setDebugVisible] = useState(false);
  const [legendVisible, setLegendVisible] = useState(false);
  const [joystickView, setJoystickView] = useState(emptyJoystick);

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

    async function start() {
      const host = hostRef.current;

      if (!host) {
        return;
      }

      const session = providedSession ?? createSession("local", {
        map: downtownMap,
        config: defaultGameConfig,
        playerId: "player",
      });
      await session.start();
      const renderer = await GameRenderer.create(host, session.map);

      if (disposed) {
        renderer.destroy();
        session.dispose();
        return;
      }

      sessionRef.current = session;
      rendererRef.current = renderer;
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
          });
        }
        dashQueuedRef.current = false;
        useBayQueuedRef.current = undefined;
        swapQueuedRef.current = undefined;
        session.setMeasuredFps?.(fps);
        const nextSnapshot = session.update(elapsedMs);
        const frameEvents = session.drainEvents();

        if (frameEvents.length > 0) {
          setEvents((current) => [...current, ...frameEvents]);
        }

        if (!nextSnapshot) {
          frameRef.current = requestAnimationFrame(loop);
          return;
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
        let spectator = livingSquadmates.find((bot) => bot.id === spectatedBotIdRef.current) ?? livingSquadmates[0] ?? null;
        if (spectateCycleQueuedRef.current && livingSquadmates.length > 0) {
          const currentIndex = livingSquadmates.findIndex((bot) => bot.id === spectator?.id);
          spectator = livingSquadmates[(currentIndex + 1) % livingSquadmates.length];
        }
        spectateCycleQueuedRef.current = false;
        spectatedBotIdRef.current = spectator?.id ?? null;
        const renderPlayerId = spectator?.id ?? session.playerId;
        renderer.render(nextSnapshot, renderPlayerId, spectateEnabled && runState.phase === "over" && spectator === null);

        if (now - lastHudUpdate >= 80) {
          setSnapshot(nextSnapshot);
          setSpectating(spectator);
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

    const onWindowBlur = () => {
      clearMovementInput();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearMovementInput();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", onPointerRelease);
    window.addEventListener("pointercancel", onPointerRelease);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerRelease);
      window.removeEventListener("pointercancel", onPointerRelease);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver?.disconnect();

      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }

      rendererRef.current?.destroy();
      sessionRef.current?.dispose();
      rendererRef.current = null;
      sessionRef.current = null;
    };
  }, [clearMovementInput, providedSession, resetJoystick, spectateEnabled]);

  const queueDash = useCallback(() => {
    if (!runEndedRef.current) {
      dashQueuedRef.current = true;
    }
  }, []);

  const useBay = useCallback((bayIndex: 0 | 1 | 2 | 3) => {
    if (!runEndedRef.current) useBayQueuedRef.current = bayIndex;
  }, []);

  const swapBayItem = useCallback((bayIndex: 0 | 1 | 2 | 3, holdIndex: number) => {
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

  return {
    hostRef,
    snapshot,
    events,
    runResult,
    map: providedSession?.map ?? downtownMap,
    playerId: providedSession?.playerId ?? "player",
    spectating,
    debugVisible,
    legendVisible,
    toggleLegend: () => setLegendVisible((visible) => !visible),
    joystick: joystickView,
    joystickHandlers,
    queueDash,
    useBay,
    swapBayItem,
    giveUp,
    cycleSpectator,
  };
}
