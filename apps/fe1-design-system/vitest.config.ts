import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// FE1 unit-test config (jsdom + testing-library). Kept local to this package so the
// root vitest (node env, *.test.ts) is untouched. CSS Modules resolve to a proxy of
// class-name strings; tests assert on roles/aria/data-* rather than hashed classes.
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    globals: true,
    environment: "jsdom",
    css: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
