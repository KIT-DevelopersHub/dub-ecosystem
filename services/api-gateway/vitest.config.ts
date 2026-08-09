// Local vitest config so `pnpm --filter @dub/api-gateway test` resolves this
// package's tests when run from the service directory. The root config also picks
// these up via its services/*/test glob during a full-monorepo run.
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
