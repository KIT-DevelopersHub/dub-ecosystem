import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Standalone dev/build config for FE3. In production FE3 is consumed as a source
// FeatureModule by the FE2 app shell; this config only powers local `pnpm dev`.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  server: { port: 5173 },
});
