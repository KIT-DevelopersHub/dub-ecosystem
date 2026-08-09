import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// App-local vitest config. The root config is node-env and .test.ts only; FE3
// needs jsdom + tsx for React component/hook tests, so it runs under its own
// config (`pnpm --filter @dub/fe3-event-action test`). Root config is untouched.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    css: true,
  },
});
