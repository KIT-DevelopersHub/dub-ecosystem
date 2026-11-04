// Commander daemon entrypoint. Local-only. Manual start (see commander/README.md):
//   node --experimental-strip-types commander/daemon/src/index.ts
//
// Env:
//   COMMANDER_PORT              (default 4319)
//   COMMANDER_CLAUDE_BIN        (default: "claude" on PATH)
//   COMMANDER_CWD               (default: process.cwd())
//   COMMANDER_CLAUDE_ARGS       extra args, space-separated (e.g. "--model sonnet")
//   COMMANDER_OPERATOR_TOKEN    shared token; when set, all routes but /health & / need it
//   COMMANDER_RUN_IDLE_TIMEOUT_MS  idle watchdog: kill only after this much SILENCE,
//                                  reset on every stream chunk (default 1800000 = 30min; 0 disables)
//   COMMANDER_RUN_TIMEOUT_MS    hard wall-clock cap, never reset (default 7200000 = 2h; 0 disables)
//   COMMANDER_SERVICE_URL       commander-service base URL; when set, runs are persisted
//   COMMANDER_SERVICE_TOKEN     token sent to commander-service (x-commander-token)
//   COMMANDER_ISOLATE_ENV       "0"/"false" to disable env isolation (default: on)
//   COMMANDER_CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR handed to spawned claude
//                               (default: commander/.claude-home next to this daemon)
//   COMMANDER_DUB_API_BASE      api-gateway origin for "Dubを操作" (e.g. the staging workers.dev
//                               URL); unset disables /operate/preview|execute
//   COMMANDER_DUB_API_TOKEN     bot session token, OR
//   COMMANDER_DUB_BOT_EMAIL / COMMANDER_DUB_BOT_PASSWORD  bot login (re-login on 401)
//   COMMANDER_OPERATE_AUDIT_LOG JSONL audit file (default ~/.commander/operate-audit.jsonl)
//   COMMANDER_OPERATE_PROTECTED_ROLE_IDS / _USER_IDS  comma lists no plan may target (the
//                               owner's and the bot's own); roles default to role_sys_admin
//   COMMANDER_PERMISSION_MODE   --permission-mode for headless claude (default
//                               "acceptEdits" so Edit/Write work non-interactively; "" omits)
//   COMMANDER_TASK_ISOLATION    0 disables per-task worktree + session (default on)
//   COMMANDER_REPO_ROOT         checkout task worktrees are added from (default COMMANDER_CWD)
//   COMMANDER_TASK_WORKTREE_ROOT parent dir of task-<id> worktrees (default <repo>/../dub-worktrees)
//   COMMANDER_TASK_BASE_REF     ref a new task worktree starts from (default origin/main)
//   COMMANDER_TASK_WORKTREE_SETUP optional shell cmd run once in a new task worktree

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BOOT_ID, createDaemonServer, VERSION } from "./server.ts";
import { abortInFlightRuns, reconcileAtBoot } from "./lifecycle.ts";
import { resolveClaudeConfigDir } from "./env.ts";
import type { DaemonConfig } from "./types.ts";

// commander/daemon/src/index.ts -> commander/.claude-home (robust to any cwd).
const DEFAULT_CLAUDE_CONFIG_DIR = fileURLToPath(
  new URL("../../.claude-home", import.meta.url),
);

const idList = (v: string): string[] => v.split(",").map((x) => x.trim()).filter(Boolean);

function loadConfig(): DaemonConfig {
  const isolateEnv = !/^(0|false|no)$/i.test(
    process.env.COMMANDER_ISOLATE_ENV ?? "",
  );
  // Fail-safe redirect: an EMPTY COMMANDER_CLAUDE_CONFIG_DIR must NOT fall through to
  // the personal ~/.claude (see resolveClaudeConfigDir). `?? DEFAULT` only catches
  // undefined, so an explicit "" would otherwise leave the redirect unset and re-attach
  // the operator's judgment-queue hook + personal CLAUDE.md to the spawned claude.
  const claudeConfigDir = resolveClaudeConfigDir(
    process.env.COMMANDER_CLAUDE_CONFIG_DIR,
    DEFAULT_CLAUDE_CONFIG_DIR,
  );
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
    isolateEnv,
    claudeConfigDir,
    // Default acceptEdits so headless runs can Edit/Write without an operator prompt.
    // Set COMMANDER_PERMISSION_MODE="" to omit the flag.
    permissionMode: process.env.COMMANDER_PERMISSION_MODE ?? "acceptEdits",
  };
  // Per-task isolation: each task runs in <root>/task-<id> (own branch + Claude session).
  // COMMANDER_TASK_ISOLATION=0 turns it off (legacy shared cwd; not recommended).
  if (!/^(0|false|no)$/i.test(process.env.COMMANDER_TASK_ISOLATION ?? "")) {
    const repoRoot = process.env.COMMANDER_REPO_ROOT ?? config.defaultCwd;
    config.taskWorkspaces = {
      repoRoot,
      worktreeRoot: process.env.COMMANDER_TASK_WORKTREE_ROOT ?? join(dirname(repoRoot), "dub-worktrees"),
      baseRef: process.env.COMMANDER_TASK_BASE_REF ?? "origin/main",
      ...(process.env.COMMANDER_TASK_WORKTREE_SETUP
        ? { setupCommand: process.env.COMMANDER_TASK_WORKTREE_SETUP }
        : {}),
    };
  }
  if (process.env.COMMANDER_SERVICE_URL) config.serviceUrl = process.env.COMMANDER_SERVICE_URL;
  if (process.env.COMMANDER_SERVICE_TOKEN) config.serviceToken = process.env.COMMANDER_SERVICE_TOKEN;
  const apiBase = process.env.COMMANDER_DUB_API_BASE?.replace(/\/+$/, "");
  if (apiBase) {
    config.operate = {
      baseUrl: apiBase,
      auditLogPath:
        process.env.COMMANDER_OPERATE_AUDIT_LOG || join(homedir(), ".commander", "operate-audit.jsonl"),
      protectedIds: {
        roles: idList(process.env.COMMANDER_OPERATE_PROTECTED_ROLE_IDS ?? "role_sys_admin"),
        users: idList(process.env.COMMANDER_OPERATE_PROTECTED_USER_IDS ?? ""),
      },
      // "Dubを操作" reaches the Commander board through the same service the runs persist to.
      ...(config.serviceUrl
        ? { commander: { baseUrl: config.serviceUrl.replace(/\/+$/, ""), ...(config.serviceToken ? { token: config.serviceToken } : {}) } }
        : {}),
    };
    if (process.env.COMMANDER_DUB_API_TOKEN) config.operate.token = process.env.COMMANDER_DUB_API_TOKEN;
    if (process.env.COMMANDER_DUB_BOT_EMAIL) config.operate.email = process.env.COMMANDER_DUB_BOT_EMAIL;
    if (process.env.COMMANDER_DUB_BOT_PASSWORD) config.operate.password = process.env.COMMANDER_DUB_BOT_PASSWORD;
  }
  return config;
}

const config = loadConfig();
const { server, store, sink } = createDaemonServer(config);

server.listen(config.port, "127.0.0.1", () => {
  // Bound to loopback only: single-operator, no network exposure (ADR 0003).
  console.log(
    `[commander-daemon ${VERSION}] listening on http://127.0.0.1:${config.port}` +
      ` (claude=${config.claudeBin}, cwd=${config.defaultCwd},` +
      ` auth=${config.operatorToken ? "on" : "off"},` +
      ` idle=${config.idleTimeoutMs}ms, hardTimeout=${config.runTimeoutMs}ms,` +
      ` persist=${config.serviceUrl ? "on" : "off"},` +
      ` operate=${config.operate?.baseUrl ?? "off"},` +
      ` tasks=${config.taskWorkspaces?.worktreeRoot ?? "shared-cwd"},` +
      ` isolateEnv=${config.isolateEnv}, claudeConfigDir=${config.claudeConfigDir})`,
  );
});

// Self-heal runs the previous daemon left `running` (its claude children died with it).
// Background + best-effort: boot never waits on or fails because of commander-service.
if (config.serviceUrl) {
  void reconcileAtBoot({
    serviceUrl: config.serviceUrl,
    serviceToken: config.serviceToken,
    before: BOOT_ID,
    ownedIds: () => store.list().map((r) => r.id),
  });
}

// Graceful stop: record this daemon's in-flight runs as failed before exiting (short cap).
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // second signal: give up waiting
    stopping = true;
    void abortInFlightRuns(store, sink, 3000)
      .catch(() => [])
      .finally(() => {
        server.close();
        process.exit(sig === "SIGINT" ? 130 : 143); // conventional 128+signal
      });
  });
}
