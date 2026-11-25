import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { execSync } from "node:child_process";
import { appHealthManifest } from "./vite-plugin-app-health";

// Build stamp shown in the staging debug menu only (unreferenced elsewhere => absent in prod).
function buildInfo(): { sha: string; time: string } {
  let sha = process.env.GITHUB_SHA ?? "";
  if (!sha) {
    try {
      sha = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      sha = "unknown";
    }
  }
  return { sha: sha.slice(0, 12), time: new Date().toISOString() };
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
  define: {
    __FE2_BUILD_INFO__: JSON.stringify(buildInfo()),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  // onnxruntime-web (名刺の OCR) は wasm を自分の位置からの相対で読む。事前バンドルすると位置がずれて dev で読めない。
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
});
