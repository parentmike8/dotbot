import type { RefObject } from "react";

export function KillCamOverlay({ open, viewportRef, label, progress, onClose }: {
  open: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  label: string;
  progress: number;
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
          <strong>KILL CAM</strong>
          <span>{label}</span>
        </div>
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
      <span className="kill-cam-track" aria-hidden="true">
        <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }} />
      </span>
    </aside>
  );
}
