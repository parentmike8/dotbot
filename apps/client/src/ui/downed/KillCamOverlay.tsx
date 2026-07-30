export function KillCamOverlay({ label, progress, onSkip }: {
  label: string;
  progress: number;
  onSkip: () => void;
}) {
  return (
    <aside className="kill-cam-overlay" aria-label="Kill cam" aria-live="polite">
      <div className="kill-cam-copy">
        <strong>KILL CAM</strong>
        <span>{label}</span>
      </div>
      <span className="kill-cam-track" aria-hidden="true">
        <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }} />
      </span>
      <button
        type="button"
        onPointerDown={(event) => {
          event.preventDefault();
          onSkip();
        }}
        onClick={(event) => event.currentTarget.blur()}
      >
        <kbd>SPACE</kbd>
        <span>SKIP</span>
      </button>
    </aside>
  );
}
