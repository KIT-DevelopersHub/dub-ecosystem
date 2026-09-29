import { defineConfig } from "vitest/config";

// BDD-owned runner (node env). Real daemon + service spawn child processes and open
// loopback sockets, so give scenarios a generous per-test timeout.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
