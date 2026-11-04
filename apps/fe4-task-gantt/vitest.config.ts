import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Full-App integration tests (e.g. parent-status-multilevel-integration) wait on the
    // real 500ms autosave debounce twice and finish in ~1.2s locally, but under
    // `turbo run test` concurrency on CI they reached ~6.3s and flaked with
    // "Test timed out in 5000ms" (blocking deploy.yml). Same budget as fe7-admin-roster.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
