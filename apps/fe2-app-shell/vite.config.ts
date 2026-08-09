import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// FE2 admin SPA build. Distribution = Workers static assets (provisional, theme5 4-4).
// SPA fallback handled by the serving Worker (infra unit); Vite emits a plain SPA.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ projects: ["../../tsconfig.base.json", "./tsconfig.json"] })],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
