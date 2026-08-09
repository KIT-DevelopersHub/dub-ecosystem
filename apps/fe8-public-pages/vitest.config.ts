import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Resolve @dub/* to their package sources (tsconfig.base paths) so the app's
// unit tests run without a prior dist build. astro:content is never imported by
// tests — content schemas live in framework-agnostic src/content/schemas.ts.
export default defineConfig({
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
