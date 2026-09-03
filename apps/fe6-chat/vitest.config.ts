import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// FE6-owned runner. jsdom for component tests; @dub/* resolved to source.
// Tests are co-located under src/**/*.test.ts(x) so the root vitest config
// (which only globs apps/*/test/**) never double-collects them in node env.
// @dub/ui is aliased to FE1 source so shared composites share one React context
// instance (matches the @dub/app-ui + FE4 harnesses).
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
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
