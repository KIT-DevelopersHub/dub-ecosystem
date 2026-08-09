import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// FE7 admin-roster feature module. Standalone dev harness only; in production
// this module is code-split into the FE2 admin SPA shell via `adminModule`.
//
// @dub/ui (apps/fe1-design-system) is consumed from source: no dist is built in
// the monorepo and it is not listed in the root tsconfig `paths` that
// vite-tsconfig-paths reads, so it is aliased here explicitly. All other
// @dub/* packages resolve via vite-tsconfig-paths against the root tsconfig.
const fe1 = (p: string) => fileURLToPath(new URL(`../fe1-design-system/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  resolve: {
    alias: {
      "@dub/ui/icons": fe1("icons.ts"),
      "@dub/ui": fe1("index.tsx"),
    },
  },
  server: { port: 5177 },
});
