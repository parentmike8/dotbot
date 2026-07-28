import type { AudioFeedbackStatus, FeedbackPreferences } from "../game/feedback/ImpactFeedback";

type FeedbackControlsProps = {
  preferences: FeedbackPreferences;
  audioStatus: AudioFeedbackStatus;
  onToggleSound: () => void;
  onToggleHaptics: () => void;
  onToggleReducedMotion: () => void;
  onTestSound: () => void;
};

export function FeedbackControls({
  preferences,
  audioStatus,
  onToggleSound,
  onToggleHaptics,
  onToggleReducedMotion,
  onTestSound,
}: FeedbackControlsProps) {
  const audioStatusText = audioStatusLabel(audioStatus);
  return (
    <section className="feedback-controls" aria-label="Game feedback settings">
      {/* No section heading: the only panel this appears in is already called Settings,
          and "FEEDBACK" above three switches labelled Sound, Haptics and Reduced motion
          was a word that named nothing the switches did not. */}
      <header>
        <output className={`audio-status ${audioStatus}`} aria-live="polite">{audioStatusText}</output>
      </header>
      <div>
        <button type="button" aria-pressed={preferences.sound} onClick={onToggleSound}>
          Sound {preferences.sound ? "on" : "off"}
        </button>
        <button
          type="button"
          onClick={onTestSound}
          disabled={!preferences.sound || audioStatus === "unavailable" || audioStatus === "error"}
        >
          Test sound
        </button>
        <button type="button" aria-pressed={preferences.haptics} onClick={onToggleHaptics}>
          Haptics {preferences.haptics ? "on" : "off"}
        </button>
        <button type="button" aria-pressed={preferences.reducedMotion} onClick={onToggleReducedMotion}>
          Reduced motion {preferences.reducedMotion ? "on" : "off"}
        </button>
      </div>
      <small>On iPhone, game audio follows the Ring/Silent switch.</small>
    </section>
  );
}

function audioStatusLabel(status: AudioFeedbackStatus): string {
  switch (status) {
    case "off": return "Sound off";
    case "starting": return "Starting audio";
    case "ready": return "Audio ready";
    case "needsGesture": return "Tap Test sound";
    case "interrupted": return "Audio interrupted";
    case "unavailable": return "Audio unavailable";
    case "error": return "Audio error";
    default: return "Audio idle";
  }
}
