import { useEffect, useRef } from "react";
import type { GameSnapshot, MapDocument, Vec2 } from "@dotbot/game/types";
import type { LiveMark } from "../game/pings";
import { WorldMapCanvas } from "../game/worldMap/WorldMapCanvas";

export function WorldMapOverlay({
  map,
  snapshot,
  viewerId,
  marks,
  onPing,
  onChoosePing,
  onClose,
}: {
  map: MapDocument;
  snapshot: GameSnapshot;
  viewerId: string;
  marks: readonly LiveMark[];
  onPing: (position: Vec2) => void;
  onChoosePing: (position: Vec2, screen: Vec2) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<WorldMapCanvas | null>(null);
  const live = useRef({ onPing, onChoosePing });
  live.current = { onPing, onChoosePing };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = new WorldMapCanvas();
    canvasRef.current = canvas;
    void canvas.mount(host, map, {
      onPing: (point) => live.current.onPing(point),
      onChoosePing: (point, screen) => live.current.onChoosePing(point, screen),
    });
    return () => {
      canvas.dispose();
      canvasRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    canvasRef.current?.update(snapshot, viewerId, marks);
  }, [snapshot, viewerId, marks]);

  return (
    <section className="world-map" aria-label="World map">
      <div ref={hostRef} className="world-map-canvas" />
      <header className="world-map-toolbar">
        <div>
          <strong>World map</strong>
          <span>Exterior · drag to pan · scroll or pinch to zoom · click to mark</span>
        </div>
        <nav aria-label="Map controls">
          <button type="button" onClick={() => canvasRef.current?.zoomBy(0.8)} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => canvasRef.current?.fit()}>Fit</button>
          <button type="button" onClick={() => canvasRef.current?.zoomBy(1.25)} aria-label="Zoom in">+</button>
          <button type="button" className="world-map-close" onClick={onClose}>Close</button>
        </nav>
      </header>
      <div className="world-map-key" aria-label="Map key">
        <span><i className="map-key-you" /> You</span>
        <span><i className="map-key-squad" /> Squad</span>
        <span><i className="map-key-ping" /> Mark</span>
      </div>
    </section>
  );
}
