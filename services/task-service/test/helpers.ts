// In-memory fakes for every task-service dependency seam — no Cloudflare runtime.
import type { RequestContext } from "@dub/http";
import type { DubEventEnvelope } from "@dub/events";
import type { IdempotencyStore } from "@dub/events";
import type { task, common, auditLog, identity } from "@dub/types";
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { AppConfig } from "../src/env";
import type { Deps } from "../src/deps";
import type { TaskRepo, InsertTaskInput, InsertAttachmentInput, TaskPatch, ListFilter, DueSoonRow } from "../src/repo";
import type { EventClient, EventRef, IdentityClient, Authorizer } from "../src/clients";
import type { EventPublisher, Auditor } from "../src/events";
import type { Principal } from "../src/principal";

interface Rec extends task.Task {
  createdBy: string;
  dueSoonNotifiedAt: string | null;
}

export class InMemoryTaskRepo implements TaskRepo {
  rows = new Map<string, Rec>();
  deps: task.TaskDependency[] = [];

  async insert(input: InsertTaskInput): Promise<task.Task> {
    const rec: Rec = {
      id: input.id,
      eventId: input.eventId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId,
      // WBS/team columns (mirror the D1 repo — the old in-memory fake dropped these,
      // so parent/team/wbs persistence went untested and #260's bug could slip by).
      teamId: input.teamId ?? null,
      parentTaskId: input.parentId ?? null,
      wbs: input.wbs ?? null,
      startAt: input.startAt ?? null,
      dueAt: input.dueAt,
      origin: input.origin,
      teamId: input.teamId ?? null,
      version: 1,
      archivedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
      createdBy: input.createdBy,
      dueSoonNotifiedAt: null,
    };
    this.rows.set(rec.id, rec);
    return this.toTask(rec);
  }

  private toTask(r: Rec): task.Task {
    const { dueSoonNotifiedAt: _d, ...t } = r;
    void _d;
    return { ...t }; // createdBy kept — the real repo exposes it (from→to "from").
  }

  async getById(id: string, includeArchived = false): Promise<task.Task | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    if (!includeArchived && r.archivedAt) return null;
    return this.toTask(r);
  }

  async list(filter: ListFilter): Promise<{ items: task.Task[]; nextCursor: string | null }> {
    let recs = [...this.rows.values()];
    if (!filter.includeArchived) recs = recs.filter((r) => r.archivedAt === null);
    if (filter.eventId) recs = recs.filter((r) => r.eventId === filter.eventId);
    if (filter.assigneeId) recs = recs.filter((r) => r.assigneeId === filter.assigneeId);
    if (filter.createdById) recs = recs.filter((r) => r.createdBy === filter.createdById);
    if (filter.statuses && filter.statuses.length > 0) {
      const set = new Set(filter.statuses);
      recs = recs.filter((r) => set.has(r.status));
    }
    recs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // id DESC
    if (filter.cursorId) recs = recs.filter((r) => r.id < filter.cursorId!);
    const hasMore = recs.length > filter.limit;
    const page = hasMore ? recs.slice(0, filter.limit) : recs;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.toTask(r)),
      nextCursor: hasMore && last ? btoa(last.id) : null,
    };
  }

  async update(id: string, patch: TaskPatch, expectedVersion: number, now: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.archivedAt) return false;
    if (r.version !== expectedVersion) return false;
    if (patch.title !== undefined) r.title = patch.title;
    if (patch.description !== undefined) r.description = patch.description;
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.priority !== undefined) r.priority = patch.priority;
    if (patch.assigneeId !== undefined) r.assigneeId = patch.assigneeId;
    if (patch.teamId !== undefined) r.teamId = patch.teamId;
    if (patch.parentId !== undefined) r.parentTaskId = patch.parentId;
    if (patch.wbs !== undefined) r.wbs = patch.wbs;
    if (patch.startAt !== undefined) r.startAt = patch.startAt;
    if (patch.dueAt !== undefined) r.dueAt = patch.dueAt;
    if (patch.teamId !== undefined) r.teamId = patch.teamId;
    r.version += 1;
    r.updatedAt = now;
    return true;
  }

  async archive(id: string, now: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.archivedAt) return false;
    r.archivedAt = now;
    r.updatedAt = now;
    r.version += 1;
    return true;
  }

  async countLiveChildren(parentId: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.parentTaskId === parentId && r.archivedAt === null) n += 1;
    }
    return n;
  }

  async restore(id: string, now: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || !r.archivedAt) return false;
    r.archivedAt = null;
    r.updatedAt = now;
    r.version += 1;
    return true;
  }

  async archiveByEvent(eventId: string, now: string): Promise<common.TaskId[]> {
    const ids: string[] = [];
    for (const r of this.rows.values()) {
      if (r.eventId === eventId && r.archivedAt === null) {
        r.archivedAt = now;
        r.updatedAt = now;
        r.version += 1;
        ids.push(r.id);
      }
    }
    return ids;
  }

  async getDependsOn(taskId: string): Promise<common.TaskId[]> {
    return this.deps.filter((d) => d.taskId === taskId).map((d) => d.dependsOnId);
  }

  async listDependenciesByEvent(eventId: string | null): Promise<task.TaskDependency[]> {
    return this.deps
      .filter((d) => (this.rows.get(d.taskId)?.eventId ?? null) === eventId)
      .map((d) => ({ ...d }));
  }

  async listLiveTasksByEvent(
    eventId: string | null,
  ): Promise<Array<{ id: common.TaskId; teamId: common.TeamId | null }>> {
    return [...this.rows.values()]
      .filter((r) => (r.eventId ?? null) === eventId && r.archivedAt === null)
      .map((r) => ({ id: r.id, teamId: r.teamId ?? null }));
  }

  async replaceDependencies(
    taskId: string,
    dependsOnIds: string[],
    expectedVersion: number,
    now: string,
  ): Promise<{ ok: boolean; added: common.TaskId[]; removed: common.TaskId[] }> {
    const r = this.rows.get(taskId);
    if (!r || r.archivedAt) return { ok: false, added: [], removed: [] };
    if (r.version !== expectedVersion) return { ok: false, added: [], removed: [] };
    const existing = this.deps.filter((d) => d.taskId === taskId).map((d) => d.dependsOnId);
    const nextSet = new Set(dependsOnIds);
    const prevSet = new Set(existing);
    const added = [...nextSet].filter((x) => !prevSet.has(x));
    const removed = [...prevSet].filter((x) => !nextSet.has(x));
    this.deps = this.deps.filter((d) => d.taskId !== taskId);
    for (const dep of nextSet) this.deps.push({ taskId, dependsOnId: dep });
    r.version += 1;
    r.updatedAt = now;
    return { ok: true, added, removed };
  }

  async scanDueSoon(nowMs: number, windowMs: number, now: string): Promise<DueSoonRow[]> {
    const start = new Date(nowMs).toISOString();
    const end = new Date(nowMs + windowMs).toISOString();
    const out: DueSoonRow[] = [];
    for (const r of this.rows.values()) {
      if (
        r.archivedAt === null &&
        r.dueAt !== null &&
        r.dueSoonNotifiedAt === null &&
        r.status !== "done" &&
        r.status !== "cancelled" &&
        r.dueAt >= start &&
        r.dueAt <= end
      ) {
        r.dueSoonNotifiedAt = now;
        out.push({ taskId: r.id, eventId: r.eventId ?? null, dueAt: r.dueAt });
      }
    }
    return out;
  }

  attachments: Array<task.TaskAttachment & { archivedAt: string | null }> = [];

  async addAttachment(input: InsertAttachmentInput): Promise<task.TaskAttachment> {
    const att: task.TaskAttachment & { archivedAt: string | null } = {
      id: input.id,
      taskId: input.taskId,
      kind: input.kind,
      name: input.name,
      url: input.url,
      fileId: input.fileId,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      createdBy: input.createdBy,
      createdAt: input.now,
      archivedAt: null,
    };
    this.attachments.push(att);
    const { archivedAt: _a, ...pub } = att;
    void _a;
    return { ...pub };
  }

  async listAttachments(taskId: string): Promise<task.TaskAttachment[]> {
    return this.attachments
      .filter((a) => a.taskId === taskId && a.archivedAt === null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(({ archivedAt: _a, ...pub }) => {
        void _a;
        return { ...pub };
      });
  }

  async archiveAttachment(taskId: string, attachmentId: string, now: string): Promise<boolean> {
    const att = this.attachments.find(
      (a) => a.id === attachmentId && a.taskId === taskId && a.archivedAt === null,
    );
    if (!att) return false;
    att.archivedAt = now;
    return true;
  }
}

export class FakeEventPublisher implements EventPublisher {
  published: DubEventEnvelope[] = [];
  async publish(envelopes: DubEventEnvelope[]): Promise<void> {
    this.published.push(...envelopes);
  }
  names(): string[] {
    return this.published.map((e) => e.name);
  }
  byName<N extends string>(name: N): DubEventEnvelope[] {
    return this.published.filter((e) => e.name === name);
  }
}

export class FakeAuditor implements Auditor {
  records: auditLog.AuditRecordInput[] = [];
  async record(input: auditLog.AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

export class FakeAuthorizer implements Authorizer {
  denied = new Set<identity.PermissionKey>();
  async require(_ctx: RequestContext, principal: Principal, permission: identity.PermissionKey): Promise<void> {
    if (principal.kind === "service") return;
    if (this.denied.has(permission)) {
      throw new DubError(CommonErrorCodes.FORBIDDEN, `permission denied: ${permission}`, { status: 403 });
    }
  }
}

export class FakeEventClient implements EventClient {
  missing = new Set<string>();
  archived = new Set<string>();
  async getEvent(_ctx: RequestContext, eventId: string): Promise<EventRef | null> {
    if (this.missing.has(eventId)) return null;
    return { archivedAt: this.archived.has(eventId) ? "2026-08-09T00:00:00Z" : null };
  }
}

export class FakeIdentityClient implements IdentityClient {
  unknown = new Set<string>();
  async userExists(_ctx: RequestContext, userId: string): Promise<boolean> {
    return !this.unknown.has(userId);
  }
}

export class FakeIdempotencyStore implements IdempotencyStore {
  seen = new Set<string>();
  async wasProcessed(id: string): Promise<boolean> {
    return this.seen.has(id);
  }
  async markProcessed(id: string): Promise<void> {
    this.seen.add(id);
  }
}

export interface TestHarness {
  deps: Deps;
  repo: InMemoryTaskRepo;
  events: FakeEventPublisher;
  audit: FakeAuditor;
  authz: FakeAuthorizer;
  eventClient: FakeEventClient;
  identity: FakeIdentityClient;
  idempotency: FakeIdempotencyStore;
  config: AppConfig;
}

export function makeHarness(): TestHarness {
  const config: AppConfig = {
    environment: "test",
    orgId: "org_devhub",
    dueSoonWindowMs: 24 * 60 * 60 * 1000,
    serviceCallers: new Set(["github-sync"]),
  };
  const repo = new InMemoryTaskRepo();
  const events = new FakeEventPublisher();
  const audit = new FakeAuditor();
  const authz = new FakeAuthorizer();
  const eventClient = new FakeEventClient();
  const identity = new FakeIdentityClient();
  const idempotency = new FakeIdempotencyStore();
  const deps: Deps = { config, repo, events, audit, authz, eventClient, identity, idempotency };
  return { deps, repo, events, audit, authz, eventClient, identity, idempotency, config };
}

// ---- request builders ----
export function userInit(
  method: string,
  body?: unknown,
  opts: { userId?: string; requestId?: string } = {},
): RequestInit {
  const headers: Record<string, string> = {
    "x-dub-request-id": opts.requestId ?? "req_test",
    "x-dub-user-id": opts.userId ?? "usr_alice",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
}

/** Service-role request (x-dub-internal + allow-listed x-dub-caller, no user id). */
export function serviceInit(method: string, body?: unknown, caller = "github-sync"): RequestInit {
  const headers: Record<string, string> = {
    "x-dub-request-id": "req_svc",
    "x-dub-internal": "1",
    "x-dub-caller": caller,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
}
