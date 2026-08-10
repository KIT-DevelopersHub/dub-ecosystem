import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Local config so `pnpm --filter @dub/freeq test` resolves this workspace's test
// files and @dub/* path aliases from its own cwd. The root vitest.config still
// covers the whole-repo `pnpm test` run.
export default defineConfig({
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
