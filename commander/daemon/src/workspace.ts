// Per-task isolation: every board task gets its OWN Claude session and its OWN git
// worktree, so one task's conversation, branch and files never leak into another's.
//
// Before this, every task ran in whichever cwd the composer pre-filled (the previous
// task's) and follow-ups re-sent the prior prompt with no memory of the agent's answers.
// Dozens of tasks shared one worktree and the agent guessed "this task" from that
// worktree's branch — which belonged to some other task.
//
// Design (stateless, so a daemon restart from another checkout keeps working):
// - session id = UUID derived from the task id. First run: `--session-id <id>`; later
//   runs: `--resume <id>` (detected by the transcript file Claude Code writes).
// - worktree   = <worktreeRoot>/task-<id>, created lazily from origin/main on the first
//   run and reused afterwards. A task never runs in another task's (or a shared) cwd.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface WorkspaceDeps {
  exec(cmd: string, args: string[], cwd: string): Promise<ExecResult>;
  exists(path: string): boolean;
  /** True when Claude Code already has a transcript for this session id. */
  sessionExists(sessionId: string): boolean;
}

export interface WorkspaceConfig {
  /** Git checkout new task worktrees are added from (shares its object store). */
  repoRoot: string;
  /** Parent directory of the per-task worktrees (task-<id>). */
  worktreeRoot: string;
  /** Ref a new task worktree starts from. */
  baseRef: string;
  /** Optional shell command run once in a freshly created worktree (e.g. pnpm install). */
  setupCommand?: string;
  /** Claude config home (where projects/<dir>/<session>.jsonl transcripts live). */
  claudeConfigDir: string;
}

export interface TaskWorkspace {
  taskId: string;
  cwd: string;
  sessionId: string;
  /** true = continue the task's existing conversation (`--resume`). */
  resume: boolean;
  /** true = the worktree was created by this call. */
  created: boolean;
  /** Non-fatal notes (e.g. setup command failed) surfaced on the run log. */
  notes: string[];
}

/** Deterministic UUID (v4 layout) for a task's Claude session. */
export function taskSessionId(taskId: string): string {
  const h = createHash("sha256").update(`commander-task:${taskId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function safeTaskId(taskId: string): string {
  const s = taskId.replace(/[^A-Za-z0-9_-]/g, "");
  if (s === "") throw new Error(`invalid task id: ${JSON.stringify(taskId)}`);
  return s;
}

export function taskWorktreePath(worktreeRoot: string, taskId: string): string {
  return join(worktreeRoot, `task-${safeTaskId(taskId)}`);
}

export function taskBranch(taskId: string): string {
  return `commander/task-${safeTaskId(taskId)}`;
}

/** Marker the pre-isolation web used to stack the previous prompt onto a follow-up. */
export const LEGACY_FOLLOWUP_MARKER = "\n\n---\n[前回の実行へのフィードバック / 追加指示]\n";

/**
 * On a resumed session the conversation already holds the earlier turns, so a prompt an
 * older web build stacked (prior prompt + marker + addition) is cut down to the newest
 * addition. Prompts without the marker pass through untouched.
 */
export function stripStackedPrompt(prompt: string): string {
  const i = prompt.lastIndexOf(LEGACY_FOLLOWUP_MARKER);
  return i === -1 ? prompt : prompt.slice(i + LEGACY_FOLLOWUP_MARKER.length);
}

/** The prompt actually sent to claude for a task run. */
export function taskPrompt(ws: TaskWorkspace, prompt: string, taskContext?: string): string {
  if (ws.resume) {
    return (
      `[commander] 同じタスク (taskId: ${ws.taskId}) の続きです。作業ディレクトリ: ${ws.cwd}\n\n` +
      stripStackedPrompt(prompt)
    );
  }
  const head =
    `[commander] このタスク (taskId: ${ws.taskId}) 専用の作業ディレクトリ: ${ws.cwd}\n` +
    "他のタスクの worktree・ブランチに cd / checkout しない。PR は作業ディレクトリのブランチから推測しない。" +
    "依存が必要ならこのディレクトリで pnpm install する。" +
    "このタスクの PR ブランチが別の worktree で使用中なら `git switch --detach origin/<branch>` で取り込み、" +
    "`git push origin HEAD:<branch>` で更新する。";
  const ctx = taskContext?.trim() ? `\n\n${taskContext.trim()}` : "";
  return `${head}${ctx}\n\n---\n${prompt}`;
}

function defaultExec(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function transcriptExists(claudeConfigDir: string, sessionId: string): boolean {
  const projects = join(claudeConfigDir || join(homedir(), ".claude"), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false;
  }
  return dirs.some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}

export function defaultWorkspaceDeps(claudeConfigDir: string): WorkspaceDeps {
  return {
    exec: defaultExec,
    exists: existsSync,
    sessionExists: (id) => transcriptExists(claudeConfigDir, id),
  };
}

export class TaskWorkspaces {
  private config: WorkspaceConfig;
  private deps: WorkspaceDeps;
  /** Serialises resolve() per task so two quick clicks never race `git worktree add`. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(config: WorkspaceConfig, deps: WorkspaceDeps = defaultWorkspaceDeps(config.claudeConfigDir)) {
    this.config = config;
    this.deps = deps;
  }

  resolve(taskId: string): Promise<TaskWorkspace> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.resolveUnlocked(taskId));
    this.locks.set(taskId, next);
    void next.finally(() => {
      if (this.locks.get(taskId) === next) this.locks.delete(taskId);
    }).catch(() => {});
    return next;
  }

  private async git(args: string[]): Promise<ExecResult> {
    return this.deps.exec("git", ["-C", this.config.repoRoot, ...args], this.config.repoRoot);
  }

  private async resolveUnlocked(taskId: string): Promise<TaskWorkspace> {
    const cwd = taskWorktreePath(this.config.worktreeRoot, taskId);
    const sessionId = taskSessionId(taskId);
    const notes: string[] = [];
    let created = false;

    if (!this.deps.exists(join(cwd, ".git"))) {
      if (this.deps.exists(cwd)) {
        // Something non-git sits at our path: never run a task there.
        throw new Error(`task worktree path exists but is not a git worktree: ${cwd}`);
      }
      await this.git(["fetch", "--quiet", "origin", "main"]); // best effort (offline ok)
      const branch = taskBranch(taskId);
      const hasBranch = (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      let add = hasBranch
        ? await this.git(["worktree", "add", cwd, branch])
        : await this.git(["worktree", "add", "-b", branch, cwd, this.config.baseRef]);
      if (add.code !== 0) {
        // e.g. the branch is checked out elsewhere: still give the task its own dir.
        add = await this.git(["worktree", "add", "--detach", cwd, this.config.baseRef]);
      }
      if (add.code !== 0) {
        throw new Error(`git worktree add failed for ${cwd}: ${add.stderr.trim() || `exit ${add.code}`}`);
      }
      created = true;
      if (this.config.setupCommand?.trim()) {
        const setup = await this.deps.exec("sh", ["-c", this.config.setupCommand], cwd);
        if (setup.code !== 0) {
          notes.push(`worktree setup failed (exit ${setup.code}): ${setup.stderr.trim().slice(-500)}`);
        }
      }
      notes.push(`created task worktree ${cwd}`);
    }

    // A brand-new worktree means a brand-new conversation for that cwd, even if a stale
    // transcript exists (Claude Code keys transcripts by cwd, so resume would not find it).
    const resume = !created && this.deps.sessionExists(sessionId);
    return { taskId, cwd, sessionId, resume, created, notes };
  }
}
