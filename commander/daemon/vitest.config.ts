import { defineConfig } from "vitest/config";

// Daemon-owned runner (node env). Keeps vitest from walking up to the monorepo
// root config, whose globs don't cover commander/*.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
