import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// FE5 own vitest config (jsdom + RTL). Run via `pnpm --filter
// ./apps/fe5-notification-inbox test`. Kept separate from the root node-env
// config so component (.tsx) tests get a DOM without touching root settings.
// @dub/* resolve to workspace source (packages aren't pre-built in dev).
const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@dub/types": pkg("types/src/index.ts"),
      "@dub/tokens/css": pkg("tokens/src/css.ts"),
      "@dub/tokens": pkg("tokens/src/index.ts"),
      "@dub/errors": pkg("errors/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});
