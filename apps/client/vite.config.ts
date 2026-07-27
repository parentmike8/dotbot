import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mapEditorPlugin } from "./mapEditorPlugin";
import { labShotPlugin } from "./labShotPlugin";
import { mapSourcePlugin } from "./mapSourcePlugin";

export default defineConfig({
  plugins: [react(), mapEditorPlugin(), labShotPlugin(), mapSourcePlugin()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3001", ws: true },
      "/api": { target: "http://localhost:3001" },
    },
  },
});
