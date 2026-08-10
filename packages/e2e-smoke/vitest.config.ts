import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve @dub/* to workspace source directly (no build step). The root
// vitest.config uses vite-tsconfig-paths, but this package also runs standalone
// via `pnpm --filter @dub/e2e-smoke test`, so it declares the aliases explicitly —
// including @dub/gantt-calc, which the root tsconfig paths map omits.
const pkg = (name: string, entry = "src/index.ts"): [string, string] => [
  name,
  fileURLToPath(new URL(`../${name.replace("@dub/", "")}/${entry}`, import.meta.url)),
];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      [
        pkg("@dub/types"),
        pkg("@dub/errors"),
        pkg("@dub/observability"),
        pkg("@dub/http"),
        pkg("@dub/db"),
        pkg("@dub/events"),
        pkg("@dub/auth-client"),
        pkg("@dub/gantt-calc"),
      ].map(([k, v]) => [k, v]),
    ),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
