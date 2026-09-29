import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Commander-web-owned runner. jsdom for component tests; @dub/* resolved to
// source. Co-located src/**/*.test.tsx so the root config never double-collects.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
