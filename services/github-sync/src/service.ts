// Application service — route-facing operations (links, repos, sync runs).
// Thin orchestration over stores + engine + publisher; all validation/error
// mapping to @dub/errors lives here so the HTTP routes stay declarative.
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { githubSync } from "@dub/types";
import type {
  CreateLinkRequest,
  GithubRepoConfig,
  LinkRecord,
  RegisterRepoRequest,
  SyncOrigin,
  SyncRunRecord,
  SyncRunScope,
  UpdateRepoRequest,
} from "./domain/types";
import { emptyStats } from "./domain/types";
import type { Stores } from "./store/types";
import type { GithubApiClient } from "./clients/github";
import type { EventExistenceClient } from "./clients/event";
import type { Publisher } from "./events/publisher";
import { SyncEngine } from "./engine/sync";

export interface ServiceDeps {
  stores: Stores;
  github: GithubApiClient;
  events: EventExistenceClient;
  publisher: Publisher;
  engine: SyncEngine;
  newId: (prefix: string) => string;
  now: () => string;
  originDefault: SyncOrigin;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class GithubSyncService {
  constructor(private readonly d: ServiceDeps) {}

  // ---------- links ----------

  async listLinks(requestId: string, q: githubSync.ListLinksQuery): Promise<githubSync.ListLinksResponse> {
    const limit = clampLimit(q.limit);
    const filter: import("./store/types").LinkFilter = {};
    if (q.taskId) filter.taskId = q.taskId;
    if (q.repo) {
      const parts = q.repo.split("/");
      if (parts.length === 2) {
        filter.owner = parts[0];
        filter.repo = parts[1];
      } else {
        filter.repo = q.repo;
      }
    }
    const page = await this.d.stores.links.list(filter, q.cursor ?? null, limit);
    return { items: page.items.map(toPublicLink), nextCursor: page.nextCursor };
  }

  async createLink(requestId: string, req: CreateLinkRequest): Promise<githubSync.GithubLink> {
    if (!req.taskId) throw validation("taskId", "required");
    if (!OWNER_RE.test(req.owner)) throw validation("owner", "invalid");
    if (!REPO_RE.test(req.repo)) throw validation("repo", "invalid");
    if (!Number.isInteger(req.issueNumber) || req.issueNumber <= 0) throw validation("issueNumber", "invalid");

    const repo = await this.d.stores.repos.getByOwnerRepo(req.owner, req.repo);
    if (!repo) throw new DubError("GITHUB_REPO_NOT_FOUND", `repo not registered: ${req.owner}/${req.repo}`, { status: 404 });
    if (!repo.enabled) throw new DubError("GITHUB_REPO_DISABLED", "repo is disabled", { status: 422 });

    const byTask = await this.d.stores.links.getByTaskId(req.taskId);
    if (byTask) throw new DubError("GITHUB_LINK_ALREADY_EXISTS", "task already linked", { status: 409 });
    const byIssue = await this.d.stores.links.getByIssue(repo.id, req.issueNumber);
    if (byIssue) throw new DubError("GITHUB_LINK_ALREADY_EXISTS", "issue already linked", { status: 409 });

    const issue = await this.d.github.getIssue(req.owner, req.repo, req.issueNumber);
    if (!issue) throw new DubError("GITHUB_REPO_NOT_FOUND", "issue not found on GitHub", { status: 404 });

    const link: LinkRecord = {
      id: this.d.newId("ghl"),
      taskId: req.taskId,
      repoId: repo.id,
      owner: req.owner,
      repo: req.repo,
      issueNumber: req.issueNumber,
      issueNodeId: issue.nodeId,
      projectItemId: null,
      syncState: "pending",
      lastSyncedAt: null,
      lastGithubUpdatedAt: issue.updatedAt,
      lastTaskVersion: null,
      lastError: null,
      createdAt: this.d.now(),
      updatedAt: this.d.now(),
    };
    await this.d.stores.links.create(link);
    await this.d.publisher.linkCreated({ requestId, actorId: null }, req.taskId, `${req.owner}/${req.repo}`);
    return toPublicLink(link);
  }

  async deleteLink(requestId: string, id: string): Promise<void> {
    const link = await this.d.stores.links.getById(id);
    if (!link) throw new DubError("GITHUB_LINK_NOT_FOUND", `link not found: ${id}`, { status: 404 });
    await this.d.stores.links.delete(id);
    await this.d.publisher.linkRemoved({ requestId, actorId: null }, link.taskId, `${link.owner}/${link.repo}`);
  }

  // ---------- repos ----------

  async listRepos(requestId: string, eventId: string | undefined, cursor: string | null, limit: number): Promise<{ items: GithubRepoConfig[]; nextCursor: string | null }> {
    const filter = eventId ? { eventId } : {};
    return this.d.stores.repos.list(filter, cursor, clampLimit(limit));
  }

  async registerRepo(requestId: string, createdBy: string, req: RegisterRepoRequest): Promise<GithubRepoConfig> {
    if (!OWNER_RE.test(req.owner)) throw validation("owner", "invalid");
    if (!REPO_RE.test(req.repo)) throw validation("repo", "invalid");
    if (!req.eventId) throw validation("eventId", "required");

    const exists = await this.d.stores.repos.getByOwnerRepo(req.owner, req.repo);
    if (exists) throw new DubError("GITHUB_REPO_ALREADY_REGISTERED", "owner/repo already registered", { status: 409 });

    const eventOk = await this.d.events.exists({ requestId }, req.eventId);
    if (!eventOk) throw new DubError("GITHUB_VALIDATION_FAILED", `unknown eventId: ${req.eventId}`, { status: 400 });

    const repo: GithubRepoConfig = {
      id: this.d.newId("ghr"),
      owner: req.owner,
      repo: req.repo,
      eventId: req.eventId,
      defaultActionId: req.defaultActionId ?? null,
      origin: req.origin ?? this.d.originDefault,
      direction: req.direction ?? "bidirectional",
      enabled: true,
      installationId: req.installationId ?? null,
      projectNumber: req.projectNumber ?? null,
      labelFilter: req.labelFilter ?? [],
      createdBy,
      createdAt: this.d.now(),
      updatedAt: this.d.now(),
    };
    await this.d.stores.repos.create(repo);
    return repo;
  }

  async updateRepo(requestId: string, id: string, patch: UpdateRepoRequest): Promise<GithubRepoConfig> {
    const cur = await this.d.stores.repos.get(id);
    if (!cur) throw new DubError("GITHUB_REPO_NOT_FOUND", `repo not found: ${id}`, { status: 404 });
    if (patch.eventId) {
      const ok = await this.d.events.exists({ requestId }, patch.eventId);
      if (!ok) throw new DubError("GITHUB_VALIDATION_FAILED", `unknown eventId: ${patch.eventId}`, { status: 400 });
    }
    const applied: Partial<GithubRepoConfig> = { updatedAt: this.d.now() };
    if (patch.enabled !== undefined) applied.enabled = patch.enabled;
    if (patch.eventId !== undefined) applied.eventId = patch.eventId;
    if (patch.defaultActionId !== undefined) applied.defaultActionId = patch.defaultActionId;
    if (patch.origin !== undefined) applied.origin = patch.origin;
    if (patch.direction !== undefined) applied.direction = patch.direction;
    if (patch.installationId !== undefined) applied.installationId = patch.installationId;
    if (patch.projectNumber !== undefined) applied.projectNumber = patch.projectNumber;
    if (patch.labelFilter !== undefined) applied.labelFilter = patch.labelFilter;
    const next = await this.d.stores.repos.update(id, applied);
    return next!;
  }

  async deleteRepo(requestId: string, id: string): Promise<void> {
    const ok = await this.d.stores.repos.delete(id);
    if (!ok) throw new DubError("GITHUB_REPO_NOT_FOUND", `repo not found: ${id}`, { status: 404 });
  }

  // ---------- sync runs ----------

  async triggerSync(
    requestId: string,
    triggeredBy: string | null,
    req: githubSync.TriggerSyncRequest,
  ): Promise<{ runId: string; status: SyncRunRecord["status"] }> {
    const scope = req.scope;
    if (scope !== "all" && scope !== "event" && scope !== "task") throw validation("scope", "invalid");
    if ((scope === "event" || scope === "task") && !req.targetId) throw validation("targetId", "required");

    const scopeKey = `${scope}:*`;
    if (await this.d.stores.runs.hasActive(scopeKey)) {
      throw new DubError("GITHUB_SYNC_IN_PROGRESS", `a ${scope} sync is already running`, { status: 409 });
    }

    const run: SyncRunRecord = {
      id: this.d.newId("ghs"),
      scope: scope as SyncRunScope,
      repoId: null,
      status: "running",
      stats: emptyStats(),
      triggeredBy,
      startedAt: this.d.now(),
      finishedAt: null,
      error: null,
      createdAt: this.d.now(),
    };
    await this.d.stores.runs.create(run);

    try {
      const stats = await this.execute(requestId, scope, req.targetId);
      const status: SyncRunRecord["status"] = stats.failed > 0 ? "partial_failed" : "succeeded";
      await this.d.stores.runs.update(run.id, { status, stats, finishedAt: this.d.now() });
      await this.d.publisher.syncCompleted({ requestId, actorId: triggeredBy }, scope);
      return { runId: run.id, status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.d.stores.runs.update(run.id, { status: "partial_failed", finishedAt: this.d.now(), error: msg });
      await this.d.publisher.syncFailed({ requestId, actorId: triggeredBy }, scope, msg);
      return { runId: run.id, status: "partial_failed" };
    }
  }

  private async execute(requestId: string, scope: "all" | "event" | "task", targetId?: string): Promise<import("./domain/types").SyncRunStats> {
    const stats = emptyStats();
    if (scope === "task") {
      const link = await this.d.stores.links.getByTaskId(targetId!);
      if (!link) throw new DubError("GITHUB_LINK_NOT_FOUND", `task not linked: ${targetId}`, { status: 404 });
      const repo = await this.d.stores.repos.get(link.repoId);
      if (!repo) throw new DubError("GITHUB_REPO_NOT_FOUND", "repo missing", { status: 404 });
      const r = await this.d.engine.reconcileRepo(requestId, repo);
      return r;
    }
    const eventId = scope === "event" ? targetId : undefined;
    let cursor: string | null = null;
    do {
      const page = await this.d.stores.repos.list(eventId ? { eventId, enabled: true } : { enabled: true }, cursor, 200);
      for (const repo of page.items) {
        const r = await this.d.engine.reconcileRepo(requestId, repo);
        addStats(stats, r);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return stats;
  }

  async listRuns(cursor: string | null, limit: number): Promise<{ items: SyncRunRecord[]; nextCursor: string | null }> {
    return this.d.stores.runs.list(cursor, clampLimit(limit));
  }

  async getRun(id: string): Promise<SyncRunRecord> {
    const run = await this.d.stores.runs.get(id);
    if (!run) throw new DubError(CommonErrorCodes.NOT_FOUND, `run not found: ${id}`, { status: 404 });
    return run;
  }
}

export function toPublicLink(l: LinkRecord): githubSync.GithubLink {
  return {
    taskId: l.taskId,
    repo: `${l.owner}/${l.repo}`,
    issueNumber: l.issueNumber,
    url: `https://github.com/${l.owner}/${l.repo}/issues/${l.issueNumber}`,
    linkedAt: l.createdAt,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(200, Math.floor(limit));
}

function validation(field: string, reason: string): DubError {
  return new DubError("GITHUB_VALIDATION_FAILED", `invalid ${field}: ${reason}`, {
    status: 400,
    details: [{ field, reason }],
  });
}

function addStats(into: import("./domain/types").SyncRunStats, from: import("./domain/types").SyncRunStats): void {
  into.created += from.created;
  into.updated += from.updated;
  into.skipped += from.skipped;
  into.conflicts += from.conflicts;
  into.failed += from.failed;
}
