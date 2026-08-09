import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Local config so `pnpm --filter @dub/mo3-mobile-bff test` resolves test files and
// @dub/* path aliases from this package's cwd. Root vitest.config still covers the
// whole-repo `pnpm test` run.
export default defineConfig({
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
