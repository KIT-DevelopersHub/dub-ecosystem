// Commander daemon entrypoint. Local-only. Manual start (see commander/README.md):
//   node --experimental-strip-types commander/daemon/src/index.ts
//
// Env:
//   COMMANDER_PORT       (default 4319)
//   COMMANDER_CLAUDE_BIN (default: "claude" on PATH)
//   COMMANDER_CWD        (default: process.cwd())
//   COMMANDER_CLAUDE_ARGS extra args, space-separated (e.g. "--model sonnet")

import { createDaemonServer, VERSION } from "./server.ts";
import type { DaemonConfig } from "./types.ts";

function loadConfig(): DaemonConfig {
  return {
    port: Number(process.env.COMMANDER_PORT ?? 4319),
    claudeBin: process.env.COMMANDER_CLAUDE_BIN ?? "claude",
    defaultCwd: process.env.COMMANDER_CWD ?? process.cwd(),
    extraArgs: (process.env.COMMANDER_CLAUDE_ARGS ?? "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const config = loadConfig();
const { server } = createDaemonServer(config);

server.listen(config.port, "127.0.0.1", () => {
  // Bound to loopback only: single-operator, no network exposure (ADR 0003).
  console.log(
    `[commander-daemon ${VERSION}] listening on http://127.0.0.1:${config.port}` +
      ` (claude=${config.claudeBin}, cwd=${config.defaultCwd})`,
  );
});
