import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { appHealthManifest } from "./vite-plugin-app-health";

// STAGING-ONLY one-click demo-login button (PR#398): the LoginScreen renders it only when
// import.meta.env.VITE_DEMO_AUTOLOGIN === "1". To make it PERMANENT across every staging
// (re)deploy — CI *and* any manual `pnpm run build` — derive the flag from the build's
// target gateway: a `-staging` gateway ⇒ compile the button in. This can never leak into
// production because prod builds target the prod gateway (no `-staging`), and the backend
// /auth/demo-login route exists only when auth-service has DEMO_AUTOLOGIN=1 (set solely by
// deploy-staging.sh). An explicit VITE_DEMO_AUTOLOGIN=1 (staging.yml) still forces it on.
if (process.env.VITE_DEMO_AUTOLOGIN !== "1" && /-staging\./.test(process.env.VITE_API_BASE_URL ?? "")) {
  process.env.VITE_DEMO_AUTOLOGIN = "1";
}

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
