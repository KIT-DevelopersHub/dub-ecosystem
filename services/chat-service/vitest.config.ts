import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Local config so `pnpm --filter @dub/chat-service test` resolves test files and
// @dub/* path aliases from this package's cwd. Root vitest.config still covers
// the whole-repo `pnpm test` run.
export default defineConfig({
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The ChatRoom DO tests exercise real WebSocket upgrades/round-trips. They pass
    // quickly locally, but CI runs all ~48 packages' suites through `turbo run test`
    // (default concurrency 10) on a 4-vCPU runner, so under CPU contention these
    // async waits can exceed Vitest's 5000ms default and flake with "Test timed out
    // in 5000ms". A wider budget keeps full coverage while still catching a genuine
    // hang.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
