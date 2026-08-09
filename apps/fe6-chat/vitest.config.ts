import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// FE6-owned runner. jsdom for component tests; @dub/* resolved to source.
// Tests are co-located under src/**/*.test.ts(x) so the root vitest config
// (which only globs apps/*/test/**) never double-collects them in node env.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
