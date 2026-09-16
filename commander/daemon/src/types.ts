// Commander daemon — shared types for the exec bridge.
//
// The daemon is a LOCAL Node process (never a Cloudflare Worker). It spawns the
// existing local Claude Code CLI in headless mode and relays its stream-json
// output to web clients over SSE. One HTTP POST = one `Run` = one `claude -p`
// invocation.

export type RunStatus = "pending" | "running" | "succeeded" | "failed";

/** A single event emitted while a run executes, relayed to SSE subscribers. */
export type RunEvent =
  | { type: "status"; status: RunStatus; at: string }
  /** One parsed stream-json object from `claude --output-format stream-json`. */
  | { type: "claude"; at: string; data: unknown }
  /** A raw stdout line that was NOT valid JSON (defensive; normally none). */
  | { type: "stdout"; at: string; line: string }
  | { type: "stderr"; at: string; line: string }
  | { type: "exit"; at: string; code: number | null }
  | { type: "error"; at: string; message: string };

export interface Run {
  id: string;
  prompt: string;
  cwd: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Buffered event history so a late SSE subscriber can replay from the start. */
  events: RunEvent[];
}

export interface StartRunInput {
  prompt: string;
  /** Working directory for the spawned claude process. Defaults to the daemon's. */
  cwd?: string;
}

export interface DaemonConfig {
  port: number;
  /** Absolute path to the claude CLI binary. */
  claudeBin: string;
  /** Default cwd for spawned runs when a request omits one. */
  defaultCwd: string;
  /** Extra args appended to every `claude -p` invocation. */
  extraArgs: string[];
  /**
   * Shared operator token (ADR 0003). When set, every request except GET /health must
   * present it (Authorization: Bearer <token>, or ?token= for the SSE stream); when
   * empty the daemon is open (single-operator loopback dev). [[secrets-stay-local]].
   */
  operatorToken: string;
  /**
   * Idle watchdog (ms): a run is killed + marked failed only after it goes SILENT
   * (no stream-json / stdout / stderr activity) for this long. The timer resets on
   * every chunk, so a working agentic loop is never killed mid-progress — only a hung
   * or wedged `claude` trips it. <= 0 disables the idle watchdog.
   */
  idleTimeoutMs: number;
  /**
   * Hard wall-clock cap per run (ms) — a safety net that is NEVER reset. A run still
   * executing after this is killed and marked failed regardless of activity. Set long
   * (real agentic dev can run 30-120+ min). <= 0 disables the hard cap.
   */
  runTimeoutMs: number;
  /**
   * Optional commander-service base URL. When set, each run + its events are persisted
   * there (commander_runs / commander_run_events) best-effort (never fails the run).
   */
  serviceUrl?: string;
  /** Token presented to commander-service (x-commander-token) when persisting. */
  serviceToken?: string;
}
