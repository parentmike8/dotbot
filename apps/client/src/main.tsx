import { createRoot } from "react-dom/client";
import "./ui/styles.css";
import { selectClientSurface } from "./routing";

async function mount(): Promise<void> {
  const surface = selectClientSurface(window.location.search);
  const Component = surface === "studio"
    ? (await import("./ui/MapStudio")).MapStudio
    : surface === "solo"
      ? (await import("./ui/App")).App
      : (await import("./ui/base/BaseApp")).BaseApp;

  createRoot(document.getElementById("root")!).render(<Component />);
}

void mount();
