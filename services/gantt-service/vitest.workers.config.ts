import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Workers-runtime tests run inside the real Workers runtime (workerd via miniflare) so
// the GanttRoom Durable Object, WebSocket hibernation, and ws-ticket verify exercise
// production semantics — proving the real WS fanout that node/jsdom cannot. Bindings are
// declared inline (not via wrangler.toml) so the pool does not try to resolve the read
// model's external Service bindings. Node-environment tests stay in vitest.config.ts; the
// two are joined by vitest.workspace.ts. These tests use the *.do-test.ts suffix so the
// node globs (**/*.test.ts) never pick them up.
export default defineWorkersConfig({
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/do/**/*.do-test.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        // GanttRoom holds no durable rows and every test uses a unique event id, so
        // per-test storage stacking is unnecessary; disabling it also avoids the
        // WAL-snapshot teardown assertion when sockets are still open at suite end.
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-09-06",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            GANTT_ROOM: { className: "GanttRoom", useSQLite: true },
          },
          bindings: {
            WS_TICKET_SECRET: "test-secret",
            GANTT_RT_ALLOWED_ORIGINS:
              "https://dub-fe2-app-shell.developershub-site.workers.dev,https://app.developershub.jp",
          },
        },
      },
    },
  },
});
