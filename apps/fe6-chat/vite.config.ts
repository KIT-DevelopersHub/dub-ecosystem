import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// FE6 standalone dev/build. Resolves @dub/* to source via tsconfig paths so the
// contract packages need no prebuilt dist (matches the monorepo vitest setup).
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  server: { port: 5606 },
});
