import type { RefObject } from "react";

export function KillCamOverlay({ open, viewportRef, label, progress, pass, replaysComplete, onReplay, onClose }: {
  open: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  label: string;
  progress: number;
  pass: 1 | 2;
  replaysComplete: boolean;
  onReplay: () => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="kill-cam-overlay"
      data-open={open ? "true" : "false"}
      aria-label="Kill cam"
      aria-live={open ? "polite" : "off"}
      aria-hidden={!open}
    >
      <div ref={viewportRef} className="kill-cam-viewport" aria-hidden="true" />
      <div className="kill-cam-toolbar">
        <div className="kill-cam-copy">
          <strong>{replaysComplete ? "REPLAY COMPLETE" : `REPLAY ${pass}/2`}</strong>
          <span>{label}</span>
        </div>
        <div className="kill-cam-actions">
          <button
            type="button"
            aria-label="Replay kill cam"
            onPointerDown={(event) => {
              event.preventDefault();
              onReplay();
            }}
            onClick={(event) => event.currentTarget.blur()}
          >
            <span>REPLAY</span>
            <span aria-hidden="true">↻</span>
          </button>
          <button
            type="button"
            aria-label="Close kill cam"
            onPointerDown={(event) => {
              event.preventDefault();
              onClose();
            }}
            onClick={(event) => event.currentTarget.blur()}
          >
            <span>CLOSE</span>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>
      <span className="kill-cam-track" aria-hidden="true">
        <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }} />
      </span>
    </aside>
  );
}
