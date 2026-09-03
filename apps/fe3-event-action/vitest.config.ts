import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// @dub/ui is aliased to FE1 source so shared composites (e.g. app-ui's useToast)
// and this app's <ToastProvider> share a single React context instance. Matches
// the @dub/app-ui + FE4/FE6 harnesses.
const fe1 = (p: string) => fileURLToPath(new URL(`../fe1-design-system/src/${p}`, import.meta.url));

// App-local vitest config. The root config is node-env and .test.ts only; FE3
// needs jsdom + tsx for React component/hook tests, so it runs under its own
// config (`pnpm --filter @dub/fe3-event-action test`). Root config is untouched.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  resolve: {
    alias: {
      "@dub/ui/icons": fe1("icons.ts"),
      "@dub/ui": fe1("index.tsx"),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    css: true,
  },
});
