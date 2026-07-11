import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { MapStudio } from "./ui/MapStudio";
import "./ui/styles.css";

// Development-only map authoring view: /?studio
const studio = new URLSearchParams(window.location.search).has("studio");

createRoot(document.getElementById("root")!).render(studio ? <MapStudio /> : <App />);
