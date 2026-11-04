// Per-task isolation (own worktree + own Claude session per task). Regression for tasks
// mixing up: every task used to run in one shared cwd and follow-ups re-sent the prior
// prompt with no memory of the agent's answers. git / pnpm are mocked (no real worktrees).
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/server.ts";
import type { RunStore } from "../src/runner.ts";
import type { DaemonConfig, RunEvent } from "../src/types.ts";
import {
  LEGACY_FOLLOWUP_MARKER,
  TaskWorkspaces,
  stripStackedPrompt,
  taskPrompt,
  taskSessionId,
  taskWorktreePath,
  type ExecResult,
  type WorkspaceDeps,
} from "../src/workspace.ts";

const ARGS_ECHO = fileURLToPath(new URL("./fixtures/args-echo-claude", import.meta.url));
const SLOW_CLAUDE = fileURLToPath(new URL("./fixtures/slow-claude", import.meta.url));

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

/** Fake git: `worktree add` creates the directory (+ .git marker) under a temp root. */
function fakeDeps(opts: { failAdd?: boolean; branchExists?: boolean; setupFails?: boolean } = {}) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const dirs = new Set<string>();
  const sessions = new Set<string>();
  const deps: WorkspaceDeps = {
    async exec(cmd, args, cwd) {
      calls.push({ cmd, args, cwd });
      if (cmd === "sh") return opts.setupFails ? { code: 1, stdout: "", stderr: "pnpm boom" } : ok;
      const sub = args.slice(2); // drop "-C <repo>"
      if (sub[0] === "rev-parse") return opts.branchExists ? ok : { code: 1, stdout: "", stderr: "" };
      if (sub[0] === "worktree" && sub[1] === "add") {
        if (opts.failAdd) return { code: 128, stdout: "", stderr: "fatal: nope" };
        const path = sub.find((a) => a.startsWith("/") && a.includes("task-"))!;
        mkdirSync(path, { recursive: true });
        dirs.add(path);
        dirs.add(join(path, ".git"));
        return ok;
      }
      return ok;
    },
    exists: (p) => dirs.has(p),
    sessionExists: (id) => sessions.has(id),
  };
  return { deps, calls, dirs, sessions };
}

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  root = mkdtempSync(join(tmpdir(), "commander-ws-"));
  return root;
}

describe("taskSessionId / taskWorktreePath", () => {
  it("is a stable, per-task UUID", () => {
    const a = taskSessionId("ctask_a");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(taskSessionId("ctask_a")).toBe(a);
    expect(taskSessionId("ctask_b")).not.toBe(a);
  });

  it("gives each task its own directory and rejects path tricks", () => {
    expect(taskWorktreePath("/w", "ctask_a")).toBe("/w/task-ctask_a");
    expect(taskWorktreePath("/w", "../../etc")).toBe("/w/task-etc");
    expect(() => taskWorktreePath("/w", "../..")).toThrow();
  });
});

describe("TaskWorkspaces.resolve", () => {
  const cfg = (r: string) => ({ repoRoot: "/repo", worktreeRoot: r, baseRef: "origin/main", claudeConfigDir: "" });

  it("creates the task worktree once from origin/main, then reuses it", async () => {
    const r = newRoot();
    const { deps, calls } = fakeDeps();
    const ws = new TaskWorkspaces(cfg(r), deps);

    const first = await ws.resolve("t1");
    expect(first).toMatchObject({ cwd: join(r, "task-t1"), created: true, resume: false });
    const add = calls.find((c) => c.args.includes("add"))!;
    expect(add.args).toEqual(["-C", "/repo", "worktree", "add", "-b", "commander/task-t1", join(r, "task-t1"), "origin/main"]);

    const before = calls.length;
    const second = await ws.resolve("t1");
    expect(second).toMatchObject({ cwd: join(r, "task-t1"), created: false });
    expect(calls.length).toBe(before); // no git work on reuse
  });

  it("resumes only when the task's transcript exists", async () => {
    const r = newRoot();
    const { deps, sessions } = fakeDeps();
    const ws = new TaskWorkspaces(cfg(r), deps);
    await ws.resolve("t1");
    expect((await ws.resolve("t1")).resume).toBe(false);
    sessions.add(taskSessionId("t1"));
    expect((await ws.resolve("t1")).resume).toBe(true);
    expect((await ws.resolve("t2")).resume).toBe(false);
  });

  it("serialises concurrent resolves of one task (single worktree add)", async () => {
    const r = newRoot();
    const { deps, calls } = fakeDeps();
    const ws = new TaskWorkspaces(cfg(r), deps);
    const [a, b] = await Promise.all([ws.resolve("t1"), ws.resolve("t1")]);
    expect(calls.filter((c) => c.args.includes("add")).length).toBe(1);
    expect(a.cwd).toBe(b.cwd);
  });

  it("checks out an existing task branch instead of recreating it", async () => {
    const r = newRoot();
    const { deps, calls } = fakeDeps({ branchExists: true });
    await new TaskWorkspaces(cfg(r), deps).resolve("t1");
    const add = calls.find((c) => c.args.includes("add"))!;
    expect(add.args.slice(2)).toEqual(["worktree", "add", join(r, "task-t1"), "commander/task-t1"]);
  });

  it("fails (never falls back to a shared cwd) when the worktree cannot be created", async () => {
    const r = newRoot();
    const { deps } = fakeDeps({ failAdd: true });
    await expect(new TaskWorkspaces(cfg(r), deps).resolve("t1")).rejects.toThrow(/git worktree add failed/);
  });

  it("refuses a non-git directory squatting on the task path", async () => {
    const r = newRoot();
    const { deps, dirs } = fakeDeps();
    dirs.add(join(r, "task-t1"));
    await expect(new TaskWorkspaces(cfg(r), deps).resolve("t1")).rejects.toThrow(/not a git worktree/);
  });

  it("runs the optional setup command (mocked) and reports its failure as a note", async () => {
    const r = newRoot();
    const { deps, calls } = fakeDeps({ setupFails: true });
    const out = await new TaskWorkspaces({ ...cfg(r), setupCommand: "pnpm install --offline" }, deps).resolve("t1");
    expect(calls.find((c) => c.cmd === "sh")).toMatchObject({ args: ["-c", "pnpm install --offline"], cwd: join(r, "task-t1") });
    expect(out.notes.join("\n")).toMatch(/setup failed/);
  });
});

describe("taskPrompt", () => {
  const base = { taskId: "t1", cwd: "/w/task-t1", sessionId: "s", created: false, notes: [] };

  it("a new session carries the task context and its own cwd", () => {
    const p = taskPrompt({ ...base, resume: false }, "作って", "[このタスク]\nタイトル: X");
    expect(p).toContain("/w/task-t1");
    expect(p).toContain("タイトル: X");
    expect(p.endsWith("作って")).toBe(true);
  });

  it("a resumed session gets only the newest instruction (old stacked prompts are cut)", () => {
    const stacked = `元の依頼${LEGACY_FOLLOWUP_MARKER}一回目${LEGACY_FOLLOWUP_MARKER}二回目`;
    expect(stripStackedPrompt(stacked)).toBe("二回目");
    const p = taskPrompt({ ...base, resume: true }, stacked, "[このタスク]");
    expect(p).not.toContain("元の依頼");
    expect(p).not.toContain("[このタスク]");
    expect(p.endsWith("二回目")).toBe(true);
  });
});

// ── HTTP: the daemon wires each task to its own worktree + session ──────────────────
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (close) await close();
  close = null;
});

function config(r: string, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    claudeBin: ARGS_ECHO,
    defaultCwd: tmpdir(),
    extraArgs: [],
    operatorToken: "",
    idleTimeoutMs: 0,
    runTimeoutMs: 0,
    isolateEnv: false,
    claudeConfigDir: "",
    permissionMode: "",
    taskWorkspaces: { repoRoot: "/repo", worktreeRoot: r, baseRef: "origin/main" },
    ...overrides,
  };
}

async function listen(cfg: DaemonConfig, deps: WorkspaceDeps): Promise<{ base: string; store: RunStore }> {
  const { server, store } = createDaemonServer(cfg, undefined, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { base: `http://127.0.0.1:${port}`, store };
}

async function post(base: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function done(store: RunStore, id: string): Promise<void> {
  const run = store.get(id)!;
  if (run.status === "succeeded" || run.status === "failed") return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = store.subscribe(id, (ev: RunEvent) => {
      if (ev.type === "status" && (ev.status === "succeeded" || ev.status === "failed")) {
        unsub();
        resolve();
      }
    });
  });
}

/** argv the fake claude saw. */
function argv(store: RunStore, id: string): string[] {
  const ev = store.get(id)!.events.find((e) => e.type === "claude") as { data: { result: string } };
  return JSON.parse(ev.data.result) as string[];
}

describe("daemon HTTP — per-task worktree + session", () => {
  it("two tasks never share a cwd or a session", async () => {
    const r = newRoot();
    const { deps } = fakeDeps();
    const { base, store } = await listen(config(r), deps);

    const a = await post(base, { prompt: "Aを作って", taskId: "ta", cwd: "/shared/commander-local" });
    const b = await post(base, { prompt: "Bを作って", taskId: "tb", cwd: "/shared/commander-local" });
    await done(store, a.json.runId as string);
    await done(store, b.json.runId as string);

    const ra = store.get(a.json.runId as string)!;
    const rb = store.get(b.json.runId as string)!;
    expect(ra.cwd).toBe(join(r, "task-ta"));
    expect(rb.cwd).toBe(join(r, "task-tb"));
    expect(ra.sessionId).toBe(taskSessionId("ta"));
    expect(rb.sessionId).toBe(taskSessionId("tb"));
    expect(argv(store, ra.id)).toEqual(expect.arrayContaining(["--session-id", taskSessionId("ta")]));
    expect(argv(store, rb.id)).toEqual(expect.arrayContaining(["--session-id", taskSessionId("tb")]));
    // the requested shared cwd was ignored, and the log says so
    expect(ra.events.some((e) => e.type === "stderr" && e.line.includes("ignored"))).toBe(true);
  });

  it("a follow-up resumes the SAME task's session with only the new instruction", async () => {
    const r = newRoot();
    const { deps, sessions } = fakeDeps();
    const { base, store } = await listen(config(r), deps);

    const first = await post(base, { prompt: "チャットを直して", taskId: "chat", taskContext: "[このタスク]\nタイトル: チャット" });
    await done(store, first.json.runId as string);
    const firstArgs = argv(store, first.json.runId as string);
    expect(firstArgs.find((a) => a.includes("タイトル: チャット"))).toBeTruthy();
    sessions.add(taskSessionId("chat")); // claude wrote the transcript

    const stacked = `チャットを直して${LEGACY_FOLLOWUP_MARKER}public/private は英字で`;
    const next = await post(base, { prompt: stacked, taskId: "chat", taskContext: "[このタスク]\nタイトル: チャット" });
    await done(store, next.json.runId as string);
    const args = argv(store, next.json.runId as string);
    expect(args).toEqual(expect.arrayContaining(["--resume", taskSessionId("chat")]));
    expect(args).not.toContain("--session-id");
    const prompt = args[args.indexOf("-p") + 1]!;
    expect(prompt.endsWith("public/private は英字で")).toBe(true);
    expect(prompt).not.toContain("チャットを直して");
    expect(prompt).not.toContain("タイトル: チャット");
    expect(store.get(next.json.runId as string)!.cwd).toBe(join(r, "task-chat"));
  });

  it("refuses a second concurrent run of the same task (409) but not of another task", async () => {
    const r = newRoot();
    const { deps } = fakeDeps();
    const { base, store } = await listen(config(r, { claudeBin: SLOW_CLAUDE }), deps);

    const a = await post(base, { prompt: "x", taskId: "t1" });
    expect(a.status).toBe(201);
    const again = await post(base, { prompt: "y", taskId: "t1" });
    expect(again).toMatchObject({ status: 409, json: { error: "task_run_active" } });
    const other = await post(base, { prompt: "z", taskId: "t2" });
    expect(other.status).toBe(201);
    store.cancel(a.json.runId as string);
    store.cancel(other.json.runId as string);
    await done(store, a.json.runId as string);
    await done(store, other.json.runId as string);
  });

  it("records a failed run (no shared-cwd fallback) when the task worktree cannot be made", async () => {
    const r = newRoot();
    const { deps } = fakeDeps({ failAdd: true });
    const { base, store } = await listen(config(r), deps);
    const res = await post(base, { prompt: "x", taskId: "t1", cwd: "/shared" });
    expect(res.status).toBe(201);
    const run = store.get(res.json.runId as string)!;
    expect(run.status).toBe("failed");
    expect(run.events.some((e) => e.type === "error" && e.message.includes("task workspace unavailable"))).toBe(true);
  });

  it("leaves task-less runs (Dubに聞く / bundles) on their requested cwd without a session", async () => {
    const r = newRoot();
    const { deps } = fakeDeps();
    const { base, store } = await listen(config(r), deps);
    const res = await post(base, { prompt: "質問", cwd: tmpdir() });
    await done(store, res.json.runId as string);
    const run = store.get(res.json.runId as string)!;
    expect(run.cwd).toBe(tmpdir());
    expect(run.sessionId).toBeUndefined();
    const args = argv(store, run.id);
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });
});
