import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { getKeyboardVector, mergeMoveVectors, movementKeyCodes } from "./input";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import { GameRenderer } from "./renderer/GameRenderer";
import { createSession } from "./session/createSession";
import type { GameSession } from "./session/GameSession";
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
  const sessionRef = useRef<GameSession | null>(null);
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
    let resizeObserver: ResizeObserver | undefined;

    async function start() {
      const host = hostRef.current;

      if (!host) {
        return;
      }

      const session = createSession("local", {
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
      setSnapshot(session.update(0));

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

        const keyboardMove = getKeyboardVector(keysRef.current);
        const joystickMove = joystickRef.current.move;
        session.sendInput({
          move: mergeMoveVectors(keyboardMove, joystickMove),
          dash: dashQueuedRef.current,
        });
        dashQueuedRef.current = false;
        session.setMeasuredFps?.(fps);
        const nextSnapshot = session.update(elapsedMs);

        if (!nextSnapshot) {
          frameRef.current = requestAnimationFrame(loop);
          return;
        }

        renderer.render(nextSnapshot, session.playerId);

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
      sessionRef.current?.dispose();
      rendererRef.current = null;
      sessionRef.current = null;
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
    map: downtownMap,
    playerId: "player",
    debugVisible,
    joystick: joystickView,
    joystickHandlers,
    queueDash,
  };
}
