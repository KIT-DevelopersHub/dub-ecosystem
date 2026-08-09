import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// FE7 admin-roster feature module. Standalone dev harness only; in production
// this module is code-split into the FE2 admin SPA shell via `adminModule`.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  server: { port: 5177 },
});
