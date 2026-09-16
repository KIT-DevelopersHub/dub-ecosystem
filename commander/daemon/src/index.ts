// Commander daemon entrypoint. Local-only. Manual start (see commander/README.md):
//   node --experimental-strip-types commander/daemon/src/index.ts
//
// Env:
//   COMMANDER_PORT           (default 4319)
//   COMMANDER_CLAUDE_BIN     (default: "claude" on PATH)
//   COMMANDER_CWD            (default: process.cwd())
//   COMMANDER_CLAUDE_ARGS    extra args, space-separated (e.g. "--model sonnet")
//   COMMANDER_OPERATOR_TOKEN shared token; when set, all routes but /health & / need it
//   COMMANDER_RUN_IDLE_TIMEOUT_MS  idle watchdog: kill only after this much SILENCE,
//                                  reset on every stream chunk (default 1800000 = 30min; 0 disables)
//   COMMANDER_RUN_TIMEOUT_MS hard wall-clock cap, never reset (default 7200000 = 2h; 0 disables)
//   COMMANDER_SERVICE_URL    commander-service base URL; when set, runs are persisted
//   COMMANDER_SERVICE_TOKEN  token sent to commander-service (x-commander-token)

import { createDaemonServer, VERSION } from "./server.ts";
import type { DaemonConfig } from "./types.ts";

function loadConfig(): DaemonConfig {
  const config: DaemonConfig = {
    port: Number(process.env.COMMANDER_PORT ?? 4319),
    claudeBin: process.env.COMMANDER_CLAUDE_BIN ?? "claude",
    defaultCwd: process.env.COMMANDER_CWD ?? process.cwd(),
    extraArgs: (process.env.COMMANDER_CLAUDE_ARGS ?? "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean),
    operatorToken: process.env.COMMANDER_OPERATOR_TOKEN ?? "",
    idleTimeoutMs: Number(process.env.COMMANDER_RUN_IDLE_TIMEOUT_MS ?? 1_800_000),
    runTimeoutMs: Number(process.env.COMMANDER_RUN_TIMEOUT_MS ?? 7_200_000),
  };
  if (process.env.COMMANDER_SERVICE_URL) config.serviceUrl = process.env.COMMANDER_SERVICE_URL;
  if (process.env.COMMANDER_SERVICE_TOKEN) config.serviceToken = process.env.COMMANDER_SERVICE_TOKEN;
  return config;
}

const config = loadConfig();
const { server } = createDaemonServer(config);

server.listen(config.port, "127.0.0.1", () => {
  // Bound to loopback only: single-operator, no network exposure (ADR 0003).
  console.log(
    `[commander-daemon ${VERSION}] listening on http://127.0.0.1:${config.port}` +
      ` (claude=${config.claudeBin}, cwd=${config.defaultCwd},` +
      ` auth=${config.operatorToken ? "on" : "off"},` +
      ` idle=${config.idleTimeoutMs}ms, hardTimeout=${config.runTimeoutMs}ms,` +
      ` persist=${config.serviceUrl ? "on" : "off"})`,
  );
});
