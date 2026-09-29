import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Commander web standalone dev/build. Resolves @dub/* to source via tsconfig
// paths (matches the monorepo convention — no prebuilt dist needed).
export default defineConfig({
  plugins: [react(), tsconfigPaths({ root: "../.." })],
  server: { port: 5609 },
});
