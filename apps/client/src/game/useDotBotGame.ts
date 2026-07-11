import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { DotBotSimulation } from "@dotbot/game/simulation";
import { getKeyboardVector, mergeMoveVectors, movementKeyCodes } from "./input";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import { GameRenderer } from "./renderer/GameRenderer";
import type { GameSnapshot, Vec2 } from "@dotbot/game/types";

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

export function useDotBotGame() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<DotBotSimulation | null>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const keysRef = useRef(new Set<string>());
  const joystickRef = useRef<JoystickState>(emptyJoystick);
  const dashQueuedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [debugVisible, setDebugVisible] = useState(false);
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
    let accumulator = 0;
    let resizeObserver: ResizeObserver | undefined;

    const tickSeconds = 1 / defaultGameConfig.tickHz;

    async function start() {
      const host = hostRef.current;

      if (!host) {
        return;
      }

      const simulation = await DotBotSimulation.create({
        map: downtownMap,
        config: defaultGameConfig,
      });
      const renderer = await GameRenderer.create(host, downtownMap);

      if (disposed) {
        renderer.destroy();
        simulation.dispose();
        return;
      }

      simulationRef.current = simulation;
      rendererRef.current = renderer;
      setSnapshot(simulation.getSnapshot());

      resizeObserver = new ResizeObserver(([entry]) => {
        renderer.resize(entry.contentRect.width, entry.contentRect.height);
      });
      resizeObserver.observe(host);

      const loop = (now: number) => {
        if (disposed) {
          return;
        }

        const deltaSeconds = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        accumulator += deltaSeconds;
        frameCounter += 1;

        if (now - fpsWindowStart >= 500) {
          fps = Math.round((frameCounter * 1000) / (now - fpsWindowStart));
          fpsWindowStart = now;
          frameCounter = 0;
        }

        while (accumulator >= tickSeconds) {
          const keyboardMove = getKeyboardVector(keysRef.current);
          const joystickMove = joystickRef.current.move;
          simulation.applyInput({
            move: mergeMoveVectors(keyboardMove, joystickMove),
            dash: dashQueuedRef.current,
          });
          dashQueuedRef.current = false;
          simulation.step();
          accumulator -= tickSeconds;
        }

        simulation.setMeasuredFps(fps);
        const nextSnapshot = simulation.getSnapshot();
        renderer.render(nextSnapshot);

        if (now - lastHudUpdate >= 80) {
          setSnapshot(nextSnapshot);
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

      if (event.code === "Space") {
        event.preventDefault();
        dashQueuedRef.current = true;
        return;
      }

      if (movementKeyCodes.has(event.code)) {
        event.preventDefault();
        keysRef.current.add(event.code);
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
      simulationRef.current?.dispose();
      rendererRef.current = null;
      simulationRef.current = null;
    };
  }, [clearMovementInput, resetJoystick]);

  const queueDash = useCallback(() => {
    dashQueuedRef.current = true;
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
    debugVisible,
    joystick: joystickView,
    joystickHandlers,
    queueDash,
  };
}
