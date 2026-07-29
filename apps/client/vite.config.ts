import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { labShotPlugin } from "./labShotPlugin";
import { mapSourcePlugin } from "./mapSourcePlugin";

export default defineConfig({
  plugins: [react(), labShotPlugin(), mapSourcePlugin()],
  test: {
    // See the file: pixi reads `navigator.userAgent` at module scope, and the renderer's
    // drawing code now imports a pixi value (`FillGradient`) rather than only types.
    setupFiles: ["./src/test/browserGlobals.ts"],
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3001", ws: true },
      "/api": { target: "http://localhost:3001" },
    },
  },
});
