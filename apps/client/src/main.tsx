import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { MapStudio } from "./ui/MapStudio";
import { BaseApp } from "./ui/base/BaseApp";
import "./ui/styles.css";

// Development-only map authoring view: /?studio
const studio = new URLSearchParams(window.location.search).has("studio");
const solo = new URLSearchParams(window.location.search).has("solo");

createRoot(document.getElementById("root")!).render(studio ? <MapStudio /> : solo ? <App /> : <BaseApp />);
