import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import tsconfigPaths from "vite-tsconfig-paths";

// DO tests run inside the real Workers runtime (workerd via miniflare) so the
// ChatRoom Durable Object, WebSocket hibernation, and ws-ticket verify exercise
// production semantics. Bindings are declared inline (not via wrangler.toml) so the
// pool does not try to resolve the master's external Service/Queue bindings.
// Node-environment tests stay in vitest.config.ts; the two are joined by
// vitest.workspace.ts. DO tests use the *.do-test.ts suffix so the node globs
// (**/*.test.ts) never pick them up.
export default defineWorkersConfig({
  // Resolve @dub/* to their package src via TS path aliases (they publish only
  // types, not a runtime entry) — same mechanism the node config uses.
  plugins: [tsconfigPaths({ root: "../.." })],
  test: {
    include: ["test/do/**/*.do-test.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        // ChatRoom holds no durable rows and every test uses a unique channel id,
        // so per-test storage stacking is unnecessary; disabling it also avoids the
        // WAL-snapshot teardown assertion when sockets are still open at suite end.
        isolatedStorage: false,
        miniflare: {
          // Highest date the bundled workerd supports; prod wrangler.toml pins later.
          compatibilityDate: "2025-09-06",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            CHAT_ROOM: { className: "ChatRoom", useSQLite: true },
          },
          bindings: {
            WS_TICKET_SECRET: "test-secret",
            CHAT_RT_ALLOWED_ORIGINS: "https://app.developershub.jp",
          },
        },
      },
    },
  },
});
