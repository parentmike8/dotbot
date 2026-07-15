import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { MapStudio } from "./ui/MapStudio";
import { BaseApp } from "./ui/base/BaseApp";
import "./ui/styles.css";
import { selectClientSurface } from "./routing";

// Development-only map authoring view: /?studio
const surface = selectClientSurface(window.location.search);

createRoot(document.getElementById("root")!).render(surface === "studio" ? <MapStudio /> : surface === "solo" ? <App /> : <BaseApp />);
