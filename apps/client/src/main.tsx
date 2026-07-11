import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { MapStudio } from "./ui/MapStudio";
import { LobbyApp } from "./ui/lobby/LobbyApp";
import "./ui/styles.css";

// Development-only map authoring view: /?studio
const studio = new URLSearchParams(window.location.search).has("studio");
const multiplayer = window.location.hash === "#/lobby" || /^#\/r\/[A-Z2-9]{4}$/i.test(window.location.hash);

createRoot(document.getElementById("root")!).render(studio ? <MapStudio /> : multiplayer ? <LobbyApp /> : <App />);
