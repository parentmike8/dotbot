import { createRoot } from "react-dom/client";
import "./ui/styles.css";
import { selectClientSurface } from "./routing";

function syncVisibleViewportHeight(): void {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
}

syncVisibleViewportHeight();
window.addEventListener("resize", syncVisibleViewportHeight, { passive: true });
window.addEventListener("orientationchange", syncVisibleViewportHeight, { passive: true });
window.visualViewport?.addEventListener("resize", syncVisibleViewportHeight, { passive: true });

async function mount(): Promise<void> {
  const surface = selectClientSurface(window.location.search);
  const Component = surface === "lab"
    ? (await import("./ui/StyleLab")).StyleLab
    : surface === "skins"
      ? (await import("./ui/hud/HudSkins")).HudSkins
      : surface === "hud"
      ? (await import("./ui/downed/HudLab")).HudLab
      : surface === "studio"
        ? (await import("./ui/MapStudio")).MapStudio
        : surface === "solo"
          ? (await import("./ui/App")).App
          : (await import("./ui/base/BaseApp")).BaseApp;

  createRoot(document.getElementById("root")!, {
    /**
     * Without this a surface that throws during render leaves a blank page and
     * nothing in the console — React swallows the error and only warns that one
     * happened. Studio spent a while looking like a CSS problem because of it.
     */
    onUncaughtError: (error) => {
      // eslint-disable-next-line no-console
      console.error(`[${surface}]`, error);
    },
  }).render(<Component />);
}

void mount();
