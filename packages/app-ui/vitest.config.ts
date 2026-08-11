import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// @dub/ui is consumed from source (no dist is built in the monorepo); alias it to
// the FE1 source entry, matching the FE2〜FE7 harnesses.
const fe1 = (p: string) => fileURLToPath(new URL(`../../apps/fe1-design-system/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  resolve: {
    alias: {
      "@dub/ui/icons": fe1("icons.ts"),
      "@dub/ui": fe1("index.tsx"),
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    css: true,
  },
});
