import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// `projects` points the path-resolver at the workspace base tsconfig so @dub/*
// aliases resolve to package source when this service is tested in isolation
// (`pnpm --filter ./services/mail-automation test`).
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["../../tsconfig.base.json"] })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
