// In-memory ApiClient implementation. Backs local dev and unit tests until FE2's
// real `@dub/api-client` (gateway HTTP) lands. Enforces the same contract the
// server does: version conflicts, status-transition rules, dependency cycles —
// so optimistic-UI rollback paths (tests 2/3/5/9/11) exercise real branches.
import type { gantt, identity, event, common } from "@dub/types";
import { task } from "@dub/types";
import type { ErrorResponse } from "@dub/errors";
import { CommonErrorCodes } from "@dub/errors";
import type { ApiClient, ApiRequest } from "../contracts/spa-shell";
import { ApiError } from "../contracts/spa-shell";

let seq = 0;
function mintId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36).padStart(4, "0")}`;
}

function err(status: number, code: string, message: string, details?: unknown): ApiError {
  const body: ErrorResponse = {
    error: { code, message, retryable: status >= 500, ...(details !== undefined ? { details } : {}) },
  };
  return new ApiError(status, body);
}

export interface MockSeed {
  tasks?: task.Task[];
  dependencies?: gantt.GanttDependencyLine[];
  users?: identity.UserSummary[];
  actions?: event.ActionSummary[];
  view?: gantt.GanttViewState;
  /** row date overrides (task has only dueAt; gantt startsAt/endsAt live here). */
  rowDates?: Record<common.TaskId, { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null }>;
}

export class MockApiClient implements ApiClient {
  private tasks = new Map<common.TaskId, task.Task>();
  private deps = new Map<common.TaskId, common.TaskId[]>(); // taskId -> dependsOnIds
  private users = new Map<common.UserId, identity.UserSummary>();
  private actions: event.ActionSummary[] = [];
  private view: gantt.GanttViewState | null = null;
  private rowDates: Record<common.TaskId, { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null }> = {};

  /** force the next matching call to throw (test 11 / error branches). */
  failNext: ApiError | null = null;
  /** call log for assertions (batch counts, headers). */
  readonly calls: ApiRequest[] = [];

  constructor(seed: MockSeed = {}) {
    for (const t of seed.tasks ?? []) this.tasks.set(t.id, t);
    for (const d of seed.dependencies ?? []) {
      const list = this.deps.get(d.toTaskId) ?? [];
      list.push(d.fromTaskId);
      this.deps.set(d.toTaskId, list);
    }
    for (const u of seed.users ?? []) this.users.set(u.id, u);
    this.actions = seed.actions ?? [];
    this.view = seed.view ?? null;
    this.rowDates = seed.rowDates ?? {};
  }

  async request<T>(req: ApiRequest): Promise<T> {
    this.calls.push(req);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const path = req.path;
    // --- tasks ---
    if (path === "/api/v1/tasks" && req.method === "GET") return this.listTasks(req) as T;
    if (path === "/api/v1/tasks" && req.method === "POST") return this.createTask(req.body as task.CreateTaskRequest) as T;
    const taskDeps = path.match(/^\/api\/v1\/tasks\/([^/]+)\/dependencies$/);
    if (taskDeps && req.method === "PUT") return this.replaceDeps(taskDeps[1]!, req.body as task.ReplaceDependenciesRequest) as T;
    const taskId = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (taskId) {
      const id = taskId[1]!;
      if (req.method === "GET") return this.getTask(id) as T;
      if (req.method === "PATCH") return this.updateTask(id, req.body as task.UpdateTaskRequest) as T;
      if (req.method === "DELETE") return this.deleteTask(id) as T;
    }
    // --- gantt ---
    if (path === "/api/v1/gantt" && req.method === "GET") return this.ganttDto(String(req.query?.event)) as T;
    if (path === "/api/v1/gantt/dependencies" && req.method === "GET") return this.ganttDeps(String(req.query?.event)) as T;
    if (path === "/api/v1/gantt/views" && req.method === "GET") return this.getView(String(req.query?.event)) as T;
    if (path === "/api/v1/gantt/views" && req.method === "PUT")
      return this.putView(String(req.query?.event), req.body as gantt.PutGanttViewRequest) as T;
    // --- identity ---
    if (path === "/api/v1/identity/users" && req.method === "GET") return this.listUsers(String(req.query?.ids ?? "")) as T;
    // --- events ---
    const evActions = path.match(/^\/api\/v1\/events\/([^/]+)\/actions$/);
    if (evActions && req.method === "GET") return this.actions as T;

    throw err(404, CommonErrorCodes.NOT_FOUND, `no mock route for ${req.method} ${path}`);
  }

  // ---- task handlers ----
  private listTasks(req: ApiRequest): task.ListTasksResponse {
    const q = req.query ?? {};
    let items = [...this.tasks.values()];
    if (q.eventId) items = items.filter((t) => t.eventId === q.eventId);
    if (q.assigneeId) items = items.filter((t) => t.assigneeId === q.assigneeId);
    if (q.status) {
      const statuses = String(q.status).split(",");
      items = items.filter((t) => statuses.includes(t.status));
    }
    if (!q.includeArchived) items = items.filter((t) => t.archivedAt === null);
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const limit = q.limit ? Number(q.limit) : 50;
    const start = q.cursor ? items.findIndex((t) => t.id === String(q.cursor)) + 1 : 0;
    const page = items.slice(start, start + limit);
    const last = page[page.length - 1];
    const nextCursor = last && start + limit < items.length ? last.id : null;
    return { items: page, nextCursor };
  }

  private getTask(id: string): task.Task {
    const t = this.tasks.get(id);
    if (!t) throw err(404, "TASK_NOT_FOUND", `task not found: ${id}`);
    return t;
  }

  private createTask(body: task.CreateTaskRequest): task.Task {
    const now = new Date().toISOString();
    const t: task.Task = {
      id: mintId("task"),
      eventId: body.eventId,
      title: body.title,
      description: body.description ?? null,
      status: "todo",
      priority: body.priority ?? "medium",
      assigneeId: body.assigneeId ?? null,
      dueAt: body.dueAt ?? null,
      origin: body.origin ?? "internal",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.tasks.set(t.id, t);
    return t;
  }

  private updateTask(id: string, body: task.UpdateTaskRequest): task.Task {
    const cur = this.tasks.get(id);
    if (!cur) throw err(404, "TASK_NOT_FOUND", `task not found: ${id}`);
    if (body.version !== cur.version)
      throw err(409, "TASK_VERSION_CONFLICT", "version conflict", { current: cur.version });
    if (body.status && body.status !== cur.status) {
      const allowed = task.TASK_STATUS_TRANSITIONS[cur.status];
      if (!allowed.includes(body.status))
        throw err(409, "TASK_INVALID_STATUS_TRANSITION", `cannot move ${cur.status} -> ${body.status}`);
    }
    const next: task.Task = {
      ...cur,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      version: cur.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, next);
    return next;
  }

  private deleteTask(id: string): void {
    const cur = this.tasks.get(id);
    if (!cur) throw err(404, "TASK_NOT_FOUND", `task not found: ${id}`);
    this.tasks.set(id, { ...cur, archivedAt: new Date().toISOString(), version: cur.version + 1 });
  }

  private replaceDeps(id: string, body: task.ReplaceDependenciesRequest): task.Task {
    const cur = this.tasks.get(id);
    if (!cur) throw err(404, "TASK_NOT_FOUND", `task not found: ${id}`);
    if (body.version !== cur.version) throw err(409, "TASK_VERSION_CONFLICT", "version conflict");
    // cycle check over the proposed graph
    const proposed = new Map(this.deps);
    proposed.set(id, body.dependsOnIds);
    if (hasCycle(proposed)) throw err(409, "TASK_DEPENDENCY_CYCLE", "dependency cycle", { taskId: id });
    this.deps.set(id, body.dependsOnIds);
    const next: task.Task = { ...cur, version: cur.version + 1, updatedAt: new Date().toISOString() };
    this.tasks.set(id, next);
    return next;
  }

  // ---- gantt handlers ----
  private ganttRows(eventId: string): gantt.GanttRow[] {
    return [...this.tasks.values()]
      .filter((t) => t.eventId === eventId && t.archivedAt === null)
      .map((t): gantt.GanttRow => {
        const d = this.rowDates[t.id];
        return {
          taskId: t.id,
          title: t.title,
          startsAt: d?.startsAt ?? null,
          endsAt: d?.endsAt ?? t.dueAt,
          progressPercent: t.status === "done" ? 100 : 0,
          assigneeId: t.assigneeId,
        };
      });
  }

  private ganttDeps(eventId: string): gantt.GanttDependencyLine[] {
    const ids = new Set([...this.tasks.values()].filter((t) => t.eventId === eventId).map((t) => t.id));
    const lines: gantt.GanttDependencyLine[] = [];
    for (const [toTaskId, fromIds] of this.deps) {
      if (!ids.has(toTaskId)) continue;
      for (const fromTaskId of fromIds) {
        lines.push({ id: `${fromTaskId}->${toTaskId}`, fromTaskId, toTaskId, type: "FS", lagDays: 0 });
      }
    }
    return lines;
  }

  private ganttDto(eventId: string): gantt.GanttChartDTO {
    return { eventId, rows: this.ganttRows(eventId), dependencies: this.ganttDeps(eventId) };
  }

  private getView(eventId: string): gantt.GanttViewState {
    return this.view ?? { eventId, zoom: "week", collapsedTaskIds: [] };
  }

  private putView(eventId: string, body: gantt.PutGanttViewRequest): gantt.GanttViewState {
    this.view = { eventId, zoom: body.zoom, collapsedTaskIds: body.collapsedTaskIds };
    return this.view;
  }

  // ---- identity ----
  private listUsers(idsCsv: string): common.Paginated<identity.UserSummary> {
    const ids = idsCsv ? idsCsv.split(",") : [];
    const items = ids.map((id) => this.users.get(id)).filter((u): u is identity.UserSummary => u !== undefined);
    return { items, nextCursor: null };
  }
}

/** DFS cycle detection over adjacency (node -> dependsOn). */
export function hasCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const nodes = new Set<string>();
  for (const [k, vs] of graph) {
    nodes.add(k);
    for (const v of vs) nodes.add(v);
  }
  const visit = (n: string): boolean => {
    color.set(n, GRAY);
    for (const m of graph.get(n) ?? []) {
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(m)) return true;
    }
    color.set(n, BLACK);
    return false;
  };
  for (const n of nodes) if ((color.get(n) ?? WHITE) === WHITE && visit(n)) return true;
  return false;
}
