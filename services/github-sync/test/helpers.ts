// Shared test doubles: in-memory GitHub / task / identity / event clients,
// a capturing publisher, and an engine/service factory over memory stores.
import type { RequestContext } from "@dub/http";
import { DubError } from "@dub/errors";
import type { task } from "@dub/types";
import type { DubEventContext } from "@dub/events";
import type { GithubApiClient, CreateIssueInput, UpdateIssueInput } from "../src/clients/github";
import type { TaskServiceClient } from "../src/clients/task";
import type { IdentityUserClient } from "../src/clients/identity";
import type { EventExistenceClient } from "../src/clients/event";
import type { Publisher } from "../src/events/publisher";
import type { IssueSnapshot, SyncOrigin } from "../src/domain/types";
import { memoryStores } from "../src/store/memory";
import type { Stores } from "../src/store/types";
import { SyncEngine } from "../src/engine/sync";
import { GithubSyncService } from "../src/service";

let seq = 0;
export function testId(prefix: string): string {
  seq += 1;
  return `${prefix}_${String(seq).padStart(6, "0")}`;
}

export function fixedNow(): string {
  return "2026-08-09T00:00:00.000Z";
}

export class FakeGithub implements GithubApiClient {
  issues = new Map<string, IssueSnapshot>();
  calls: { op: string; input: unknown }[] = [];
  private key(owner: string, repo: string, n: number): string {
    return `${owner}/${repo}#${n}`;
  }
  seed(issue: IssueSnapshot): void {
    this.issues.set(this.key(issue.owner, issue.repo, issue.number), { ...issue });
  }
  async getIssue(owner: string, repo: string, number: number): Promise<IssueSnapshot | null> {
    this.calls.push({ op: "getIssue", input: { owner, repo, number } });
    return this.issues.get(this.key(owner, repo, number)) ?? null;
  }
  async createIssue(input: CreateIssueInput): Promise<IssueSnapshot> {
    this.calls.push({ op: "createIssue", input });
    const number = this.issues.size + 1;
    const snap: IssueSnapshot = {
      owner: input.owner,
      repo: input.repo,
      number,
      nodeId: `node_${number}`,
      title: input.title,
      body: input.body,
      state: "open",
      labels: input.labels,
      assignees: input.assignees,
      updatedAt: fixedNow(),
    };
    this.seed(snap);
    return snap;
  }
  async updateIssue(input: UpdateIssueInput): Promise<IssueSnapshot> {
    this.calls.push({ op: "updateIssue", input });
    const k = this.key(input.owner, input.repo, input.number);
    const cur = this.issues.get(k);
    const next: IssueSnapshot = {
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      nodeId: cur?.nodeId ?? `node_${input.number}`,
      title: input.title ?? cur?.title ?? "",
      body: input.body !== undefined ? input.body : (cur?.body ?? null),
      state: input.state ?? cur?.state ?? "open",
      labels: input.labels ?? cur?.labels ?? [],
      assignees: input.assignees ?? cur?.assignees ?? [],
      updatedAt: "2026-08-09T12:00:00.000Z",
    };
    this.issues.set(k, next);
    return next;
  }
  async addComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    this.calls.push({ op: "addComment", input: { owner, repo, number, body } });
  }
  async listIssues(owner: string, repo: string, sinceIso: string | null): Promise<IssueSnapshot[]> {
    this.calls.push({ op: "listIssues", input: { owner, repo, sinceIso } });
    return [...this.issues.values()].filter((i) => i.owner === owner && i.repo === repo);
  }
  countOp(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

export class FakeTaskService implements TaskServiceClient {
  tasks = new Map<string, task.Task>();
  calls: { op: string; input: unknown }[] = [];
  updateBehavior: ((taskId: string, req: task.UpdateTaskRequest) => void) | null = null;
  seed(t: task.Task): void {
    this.tasks.set(t.id, { ...t });
  }
  async getTask(_ctx: RequestContext, taskId: string): Promise<task.Task> {
    this.calls.push({ op: "getTask", input: taskId });
    const t = this.tasks.get(taskId);
    if (!t) throw new DubError("NOT_FOUND", `task ${taskId}`, { status: 404 });
    return { ...t };
  }
  async createTask(_ctx: RequestContext, req: task.CreateTaskRequest): Promise<task.Task> {
    this.calls.push({ op: "createTask", input: req });
    const id = testId("task");
    const now = fixedNow();
    const t: task.Task = {
      id,
      eventId: req.eventId,
      title: req.title,
      description: req.description ?? null,
      status: "todo",
      priority: req.priority ?? "medium",
      assigneeId: req.assigneeId ?? null,
      dueAt: req.dueAt ?? null,
      origin: req.origin ?? "internal",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.tasks.set(id, t);
    return { ...t };
  }
  async updateTask(_ctx: RequestContext, taskId: string, req: task.UpdateTaskRequest): Promise<task.Task> {
    this.calls.push({ op: "updateTask", input: { taskId, req } });
    if (this.updateBehavior) this.updateBehavior(taskId, req);
    const cur = this.tasks.get(taskId);
    if (!cur) throw new DubError("NOT_FOUND", `task ${taskId}`, { status: 404 });
    if (req.version !== cur.version) throw new DubError("TASK_VERSION_CONFLICT", "version", { status: 409 });
    const next: task.Task = {
      ...cur,
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.description !== undefined ? { description: req.description } : {}),
      ...(req.status !== undefined ? { status: req.status } : {}),
      ...(req.assigneeId !== undefined ? { assigneeId: req.assigneeId } : {}),
      version: cur.version + 1,
      updatedAt: "2026-08-09T12:00:00.000Z",
    };
    this.tasks.set(taskId, next);
    return { ...next };
  }
}

export class FakeIdentity implements IdentityUserClient {
  loginByUser = new Map<string, string>();
  userByLogin = new Map<string, string>();
  async githubLoginOf(_ctx: RequestContext, userId: string): Promise<string | null> {
    return this.loginByUser.get(userId) ?? null;
  }
  async userIdByGithubLogin(_ctx: RequestContext, login: string): Promise<string | null> {
    return this.userByLogin.get(login.toLowerCase()) ?? null;
  }
  map(userId: string, login: string): void {
    this.loginByUser.set(userId, login);
    this.userByLogin.set(login.toLowerCase(), userId);
  }
}

export class FakeEvents implements EventExistenceClient {
  known = new Set<string>();
  async exists(_ctx: RequestContext, eventId: string): Promise<boolean> {
    return this.known.has(eventId);
  }
}

export class CapturingPublisher implements Publisher {
  events: { kind: string; args: unknown }[] = [];
  audits: unknown[] = [];
  async linkCreated(_c: DubEventContext, taskId: string, repo: string): Promise<void> {
    this.events.push({ kind: "link_created", args: { taskId, repo } });
  }
  async linkRemoved(_c: DubEventContext, taskId: string, repo: string): Promise<void> {
    this.events.push({ kind: "link_removed", args: { taskId, repo } });
  }
  async syncCompleted(_c: DubEventContext, scope: string): Promise<void> {
    this.events.push({ kind: "sync_completed", args: { scope } });
  }
  async syncFailed(_c: DubEventContext, scope: string, error: string): Promise<void> {
    this.events.push({ kind: "sync_failed", args: { scope, error } });
  }
  async conflictDetected(_c: DubEventContext, taskId: string): Promise<void> {
    this.events.push({ kind: "conflict_detected", args: { taskId } });
  }
  async audit(input: unknown): Promise<void> {
    this.audits.push(input);
  }
  count(kind: string): number {
    return this.events.filter((e) => e.kind === kind).length;
  }
}

export interface Harness {
  stores: Stores;
  github: FakeGithub;
  tasks: FakeTaskService;
  identity: FakeIdentity;
  events: FakeEvents;
  publisher: CapturingPublisher;
  engine: SyncEngine;
  service: GithubSyncService;
}

export function makeHarness(opts?: { selfLogins?: string[]; originDefault?: SyncOrigin }): Harness {
  const stores = memoryStores();
  const github = new FakeGithub();
  const tasks = new FakeTaskService();
  const identity = new FakeIdentity();
  const events = new FakeEvents();
  const publisher = new CapturingPublisher();
  const engine = new SyncEngine({
    stores,
    github,
    tasks,
    identity,
    publisher,
    config: { selfLogins: opts?.selfLogins ?? ["dub-sync[bot]"], originDefault: opts?.originDefault ?? "github" },
    newId: testId,
    now: fixedNow,
  });
  const service = new GithubSyncService({
    stores,
    github,
    events,
    publisher,
    engine,
    newId: testId,
    now: fixedNow,
    originDefault: opts?.originDefault ?? "github",
  });
  return { stores, github, tasks, identity, events, publisher, engine, service };
}

export function issue(partial: Partial<IssueSnapshot> & { owner: string; repo: string; number: number }): IssueSnapshot {
  return {
    nodeId: `node_${partial.number}`,
    title: "Issue title",
    body: "Issue body",
    state: "open",
    labels: [],
    assignees: [],
    updatedAt: fixedNow(),
    ...partial,
  };
}
