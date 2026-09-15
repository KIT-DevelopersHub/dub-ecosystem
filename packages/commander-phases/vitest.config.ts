import { defineConfig } from "vitest/config";

// Package-owned runner (node env). Pure FSM, no DOM, no @dub/* aliases needed.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
