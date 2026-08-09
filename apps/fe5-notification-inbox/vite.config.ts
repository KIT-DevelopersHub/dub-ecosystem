import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// FE5 dev/build. Standalone here (harness page mounts the FeatureModule against
// the mock client); in the real SPA, FE5 is consumed as a workspace package.
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
  server: { port: 5175 },
  build: { outDir: "dist" },
});
