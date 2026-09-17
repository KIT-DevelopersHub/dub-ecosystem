// Environment isolation for the spawned Claude Code CLI.
//
// PROBLEM this solves: the daemon used to spawn `claude -p` with `env: process.env`,
// so the headless Claude Code inherited the OPERATOR's personal `~/.claude`
// (CLAUDE.md / rules/ / hooks / lessons — the judgment-queue "operating
// constitution", chat-pointer guards, Stop hooks, …). Commander's own agent would
// then try to file into the personal judgment queue or trip personal Stop hooks.
//
// FIX: never hand the child a full copy of process.env. Build a minimal allow-listed
// env and point `CLAUDE_CONFIG_DIR` at Commander's OWN config home
// (`commander/.claude-home`), which carries a tiny commander-only CLAUDE.md and a
// hooks-free settings.json. Claude Code reads its USER-scope config (CLAUDE.md,
// settings.json, hooks) from `CLAUDE_CONFIG_DIR` when set, else from `~/.claude`;
// redirecting it structurally severs the personal config.
//
// Note (macOS): the subscription auth token lives in the login Keychain (keyed by
// service, not by config-dir path), so isolating CLAUDE_CONFIG_DIR keeps auth working.

/** Config knobs for building the spawn env. */
export interface SpawnEnvConfig {
  /** When true, build a minimal allow-listed env (default). When false, inherit
   *  the parent env but still redirect CLAUDE_CONFIG_DIR if provided. */
  isolateEnv: boolean;
  /** Absolute path to Commander's own Claude config home (=> CLAUDE_CONFIG_DIR). */
  claudeConfigDir?: string;
}

// Vars a spawned CLI legitimately needs regardless of isolation (locale, TLS, proxy,
// PATH so the `claude`/`node`/`git` binaries resolve, HOME for caches).
export const ESSENTIAL_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

/** Prefixes preserved from the parent env even under isolation (commander's own
 *  knobs + Claude auth/runtime). Personal CLAUDE_CONFIG_DIR is overridden below. */
const PRESERVE_PREFIXES: readonly string[] = ["COMMANDER_", "ANTHROPIC_", "CLAUDE_"];

/**
 * Build the env handed to the spawned claude process.
 *
 * Isolated (default): a fresh object containing only the essential keys plus the
 * preserved prefixes (COMMANDER_, ANTHROPIC_, CLAUDE_), with CLAUDE_CONFIG_DIR forced
 * to Commander's config home last (so any inherited personal value cannot win).
 *
 * Non-isolated: the full parent env, but CLAUDE_CONFIG_DIR still redirected when set.
 */
export function buildSpawnEnv(
  config: SpawnEnvConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!config.isolateEnv) {
    const env = { ...base };
    if (config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
    return env;
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of ESSENTIAL_ENV_KEYS) {
    const v = base[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (PRESERVE_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  // CLAUDE_CONFIG_DIR is controlled explicitly (never inherited): a personal value
  // slipping through the CLAUDE_* passthrough would re-attach the personal ~/.claude.
  delete env.CLAUDE_CONFIG_DIR;
  if (config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
  return env;
}
