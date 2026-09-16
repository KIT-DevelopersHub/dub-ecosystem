// Run store + claude spawner. Each run spawns the local Claude Code CLI in
// headless mode (`claude -p <prompt> --output-format stream-json --verbose`),
// parses its line-delimited JSON stdout, and fans events out to SSE listeners.
// A run can be cancelled (kills the child) and is killed automatically if it
// exceeds the configured wall-clock timeout. Every run + event is mirrored to an
// optional RunSink (persistence via commander-service).

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DaemonConfig, Run, RunEvent, StartRunInput } from "./types.ts";
import { nullSink, type RunSink } from "./sink.ts";

type Listener = (event: RunEvent) => void;

interface Active {
  child: ChildProcess;
  /** Idle watchdog (reset on every stream chunk). */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Hard wall-clock cap (never reset). */
  hardTimer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  timedOut: boolean;
  /** Which timer fired (drives the failure reason). */
  timeoutKind?: "idle" | "hard";
}

export class RunStore {
  private runs = new Map<string, Run>();
  private listeners = new Map<string, Set<Listener>>();
  private active = new Map<string, Active>();
  private config: DaemonConfig;
  private sink: RunSink;

  constructor(config: DaemonConfig, sink: RunSink = nullSink) {
    this.config = config;
    this.sink = sink;
  }

  list(): Run[] {
    return [...this.runs.values()].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    );
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  /** True while the run is still executing (a child process is live). */
  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** Subscribe to a run's live events. Returns an unsubscribe fn. */
  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private emit(run: Run, event: RunEvent): void {
    run.events.push(event);
    this.sink.runEvent(run.id, event);
    const set = this.listeners.get(run.id);
    if (set) for (const l of set) l(event);
  }

  /** Create a run and spawn the claude process. Returns the run id immediately. */
  start(input: StartRunInput): Run {
    const id = randomUUID();
    const now = new Date().toISOString();
    const run: Run = {
      id,
      prompt: input.prompt,
      cwd: input.cwd ?? this.config.defaultCwd,
      status: "pending",
      startedAt: now,
      events: [],
    };
    this.runs.set(id, run);
    this.sink.runStarted(run);
    this.spawnClaude(run);
    return run;
  }

  /**
   * Request cancellation of a running run. Kills the child process; the `close`
   * handler then records the cancellation and marks the run failed. Returns true
   * if a live run was signalled, false if the run is unknown or already finished.
   */
  cancel(id: string): boolean {
    const a = this.active.get(id);
    if (!a) return false;
    a.cancelled = true;
    a.child.kill("SIGTERM");
    return true;
  }

  private setStatus(run: Run, status: Run["status"]): void {
    run.status = status;
    this.emit(run, { type: "status", status, at: new Date().toISOString() });
  }

  private spawnClaude(run: Run): void {
    const args = [
      "-p",
      run.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.config.extraArgs,
    ];

    let child: ChildProcess;
    try {
      child = spawn(this.config.claudeBin, args, {
        cwd: run.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.emit(run, {
        type: "error",
        at: new Date().toISOString(),
        message: `spawn failed: ${(err as Error).message}`,
      });
      this.setStatus(run, "failed");
      return;
    }

    const entry: Active = { child, cancelled: false, timedOut: false };
    this.active.set(run.id, entry);

    // Idle watchdog: kill a run only after it goes SILENT for idleTimeoutMs. Reset on
    // every stream chunk (see armIdle() calls below) so a working agent is never killed
    // mid-progress — only a hung `claude` trips it. (0/negative = disabled.)
    const armIdle = (): void => {
      if (this.config.idleTimeoutMs <= 0) return;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        entry.timedOut = true;
        entry.timeoutKind = "idle";
        child.kill("SIGTERM");
      }, this.config.idleTimeoutMs);
    };
    // Hard wall-clock cap (safety net): NEVER reset (0/negative = disabled).
    if (this.config.runTimeoutMs > 0) {
      entry.hardTimer = setTimeout(() => {
        entry.timedOut = true;
        entry.timeoutKind = "hard";
        child.kill("SIGTERM");
      }, this.config.runTimeoutMs);
    }
    armIdle();

    this.setStatus(run, "running");

    // Parse stdout as newline-delimited JSON (stream-json = one object per line).
    let stdoutBuf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      armIdle(); // progress: reset the idle watchdog
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) this.handleStdoutLine(run, line);
      }
    });

    let stderrBuf = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      armIdle(); // progress: reset the idle watchdog
      stderrBuf += chunk;
      let nl: number;
      while ((nl = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        this.emit(run, { type: "stderr", at: new Date().toISOString(), line });
      }
    });

    child.on("error", (err) => {
      this.emit(run, {
        type: "error",
        at: new Date().toISOString(),
        message: err.message,
      });
    });

    child.on("close", (code) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.hardTimer) clearTimeout(entry.hardTimer);
      this.active.delete(run.id);
      if (stdoutBuf.trim()) this.handleStdoutLine(run, stdoutBuf.trim());
      if (stderrBuf) {
        this.emit(run, {
          type: "stderr",
          at: new Date().toISOString(),
          line: stderrBuf,
        });
      }
      // Surface WHY a killed run ended before the terminal status.
      if (entry.timedOut) {
        const hard = entry.timeoutKind === "hard";
        const ms = hard ? this.config.runTimeoutMs : this.config.idleTimeoutMs;
        const mins = Math.round(ms / 60_000);
        this.emit(run, {
          type: "error",
          at: new Date().toISOString(),
          message: hard
            ? `run hard-timed out after ${mins}m`
            : `run timed out after ${mins}m (idle)`,
        });
      } else if (entry.cancelled) {
        this.emit(run, {
          type: "error",
          at: new Date().toISOString(),
          message: "run cancelled by operator",
        });
      }
      run.exitCode = code;
      run.endedAt = new Date().toISOString();
      this.emit(run, { type: "exit", at: run.endedAt, code });
      // A killed run (cancel/timeout) is a failure regardless of the reported code.
      const ok = code === 0 && !entry.cancelled && !entry.timedOut;
      this.setStatus(run, ok ? "succeeded" : "failed");
    });
  }

  private handleStdoutLine(run: Run, line: string): void {
    const at = new Date().toISOString();
    try {
      const data: unknown = JSON.parse(line);
      this.emit(run, { type: "claude", at, data });
    } catch {
      this.emit(run, { type: "stdout", at, line });
    }
  }
}
