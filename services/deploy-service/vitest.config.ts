import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Service-local config so `pnpm --filter @dub/deploy-service test` resolves this
// package's tests (the root config's globs are relative to the repo root).
export default defineConfig({
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
