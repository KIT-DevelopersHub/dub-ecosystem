import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Local (filtered) test config: `pnpm --filter ./apps/fe7-admin-roster test`.
// jsdom by default for component/hook tests; pure-logic .test.ts run fine here too.
// Component test files also carry a `// @vitest-environment jsdom` docblock so they
// stay green under the root (node-env) vitest without editing root config.
//
// @dub/ui is aliased to fe1 source (see vite.config.ts for the rationale).
const fe1 = (p: string) => fileURLToPath(new URL(`../fe1-design-system/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  resolve: {
    alias: {
      "@dub/ui/icons": fe1("icons.ts"),
      "@dub/ui": fe1("index.tsx"),
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    css: true,
    // Real-timer component tests (userEvent typing + a 400ms debounced autosave
    // asserted via waitFor) finish in <1s locally, but CI runs all ~48 packages'
    // suites through `turbo run test` (default concurrency 10) on a 4-vCPU runner,
    // so real-time waits can balloon past Vitest's 5000ms default and flake with
    // "Test timed out in 5000ms". A wider budget keeps full coverage while still
    // catching a genuine hang.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
