import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// @dub/ui is consumed from source (no dist is built for tests); alias it to the
// FE1 source entry so app-ui's `useToast` and this app's `<ToastProvider>` share a
// single React context instance (else composites hosted here throw "must be used
// within a ToastProvider"). Matches the @dub/app-ui harness.
const fe1 = (p: string) => fileURLToPath(new URL(`../fe1-design-system/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  resolve: {
    alias: {
      "@dub/ui/icons": fe1("icons.ts"),
      "@dub/ui": fe1("index.tsx"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
