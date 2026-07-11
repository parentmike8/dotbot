import { useEffect, useRef, useState } from "react";
import type { GameSnapshot } from "@dotbot/game/types";
import { getKeyboardVector, movementKeyCodes } from "../../game/input";
import { GameRenderer } from "../../game/renderer/GameRenderer";
import type { NetSession } from "../../game/session/NetSession";

export function NetGameView({ session, roomCode }: { session: NetSession; roomCode: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const dashQueued = useRef(false);

  useEffect(() => {
    let disposed = false;
    let renderer: GameRenderer | null = null;
    let frame = 0;
    let lastFrame = performance.now();
    let lastHud = 0;
    const keys = new Set<string>();
    let resizeObserver: ResizeObserver | null = null;

    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        dashQueued.current = true;
      } else if (movementKeyCodes.has(event.code)) {
        event.preventDefault();
        keys.add(event.code);
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (movementKeyCodes.has(event.code)) {
        event.preventDefault();
        keys.delete(event.code);
      }
    };
    const clearKeys = () => keys.clear();

    async function mount() {
      const host = hostRef.current;
      if (!host) return;
      renderer = await GameRenderer.create(host, session.map);
      if (disposed) {
        renderer.destroy();
        return;
      }
      resizeObserver = new ResizeObserver(([entry]) => renderer?.resize(entry.contentRect.width, entry.contentRect.height));
      resizeObserver.observe(host);

      const loop = (now: number) => {
        if (disposed || !renderer) return;
        const elapsed = now - lastFrame;
        lastFrame = now;
        session.sendInput({ move: getKeyboardVector(keys), dash: dashQueued.current });
        dashQueued.current = false;
        const next = session.update(elapsed);
        if (next) {
          renderer.render(next, session.playerId);
          if (now - lastHud > 100) {
            setSnapshot(next);
            lastHud = now;
            if (import.meta.env.DEV) {
              (window as unknown as { __dotbotSnapshot?: GameSnapshot }).__dotbotSnapshot = next;
            }
          }
        }
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    }

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", clearKeys);
    document.addEventListener("visibilitychange", clearKeys);
    void mount();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      renderer?.destroy();
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", clearKeys);
      document.removeEventListener("visibilitychange", clearKeys);
      session.dispose();
    };
  }, [session]);

  const player = snapshot?.bots.find((bot) => bot.id === session.playerId);
  return (
    <main className="app-shell net-game" data-room-code={roomCode} data-player-id={session.playerId}>
      <div ref={hostRef} className="game-canvas" />
      <aside className="net-game-status" aria-label="Network game status">
        <span>Room {roomCode}</span>
        <strong>{player?.name ?? "Connecting"}</strong>
        <span>{player ? `${player.shields}/${player.maxShields} shields` : "Waiting for snapshots"}</span>
      </aside>
      <button className="net-dash-button" type="button" onPointerDown={() => { dashQueued.current = true; }}>
        Dash
      </button>
    </main>
  );
}
