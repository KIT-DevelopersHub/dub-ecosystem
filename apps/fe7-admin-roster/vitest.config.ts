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
  },
});
