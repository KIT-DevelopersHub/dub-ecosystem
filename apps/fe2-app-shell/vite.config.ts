import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { appHealthManifest } from "./vite-plugin-app-health";

// FE2 admin SPA build. Distribution = Workers static assets (provisional, theme5 4-4).
// SPA fallback handled by the serving Worker (infra unit); Vite emits a plain SPA.
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths({ projects: ["../../tsconfig.base.json", "./tsconfig.json"] }),
    // Emits dist/app-health.json (every JS/CSS chunk) for the app-health-monitor stale-chunk check.
    appHealthManifest(),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
