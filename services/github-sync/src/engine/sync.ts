// Sync engine — the only place that decides how a change on one side is written to
// the other. I/O goes through injected ports so it is fully unit-testable.
import { DubError, isDubError } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { DubEventContext } from "@dub/events";
import type { task } from "@dub/types";
import type {
  GithubRepoConfig,
  IssueSnapshot,
  LinkRecord,
  SyncOrigin,
  SyncRunStats,
  TaskSnapshot,
} from "../domain/types";
import { emptyStats } from "../domain/types";
import {
  diffTaskVsIssue,
  divergedFieldNames,
  hasAnyDiff,
  issueLabelsForStatus,
  matchesLabelFilter,
  statusToState,
  stateToStatus,
} from "../domain/mapping";
import { githubMoved, taskMoved } from "../domain/conflict";
import { isSelfCausedEvent, isSelfCausedWebhook } from "../domain/echo";
import type { Stores } from "../store/types";
import type { GithubApiClient } from "../clients/github";
import type { TaskServiceClient } from "../clients/task";
import type { IdentityUserClient } from "../clients/identity";
import type { Publisher } from "../events/publisher";
import type { ParsedIssueEvent } from "./parse";

export interface EngineConfig {
  selfLogins: readonly string[]; // our App/bot login(s) for webhook echo suppression
  originDefault: SyncOrigin;
}

export interface EngineDeps {
  stores: Stores;
  github: GithubApiClient;
  tasks: TaskServiceClient;
  identity: IdentityUserClient;
  publisher: Publisher;
  config: EngineConfig;
  newId: (prefix: string) => string;
  now: () => string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const PERMANENT_TASK_ORIGIN_READONLY = "TASK_GITHUB_ORIGIN_READONLY";

export type ApplyResult = "created" | "updated" | "skipped" | "conflict" | "failed";

export class SyncEngine {
  constructor(private readonly d: EngineDeps) {}

  private sysCtx(requestId: string): RequestContext {
    return { requestId }; // no userId -> system origin; caller header added by @dub/http
  }
  private evtCtx(requestId: string): DubEventContext {
    return { requestId, actorId: null };
  }

  // ---------- GitHub -> internal (webhook path) ----------

  async applyWebhook(requestId: string, ev: ParsedIssueEvent): Promise<ApplyResult> {
    const repo = await this.d.stores.repos.getByOwnerRepo(ev.issue.owner, ev.issue.repo);
    if (!repo || !repo.enabled) return "skipped";
    if (isSelfCausedWebhook(ev.senderLogin, this.d.config.selfLogins)) return "skipped";
    if (repo.direction === "internal_to_github") return "skipped"; // GitHub is not a source here

    const existing = await this.d.stores.links.getByIssue(repo.id, ev.issue.number);
    if (!existing) {
      if (!matchesLabelFilter(ev.issue.labels, repo.labelFilter)) return "skipped";
      return this.importIssueAsTask(requestId, repo, ev.issue);
    }
    return this.reconcileIssueChange(requestId, repo, existing, ev.issue);
  }

  private async importIssueAsTask(
    requestId: string,
    repo: GithubRepoConfig,
    issue: IssueSnapshot,
  ): Promise<ApplyResult> {
    const ctx = this.sysCtx(requestId);
    const assigneeId = await this.resolveAssignee(ctx, issue.assignees);
    const createReq: task.CreateTaskRequest = {
      eventId: repo.eventId,
      title: issue.title,
      origin: "github",
      ...(issue.body ? { description: issue.body } : {}),
      ...(assigneeId ? { assigneeId } : {}),
    };
    const created = await this.d.tasks.createTask(ctx, createReq);
    const link: LinkRecord = {
      id: this.d.newId("ghl"),
      taskId: created.id,
      repoId: repo.id,
      owner: issue.owner,
      repo: issue.repo,
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      projectItemId: null,
      syncState: "in_sync",
      lastSyncedAt: this.d.now(),
      lastGithubUpdatedAt: issue.updatedAt,
      lastTaskVersion: created.version,
      lastError: null,
      createdAt: this.d.now(),
      updatedAt: this.d.now(),
    };
    await this.d.stores.links.create(link);
    await this.d.publisher.linkCreated(this.evtCtx(requestId), created.id, `${issue.owner}/${issue.repo}`);
    return "created";
  }

  private async reconcileIssueChange(
    requestId: string,
    repo: GithubRepoConfig,
    link: LinkRecord,
    issue: IssueSnapshot,
  ): Promise<ApplyResult> {
    const ctx = this.sysCtx(requestId);
    let current: task.Task;
    try {
      current = await this.d.tasks.getTask(ctx, link.taskId);
    } catch (err) {
      return this.markLinkError(link, err, "getTask");
    }

    const ghChanged = githubMoved(link, issue.updatedAt);
    const tChanged = taskMoved(link, current.version);

    if (ghChanged && tChanged) {
      // Both sides moved -> conflict, resolved by the repo's origin.
      const winner: SyncOrigin = repo.origin;
      const diff = diffTaskVsIssue(this.taskSnapshot(current), issue);
      await this.d.publisher.conflictDetected(this.evtCtx(requestId), link.taskId);
      if (winner === "internal") {
        // internal wins: overwrite the issue from the task, keep task as-is.
        try {
          const pushed = await this.pushTaskToIssue(current, issue);
          await this.d.stores.links.update(link.id, {
            syncState: "in_sync",
            lastGithubUpdatedAt: pushed.updatedAt,
            lastTaskVersion: current.version,
            lastSyncedAt: this.d.now(),
            lastError: null,
            updatedAt: this.d.now(),
          });
        } catch (err) {
          return this.markLinkError(link, err, "pushTaskToIssue");
        }
        this.d.log?.("conflict resolved (internal wins)", { taskId: link.taskId, diverged: divergedFieldNames(diff) });
        return "conflict";
      }
      // github wins: fall through to overwrite the task from the issue.
    }

    // github -> internal write.
    try {
      const patched = await this.patchTaskFromIssue(ctx, current, issue);
      await this.d.stores.links.update(link.id, {
        syncState: "in_sync",
        lastGithubUpdatedAt: issue.updatedAt,
        lastTaskVersion: patched.version,
        lastSyncedAt: this.d.now(),
        lastError: null,
        updatedAt: this.d.now(),
      });
      return ghChanged && tChanged ? "conflict" : "updated";
    } catch (err) {
      return this.markLinkError(link, err, "patchTaskFromIssue");
    }
  }

  private async patchTaskFromIssue(
    ctx: RequestContext,
    current: task.Task,
    issue: IssueSnapshot,
  ): Promise<task.Task> {
    const status = stateToStatus(issue.state, issue.labels);
    const assigneeId = await this.resolveAssignee(ctx, issue.assignees);
    const req: task.UpdateTaskRequest = {
      version: current.version,
      title: issue.title,
      description: issue.body,
      ...(status !== current.status ? { status } : {}),
      ...(assigneeId !== null ? { assigneeId } : {}),
    };
    return this.d.tasks.updateTask(ctx, current.id, req);
  }

  // ---------- internal -> GitHub (domain-event path) ----------

  async applyTaskUpsert(
    requestId: string,
    actorId: string | null,
    taskId: string,
  ): Promise<ApplyResult> {
    if (isSelfCausedEvent(actorId)) return "skipped";
    const link = await this.d.stores.links.getByTaskId(taskId);
    if (!link) return "skipped";
    const repo = await this.d.stores.repos.get(link.repoId);
    if (!repo || !repo.enabled) return "skipped";
    if (repo.direction === "github_to_internal") return "skipped"; // internal is not a source here

    const ctx = this.sysCtx(requestId);
    let current: task.Task;
    try {
      current = await this.d.tasks.getTask(ctx, taskId);
    } catch (err) {
      return this.markLinkError(link, err, "getTask");
    }

    let issue: IssueSnapshot | null;
    try {
      issue = await this.d.github.getIssue(link.owner, link.repo, link.issueNumber);
    } catch (err) {
      return this.markLinkError(link, err, "getIssue");
    }
    if (!issue) return this.markLinkError(link, new DubError("GITHUB_REPO_NOT_FOUND", "issue vanished", { status: 404 }), "getIssue");

    const ghChanged = githubMoved(link, issue.updatedAt);
    const tChanged = taskMoved(link, current.version);
    if (ghChanged && tChanged && repo.origin === "github") {
      // conflict, github wins: pull issue into task instead of pushing.
      await this.d.publisher.conflictDetected(this.evtCtx(requestId), taskId);
      try {
        const patched = await this.patchTaskFromIssue(ctx, current, issue);
        await this.d.stores.links.update(link.id, {
          syncState: "in_sync",
          lastGithubUpdatedAt: issue.updatedAt,
          lastTaskVersion: patched.version,
          lastSyncedAt: this.d.now(),
          lastError: null,
          updatedAt: this.d.now(),
        });
      } catch (err) {
        return this.markLinkError(link, err, "patchTaskFromIssue");
      }
      return "conflict";
    }

    const snap = this.taskSnapshot(current);
    const diff = diffTaskVsIssue(snap, issue);
    if (!hasAnyDiff(diff) && !ghChanged) {
      await this.d.stores.links.update(link.id, { lastTaskVersion: current.version, updatedAt: this.d.now() });
      return "skipped";
    }

    try {
      const pushed = await this.pushTaskToIssue(current, issue);
      const conflicted = ghChanged && tChanged;
      if (conflicted) await this.d.publisher.conflictDetected(this.evtCtx(requestId), taskId);
      await this.d.stores.links.update(link.id, {
        syncState: "in_sync",
        lastGithubUpdatedAt: pushed.updatedAt,
        lastTaskVersion: current.version,
        lastSyncedAt: this.d.now(),
        lastError: null,
        updatedAt: this.d.now(),
      });
      return conflicted ? "conflict" : "updated";
    } catch (err) {
      return this.markLinkError(link, err, "pushTaskToIssue");
    }
  }

  async applyTaskArchived(requestId: string, actorId: string | null, taskId: string): Promise<ApplyResult> {
    if (isSelfCausedEvent(actorId)) return "skipped";
    const link = await this.d.stores.links.getByTaskId(taskId);
    if (!link) return "skipped";
    const repo = await this.d.stores.repos.get(link.repoId);
    if (!repo || repo.direction === "github_to_internal") return "skipped";
    try {
      await this.d.github.addComment(link.owner, link.repo, link.issueNumber, "Linked task archived in DevHub; closing issue.");
      await this.d.github.updateIssue({ owner: link.owner, repo: link.repo, number: link.issueNumber, state: "closed" });
      await this.d.stores.links.update(link.id, { syncState: "pending", updatedAt: this.d.now() });
      return "updated";
    } catch (err) {
      return this.markLinkError(link, err, "archive");
    }
  }

  /** event.archived: disable the repo config, keep links. */
  async applyEventArchived(eventId: string): Promise<number> {
    let disabled = 0;
    let cursor: string | null = null;
    do {
      const page = await this.d.stores.repos.list({ eventId, enabled: true }, cursor, 200);
      for (const repo of page.items) {
        await this.d.stores.repos.update(repo.id, { enabled: false, updatedAt: this.d.now() });
        disabled++;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return disabled;
  }

  // ---------- reconciliation (POST /sync + cron) ----------

  async reconcileRepo(requestId: string, repo: GithubRepoConfig): Promise<SyncRunStats> {
    const stats = emptyStats();
    if (!repo.enabled) return stats;
    const ctx = this.sysCtx(requestId);
    let issues: IssueSnapshot[];
    try {
      issues = await this.d.github.listIssues(repo.owner, repo.repo, null);
    } catch (err) {
      stats.failed++;
      throw this.wrapReconcileError(err, stats);
    }
    for (const issue of issues) {
      try {
        const link = await this.d.stores.links.getByIssue(repo.id, issue.number);
        if (!link) {
          if (!matchesLabelFilter(issue.labels, repo.labelFilter)) {
            stats.skipped++;
            continue;
          }
          if (repo.direction === "internal_to_github") {
            stats.skipped++;
            continue;
          }
          const r = await this.importIssueAsTask(requestId, repo, issue);
          bump(stats, r);
          continue;
        }
        const current = await this.d.tasks.getTask(ctx, link.taskId);
        const diff = diffTaskVsIssue(this.taskSnapshot(current), issue);
        const gh = githubMoved(link, issue.updatedAt);
        if (!hasAnyDiff(diff) && !gh) {
          stats.skipped++;
          continue;
        }
        const r = await this.reconcileIssueChange(requestId, repo, link, issue);
        bump(stats, r);
      } catch (err) {
        if (isRateLimited(err)) throw this.wrapReconcileError(err, stats);
        stats.failed++;
      }
    }
    return stats;
  }

  // ---------- helpers ----------

  private taskSnapshot(t: task.Task): TaskSnapshot {
    return {
      id: t.id,
      eventId: t.eventId,
      title: t.title,
      description: t.description,
      status: t.status,
      assigneeId: t.assigneeId,
      version: t.version,
      updatedAt: t.updatedAt,
    };
  }

  private async pushTaskToIssue(current: task.Task, issue: IssueSnapshot): Promise<IssueSnapshot> {
    const assignees = await this.assigneesForTask(current);
    return this.d.github.updateIssue({
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
      title: current.title,
      body: current.description,
      state: statusToState(current.status),
      labels: issueLabelsForStatus(current.status, issue.labels),
      ...(assignees !== null ? { assignees } : {}),
    });
  }

  private async assigneesForTask(t: task.Task): Promise<string[] | null> {
    if (!t.assigneeId) return [];
    const login = await this.d.identity.githubLoginOf(this.sysCtx(this.d.now()), t.assigneeId).catch(() => null);
    // No githubLogin -> skip assignee mapping (do not error), leave issue assignees untouched.
    return login ? [login] : null;
  }

  private async resolveAssignee(ctx: RequestContext, assignees: string[]): Promise<string | null> {
    const first = assignees[0];
    if (!first) return null;
    try {
      return await this.d.identity.userIdByGithubLogin(ctx, first);
    } catch {
      return null;
    }
  }

  private async markLinkError(link: LinkRecord, err: unknown, op: string): Promise<ApplyResult> {
    const permanent = isDubError(err) && err.code === PERMANENT_TASK_ORIGIN_READONLY;
    const code = codeOf(err);
    await this.d.stores.links.update(link.id, {
      syncState: "error",
      lastError: `${op}: ${code ? code + " " : ""}${errMsg(err)}`,
      updatedAt: this.d.now(),
    });
    this.d.log?.("link sync error", { linkId: link.id, op, permanent, code: codeOf(err) });
    if (!permanent && isRetryable(err)) throw err instanceof Error ? err : new Error(String(err));
    // Permanent (422 origin-readonly) or non-retryable: swallow so the queue acks.
    return "failed";
  }

  private wrapReconcileError(err: unknown, _stats: SyncRunStats): Error {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function bump(stats: SyncRunStats, r: ApplyResult): void {
  if (r === "created") stats.created++;
  else if (r === "updated") stats.updated++;
  else if (r === "skipped") stats.skipped++;
  else if (r === "conflict") stats.conflicts++;
  else if (r === "failed") stats.failed++;
}

function isRateLimited(err: unknown): boolean {
  return isDubError(err) && (err.code === "RATE_LIMITED" || err.code === "GITHUB_RATE_LIMITED" || err.status === 429);
}
function isRetryable(err: unknown): boolean {
  if (isDubError(err)) return err.retryable;
  return true; // unknown throws are retried
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function codeOf(err: unknown): string | undefined {
  return isDubError(err) ? err.code : undefined;
}
