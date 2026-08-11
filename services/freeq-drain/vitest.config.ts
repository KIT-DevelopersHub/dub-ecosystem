import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Local config so `pnpm --filter @dub/freeq-drain test` resolves test files and @dub/*
// path aliases from this package's cwd. Root vitest.config still covers `pnpm test`.
export default defineConfig({
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
