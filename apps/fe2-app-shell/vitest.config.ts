import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// App-local vitest config (jsdom). Tests are co-located in src/ as *.test.tsx so the
// root vitest glob (apps/*/test/**/*.test.ts, node env) never picks them up.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ projects: ["../../tsconfig.base.json", "./tsconfig.json"] })],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.tsx"],
  },
});
