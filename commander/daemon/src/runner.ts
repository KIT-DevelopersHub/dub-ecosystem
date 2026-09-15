// Run store + claude spawner. Each run spawns the local Claude Code CLI in
// headless mode (`claude -p <prompt> --output-format stream-json --verbose`),
// parses its line-delimited JSON stdout, and fans events out to SSE listeners.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DaemonConfig, Run, RunEvent, StartRunInput } from "./types.ts";

type Listener = (event: RunEvent) => void;

export class RunStore {
  private runs = new Map<string, Run>();
  private listeners = new Map<string, Set<Listener>>();
  private config: DaemonConfig;

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  list(): Run[] {
    return [...this.runs.values()].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    );
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
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
    this.spawnClaude(run);
    return run;
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

    let child;
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

    this.setStatus(run, "running");

    // Parse stdout as newline-delimited JSON (stream-json = one object per line).
    let stdoutBuf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) this.handleStdoutLine(run, line);
      }
    });

    let stderrBuf = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
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
      if (stdoutBuf.trim()) this.handleStdoutLine(run, stdoutBuf.trim());
      if (stderrBuf) {
        this.emit(run, {
          type: "stderr",
          at: new Date().toISOString(),
          line: stderrBuf,
        });
      }
      run.exitCode = code;
      run.endedAt = new Date().toISOString();
      this.emit(run, { type: "exit", at: run.endedAt, code });
      this.setStatus(run, code === 0 ? "succeeded" : "failed");
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
