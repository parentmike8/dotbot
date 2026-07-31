import { useCallback, useEffect, useState } from "react";

const goalIntroStorageKey = "dotbot.goal-intro.v1";

export function useGoalIntro(): { visible: boolean; dismiss: () => void } {
  const [visible, setVisible] = useState(() => {
    try {
      return window.localStorage.getItem(goalIntroStorageKey) !== "dismissed";
    } catch {
      return true;
    }
  });

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(goalIntroStorageKey, "dismissed");
    } catch {
      // The current launch can still continue when storage is unavailable.
    }
    setVisible(false);
  }, []);

  return { visible, dismiss };
}

export function GoalIntro({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <section
      className="goal-intro"
      role="dialog"
      aria-modal="true"
      aria-labelledby="goal-intro-title"
      aria-describedby="goal-intro-copy"
    >
      <button
        className="goal-intro-close"
        type="button"
        onClick={onDismiss}
        aria-label="Close objective"
      >
        ×
      </button>
      <span className="goal-intro-kicker">The run</span>
      <h1 id="goal-intro-title">Protect your core at all times.</h1>
      <p id="goal-intro-copy">
        Pick up Health to restore shields. Grab loot, then extract before time runs out.
      </p>
      <button className="goal-intro-action" type="button" onClick={onDismiss} autoFocus>
        Enter run
      </button>
    </section>
  );
}
