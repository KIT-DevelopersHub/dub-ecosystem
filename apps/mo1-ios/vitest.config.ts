import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// App-local vitest config so `pnpm --filter ./apps/mo1-ios test` resolves the
// suite from this dir. Pure-logic reference layer -> node env, no DOM.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["../../tsconfig.base.json", "./tsconfig.json"] })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
