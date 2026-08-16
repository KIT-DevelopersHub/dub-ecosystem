// In-memory ApiClient implementation. Backs local dev and unit tests until FE2's
// real `@dub/api-client` (gateway HTTP) lands. Enforces the same contract the
// server does: version conflicts, status-transition rules, dependency cycles —
// so optimistic-UI rollback paths (tests 2/3/5/9/11) exercise real branches.
import type { gantt, identity, event, common, gateway, team } from "@dub/types";
import { task } from "@dub/types";
import type { ErrorResponse } from "@dub/errors";
import { CommonErrorCodes } from "@dub/errors";
import type {
  ApiClient,
  ApiPath,
  AuthLoginStartResponse,
  RequestInput,
  ResourceClient,
} from "../contracts/spa-shell";
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
  teams?: team.Team[];
  actions?: event.ActionSummary[];
  view?: gantt.GanttViewState;
  /** row date overrides (task has only dueAt; gantt startsAt/endsAt live here). */
  rowDates?: Record<common.TaskId, { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null }>;
  /** critical-path task ids the gantt DTO reports (bar colouring). */
  criticalTaskIds?: common.TaskId[];
  /** WBS hierarchy overlay: taskId -> {parent, depth, wbs}. The task model has no
   *  parent column (server keeps it in gantt-service), so the mock carries it here
   *  and projects it onto each GanttRow. `hasChildren` is derived, not stored. */
  hierarchy?: Record<common.TaskId, { parentTaskId: common.TaskId | null; depth: number; wbs?: string }>;
}

export class MockApiClient implements ApiClient {
  private taskById = new Map<common.TaskId, task.Task>();
  private deps = new Map<common.TaskId, common.TaskId[]>(); // taskId -> dependsOnIds
  private users = new Map<common.UserId, identity.UserSummary>();
  private teams: team.Team[] = [];
  private actions: event.ActionSummary[] = [];
  private view: gantt.GanttViewState | null = null;
  private rowDates: Record<common.TaskId, { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null }> = {};
  private criticalTaskIds: common.TaskId[] = [];
  private hierarchy: Record<common.TaskId, { parentTaskId: common.TaskId | null; depth: number; wbs?: string }> = {};

  /** force the next matching call to throw (test 11 / error branches). */
  failNext: ApiError | null = null;
  /** call log for assertions (batch counts, headers). */
  readonly calls: RequestInput[] = [];

  constructor(seed: MockSeed = {}) {
    for (const t of seed.tasks ?? []) this.taskById.set(t.id, t);
    for (const d of seed.dependencies ?? []) {
      const list = this.deps.get(d.toTaskId) ?? [];
      list.push(d.fromTaskId);
      this.deps.set(d.toTaskId, list);
    }
    for (const u of seed.users ?? []) this.users.set(u.id, u);
    this.teams = seed.teams ?? [];
    this.actions = seed.actions ?? [];
    this.view = seed.view ?? null;
    this.rowDates = seed.rowDates ?? {};
    this.criticalTaskIds = seed.criticalTaskIds ?? [];
    this.hierarchy = seed.hierarchy ?? {};
  }

  /** Set of task ids that appear as some row's parent (⇒ they render a toggle). */
  private parentIdsWithChildren(): Set<common.TaskId> {
    const set = new Set<common.TaskId>();
    for (const h of Object.values(this.hierarchy)) if (h.parentTaskId) set.add(h.parentTaskId);
    return set;
  }

  /** Re-parent a row in the hierarchy overlay (create/update parentTaskId). Depth
   *  is derived from the parent's own depth so nested WBS levels read correctly;
   *  null detaches the row to top-level (depth 0). The task model has no parent
   *  column — the server keeps it in gantt-service, so the mock mirrors that here. */
  private setParent(id: common.TaskId, parentTaskId: common.TaskId | null): void {
    const prev = this.hierarchy[id];
    if (parentTaskId === null) {
      this.hierarchy[id] = { ...(prev ?? {}), parentTaskId: null, depth: 0 };
      return;
    }
    const parentDepth = this.hierarchy[parentTaskId]?.depth ?? 0;
    this.hierarchy[id] = { ...(prev ?? {}), parentTaskId, depth: parentDepth + 1 };
  }

  async request<T, TBody = unknown>(req: RequestInput<TBody>): Promise<T> {
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
    const ganttRow = path.match(/^\/api\/v1\/gantt\/rows\/([^/]+)$/);
    if (ganttRow && req.method === "PATCH")
      return this.patchRowSchedule(ganttRow[1]!, req.body as { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null }) as T;
    if (path === "/api/v1/gantt" && req.method === "GET") return this.ganttDto(String(req.query?.event)) as T;
    if (path === "/api/v1/gantt/dependencies" && req.method === "GET") return this.ganttDeps(String(req.query?.event)) as T;
    if (path === "/api/v1/gantt/views" && req.method === "GET") return this.getView(String(req.query?.event)) as T;
    if (path === "/api/v1/gantt/views" && req.method === "PUT")
      return this.putView(String(req.query?.event), req.body as gantt.PutGanttViewRequest) as T;
    // --- teams (canonical team.Team; future: member-service) ---
    if (path === "/api/v1/teams" && req.method === "GET") return ({ items: this.teams } as team.ListTeamsResponse) as T;
    // --- identity ---
    if (path === "/api/v1/identity/users" && req.method === "GET") return this.listUsers(String(req.query?.ids ?? "")) as T;
    // --- events ---
    const evActions = path.match(/^\/api\/v1\/events\/([^/]+)\/actions$/);
    if (evActions && req.method === "GET") return this.actions as T;

    throw err(404, CommonErrorCodes.NOT_FOUND, `no mock route for ${req.method} ${path}`);
  }

  // ---- FE2 ApiClient resource surface (design 2-4). Delegates to `request`, so
  // the mock's path-router backs both the direct-request calls (FE4 endpoints)
  // and the prefix-scoped resource clients FE2's real client exposes. ----
  private makeResource(prefix: string): ResourceClient {
    const p = (path: string): ApiPath => `/api/v1/${prefix}${path}` as ApiPath;
    return {
      get: <TRes,>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
        this.request<TRes>({ method: "GET", path: p(path), ...(query ? { query } : {}) }),
      post: <TRes, TBody>(path: string, body: TBody) => this.request<TRes, TBody>({ method: "POST", path: p(path), body }),
      patch: <TRes, TBody>(path: string, body: TBody) => this.request<TRes, TBody>({ method: "PATCH", path: p(path), body }),
      delete: <TRes,>(path: string) => this.request<TRes>({ method: "DELETE", path: p(path) }),
    };
  }

  readonly events: ResourceClient = this.makeResource("events");
  readonly tasks: ResourceClient = this.makeResource("tasks");
  readonly gantt: ResourceClient = this.makeResource("gantt");
  readonly notifications: ResourceClient = this.makeResource("notifications");
  readonly chat: ResourceClient = this.makeResource("chat");
  readonly identity: ResourceClient = this.makeResource("identity");
  readonly files: ResourceClient = this.makeResource("files");

  readonly auth = {
    loginStart: (redirectPath?: string): Promise<AuthLoginStartResponse> =>
      this.request<AuthLoginStartResponse>({
        method: "POST",
        path: "/api/v1/auth/login",
        body: { redirectUri: redirectPath ?? "/", client: "web" },
      }),
    logout: (): Promise<void> => this.request<void>({ method: "POST", path: "/api/v1/auth/logout", body: {} }),
    me: (): Promise<gateway.MeResponse> => this.request<gateway.MeResponse>({ method: "GET", path: "/api/v1/me" }),
  };

  readonly bff = {
    home: (): Promise<gateway.BffHomeResponse> =>
      this.request<gateway.BffHomeResponse>({ method: "GET", path: "/api/v1/bff/home" }),
  };

  // ---- task handlers ----
  private listTasks(req: RequestInput): task.ListTasksResponse {
    const q = req.query ?? {};
    let items = [...this.taskById.values()];
    if (q.eventId) items = items.filter((t) => t.eventId === q.eventId);
    if (q.assigneeId) items = items.filter((t) => t.assigneeId === q.assigneeId);
    if (q.teamId) items = items.filter((t) => t.teamId === q.teamId);
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
    const t = this.taskById.get(id);
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
      teamId: body.teamId ?? null,
      dueAt: body.dueAt ?? null,
      origin: body.origin ?? "internal",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.taskById.set(t.id, t);
    if (body.parentTaskId !== undefined) this.setParent(t.id, body.parentTaskId ?? null);
    return t;
  }

  private updateTask(id: string, body: task.UpdateTaskRequest): task.Task {
    const cur = this.taskById.get(id);
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
      ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      version: cur.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.taskById.set(id, next);
    // re-parent (親子関係の変更) lives in the hierarchy overlay, not on the task row.
    if (body.parentTaskId !== undefined) this.setParent(id, body.parentTaskId ?? null);
    return next;
  }

  private deleteTask(id: string): void {
    const cur = this.taskById.get(id);
    if (!cur) throw err(404, "TASK_NOT_FOUND", `task not found: ${id}`);
    this.taskById.set(id, { ...cur, archivedAt: new Date().toISOString(), version: cur.version + 1 });
  }

  private replaceDeps(id: string, body: task.ReplaceDependenciesRequest): task.Task {
    const cur = this.taskById.get(id);
    if (!cur) throw err(404, "TASK_NOT_FOUND", `task not found: ${id}`);
    if (body.version !== cur.version) throw err(409, "TASK_VERSION_CONFLICT", "version conflict");
    // scope rule (判断10): a dependency may only connect same-direct-parent siblings.
    // parent↔child and cross-scope edges are rejected; parent↔parent (both top-level
    // or both under the same grandparent) is allowed by the same test.
    const myParent = this.hierarchy[id]?.parentTaskId ?? null;
    for (const dep of body.dependsOnIds) {
      if (dep === id) throw err(409, "TASK_DEPENDENCY_CYCLE", "self dependency", { taskId: id });
      const depParent = this.hierarchy[dep]?.parentTaskId ?? null;
      if (depParent !== myParent)
        throw err(409, "TASK_DEPENDENCY_SCOPE", "dependency must stay within the same parent scope", {
          taskId: id,
          dependsOnId: dep,
        });
    }
    // cycle check over the proposed graph
    const proposed = new Map(this.deps);
    proposed.set(id, body.dependsOnIds);
    if (hasCycle(proposed)) throw err(409, "TASK_DEPENDENCY_CYCLE", "dependency cycle", { taskId: id });
    this.deps.set(id, body.dependsOnIds);
    const next: task.Task = { ...cur, version: cur.version + 1, updatedAt: new Date().toISOString() };
    this.taskById.set(id, next);
    return next;
  }

  // ---- gantt handlers ----
  private ganttRows(eventId: string): gantt.GanttRow[] {
    const parents = this.parentIdsWithChildren();
    return [...this.taskById.values()]
      .filter((t) => t.eventId === eventId && t.archivedAt === null)
      .map((t): gantt.GanttRow => {
        const schedule = deriveSchedule(t, this.rowDates[t.id]);
        const h = this.hierarchy[t.id];
        return {
          taskId: t.id,
          title: t.title,
          startsAt: schedule.startsAt,
          endsAt: schedule.endsAt,
          progressPercent: progressForStatus(t.status),
          assigneeId: t.assigneeId,
          teamId: t.teamId ?? null,
          parentTaskId: h?.parentTaskId ?? null,
          depth: h?.depth ?? 0,
          hasChildren: parents.has(t.id),
          ...(h?.wbs ? { wbs: h.wbs } : {}),
        };
      });
  }

  private ganttDeps(eventId: string): gantt.GanttDependencyLine[] {
    const ids = new Set([...this.taskById.values()].filter((t) => t.eventId === eventId).map((t) => t.id));
    const lines: gantt.GanttDependencyLine[] = [];
    for (const [toTaskId, fromIds] of this.deps) {
      if (!ids.has(toTaskId)) continue;
      for (const fromTaskId of fromIds) {
        lines.push({ id: `${fromTaskId}->${toTaskId}`, fromTaskId, toTaskId, type: "FS", lagDays: 0 });
      }
    }
    return lines;
  }

  /** Persist a bar's schedule from a timeline drag/resize (Notion-style). The
   *  task model has only dueAt, so gantt startsAt/endsAt live in rowDates; this
   *  is the write path the timeline uses to move/resize bars. Also mirrors endsAt
   *  onto the task's dueAt so the list/detail views stay consistent. */
  private patchRowSchedule(
    taskId: string,
    body: { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
  ): gantt.GanttRow {
    const t = this.taskById.get(taskId);
    if (!t) throw err(404, "TASK_NOT_FOUND", `task not found: ${taskId}`);
    this.rowDates[taskId] = { startsAt: body.startsAt, endsAt: body.endsAt };
    if (body.endsAt) this.taskById.set(taskId, { ...t, dueAt: body.endsAt, updatedAt: new Date().toISOString() });
    const h = this.hierarchy[taskId];
    return {
      taskId,
      title: t.title,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      progressPercent: progressForStatus(t.status),
      assigneeId: t.assigneeId,
      teamId: t.teamId ?? null,
      parentTaskId: h?.parentTaskId ?? null,
      depth: h?.depth ?? 0,
      hasChildren: this.parentIdsWithChildren().has(taskId),
      ...(h?.wbs ? { wbs: h.wbs } : {}),
    };
  }

  private ganttDto(eventId: string): gantt.GanttChartDTO {
    const rowIds = new Set(this.ganttRows(eventId).map((r) => r.taskId));
    return {
      eventId,
      rows: this.ganttRows(eventId),
      dependencies: this.ganttDeps(eventId),
      criticalTaskIds: this.criticalTaskIds.filter((id) => rowIds.has(id)),
    };
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

const MS_PER_DAY = 86_400_000;

/** Bar progress the mock reports per status (in_progress/blocked read as partial). */
function progressForStatus(status: task.TaskStatus): number {
  switch (status) {
    case "done":
      return 100;
    case "in_progress":
      return 50;
    case "blocked":
      return 25;
    default:
      return 0; // todo / cancelled
  }
}

/** Default bar length (days) by priority — mirrors the seed's documented model. */
const DURATION_DAYS_BY_PRIORITY: Record<task.TaskPriority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 5,
};

/**
 * Resolve a row's [startsAt, endsAt] the way gantt-service would: explicit
 * rowDates win; otherwise a task with a dueAt gets a synthesized bar of
 * `bar = [dueAt - durationByPriority, dueAt]` so freshly-created tasks still
 * render a bar in the standalone demo (no CPM backend here).
 */
function deriveSchedule(
  t: task.Task,
  override?: { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
): { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null } {
  if (override) return override;
  if (!t.dueAt) return { startsAt: null, endsAt: null };
  const end = Date.parse(t.dueAt);
  const start = end - DURATION_DAYS_BY_PRIORITY[t.priority] * MS_PER_DAY;
  return { startsAt: new Date(start).toISOString(), endsAt: t.dueAt };
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
