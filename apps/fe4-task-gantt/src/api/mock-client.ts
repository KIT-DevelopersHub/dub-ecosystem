// In-memory ApiClient implementation. Backs local dev and unit tests until FE2's
// real `@dub/api-client` (gateway HTTP) lands. Enforces the same contract the
// server does: version conflicts, status-transition rules, dependency cycles —
// so optimistic-UI rollback paths (tests 2/3/5/9/11) exercise real branches.
import type { gantt, identity, event, common, gateway, team, member } from "@dub/types";
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
  events?: event.EventSummary[];
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
  /** "current user" the mock stamps as createdBy on POST /tasks (from→to "from"). */
  currentUserId?: common.UserId;
  /** send / receive (送る・受け取る): seed pending/decided requests + cross-links. */
  requests?: task.TaskRequest[];
  crossLinks?: task.TaskCrossLink[];
}

export class MockApiClient implements ApiClient {
  private taskById = new Map<common.TaskId, task.Task>();
  private deps = new Map<common.TaskId, common.TaskId[]>(); // taskId -> dependsOnIds
  private users = new Map<common.UserId, identity.UserSummary>();
  private teams: team.Team[] = [];
  private eventSummaries: event.EventSummary[] = [];
  private actions: event.ActionSummary[] = [];
  private view: gantt.GanttViewState | null = null;
  private rowDates: Record<common.TaskId, { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null }> = {};
  private criticalTaskIds: common.TaskId[] = [];
  private hierarchy: Record<common.TaskId, { parentTaskId: common.TaskId | null; depth: number; wbs?: string }> = {};
  private currentUserId: common.UserId;
  private attachmentsByTask = new Map<common.TaskId, task.TaskAttachment[]>();
  private requestsById = new Map<string, task.TaskRequest>();
  private crossLinks: task.TaskCrossLink[] = [];

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
    this.eventSummaries = seed.events ?? [];
    this.actions = seed.actions ?? [];
    this.view = seed.view ?? null;
    this.rowDates = seed.rowDates ?? {};
    this.criticalTaskIds = seed.criticalTaskIds ?? [];
    this.hierarchy = seed.hierarchy ?? {};
    this.currentUserId = seed.currentUserId ?? "usr_me";
    for (const r of seed.requests ?? []) this.requestsById.set(r.id, r);
    this.crossLinks = seed.crossLinks ?? [];
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
    // --- send / receive (task-requests + cross-links). Match BEFORE the /tasks/:id
    //     and /task-requests/:id catch-alls so the literal sub-paths aren't shadowed. ---
    if (path === "/api/v1/tasks/cross-links" && req.method === "GET")
      return ({ items: this.listCrossLinks(String(req.query?.eventId)) } as task.ListTaskCrossLinksResponse) as T;
    if (path === "/api/v1/task-requests") {
      if (req.method === "POST") return this.issueRequest(req.body as task.IssueTaskRequestBody) as T;
      if (req.method === "GET") return this.listRequests(req.query ?? {}) as T;
    }
    const trAccept = path.match(/^\/api\/v1\/task-requests\/([^/]+)\/accept$/);
    if (trAccept && req.method === "POST") return this.acceptRequest(trAccept[1]!, req.body as task.AcceptTaskRequestBody) as T;
    const trDecline = path.match(/^\/api\/v1\/task-requests\/([^/]+)\/decline$/);
    if (trDecline && req.method === "POST") return this.declineRequest(trDecline[1]!, req.body as task.DeclineTaskRequestBody) as T;
    const trCancel = path.match(/^\/api\/v1\/task-requests\/([^/]+)\/cancel$/);
    if (trCancel && req.method === "POST") return this.cancelRequest(trCancel[1]!, req.body as task.CancelTaskRequestBody) as T;
    const trId = path.match(/^\/api\/v1\/task-requests\/([^/]+)$/);
    if (trId && req.method === "GET") return this.getRequest(trId[1]!) as T;
    // --- tasks ---
    if (path === "/api/v1/tasks" && req.method === "GET") return this.listTasks(req) as T;
    if (path === "/api/v1/tasks" && req.method === "POST") return this.createTask(req.body as task.CreateTaskRequest) as T;
    const taskDeps = path.match(/^\/api\/v1\/tasks\/([^/]+)\/dependencies$/);
    if (taskDeps && req.method === "PUT") return this.replaceDeps(taskDeps[1]!, req.body as task.ReplaceDependenciesRequest) as T;
    const taskAtts = path.match(/^\/api\/v1\/tasks\/([^/]+)\/attachments$/);
    if (taskAtts) {
      if (req.method === "GET") return this.listAttachments(taskAtts[1]!) as T;
      if (req.method === "POST") return this.addAttachment(taskAtts[1]!, req.body as task.CreateTaskAttachmentRequest) as T;
    }
    const taskAtt = path.match(/^\/api\/v1\/tasks\/([^/]+)\/attachments\/([^/]+)$/);
    if (taskAtt && req.method === "DELETE") return this.removeAttachment(taskAtt[1]!, taskAtt[2]!) as T;
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
    // Query key is `eventId` — the @dub/types wire contract (gantt.GetGanttQuery). The mock
    // reads the SAME key the server does; it must never mirror a FE-local rename (the old
    // `event` here is exactly why FE unit tests stayed green while prod 400'd).
    if (path === "/api/v1/gantt" && req.method === "GET") return this.ganttDto(String(req.query?.eventId)) as T;
    if (path === "/api/v1/gantt/dependencies" && req.method === "GET") return this.ganttDeps(String(req.query?.eventId)) as T;
    if (path === "/api/v1/gantt/views" && req.method === "GET") return this.getView(String(req.query?.eventId)) as T;
    if (path === "/api/v1/gantt/views" && req.method === "PUT")
      return this.putView(String(req.query?.eventId), req.body as gantt.PutGanttViewRequest) as T;
    // --- teams (canonical team.Team; future: member-service) ---
    if ((path === "/api/v1/members/teams" || path === "/api/v1/teams") && req.method === "GET")
      // Mirror member-service's canonical { teams } envelope so the mock and prod
      // agree (previously { items }, which hid a prod-only empty team switcher).
      return ({ teams: this.teams } as member.ListTeamsResponse) as T;
    // --- identity ---
    if (path === "/api/v1/identity/users" && req.method === "GET") return this.listUsers(req.query ?? {}) as T;
    // --- events ---
    if (path === "/api/v1/events" && req.method === "GET")
      return ({ items: this.eventSummaries } as event.ListEventsResponse) as T;
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
    if (q.createdById) items = items.filter((t) => t.createdBy === q.createdById);
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

  private listAttachments(taskId: string): task.ListTaskAttachmentsResponse {
    if (!this.taskById.has(taskId)) throw err(404, "TASK_NOT_FOUND", `task not found: ${taskId}`);
    return { items: [...(this.attachmentsByTask.get(taskId) ?? [])] };
  }

  private addAttachment(taskId: string, body: task.CreateTaskAttachmentRequest): task.TaskAttachment {
    if (!this.taskById.has(taskId)) throw err(404, "TASK_NOT_FOUND", `task not found: ${taskId}`);
    if (body.kind !== "file" && body.kind !== "url") throw err(400, "VALIDATION_FAILED", "invalid kind");
    if (!body.name?.trim() || !body.url) throw err(400, "VALIDATION_FAILED", "name and url are required");
    if (body.kind === "url" && !/^https?:\/\//i.test(body.url)) throw err(400, "VALIDATION_FAILED", "url must be http(s)");
    const att: task.TaskAttachment = {
      id: mintId("tatt"),
      taskId,
      kind: body.kind,
      name: body.name.trim(),
      url: body.url,
      fileId: body.fileId ?? null,
      mimeType: body.mimeType ?? null,
      sizeBytes: body.sizeBytes ?? null,
      createdBy: this.currentUserId,
      createdAt: new Date().toISOString(),
    };
    const list = this.attachmentsByTask.get(taskId) ?? [];
    this.attachmentsByTask.set(taskId, [att, ...list]);
    return att;
  }

  private removeAttachment(taskId: string, attachmentId: string): { ok: true } {
    const list = this.attachmentsByTask.get(taskId) ?? [];
    const next = list.filter((a) => a.id !== attachmentId);
    if (next.length === list.length) throw err(404, "TASK_NOT_FOUND", `attachment not found: ${attachmentId}`);
    this.attachmentsByTask.set(taskId, next);
    return { ok: true };
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
      createdBy: this.currentUserId, // server stamps created_by from the principal
      startAt: body.startAt ?? null,
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
      ...(body.startAt !== undefined ? { startAt: body.startAt } : {}),
      ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      version: cur.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.taskById.set(id, next);
    // Keep the gantt read-model in sync with a start/due edit. The bar reads its
    // window from `rowDates` (a stand-in for gantt-service's derived DTO); the real
    // gantt-service derives the bar from the task's live startAt/dueAt columns on
    // every read, so a detail-panel date edit reflects immediately. The mock cached
    // the seed override and never refreshed it here, so editing 開始日/期日 changed the
    // task columns but the bar kept rendering the stale seed dates (the "詳細で日付を
    // 変更してもバーが変わらない" bug). Re-derive the override from the updated columns.
    if (body.startAt !== undefined || body.dueAt !== undefined) {
      this.rowDates[id] = deriveSchedule(next, undefined);
    }
    // re-parent (親子関係の変更) lives in the hierarchy overlay, not on the task row.
    if (body.parentTaskId !== undefined) this.setParent(id, body.parentTaskId ?? null);
    return next;
  }

  private deleteTask(id: string): void {
    const cur = this.taskById.get(id);
    if (!cur) throw err(404, "TASK_NOT_FOUND", `task not found: ${id}`);
    this.taskById.set(id, { ...cur, archivedAt: new Date().toISOString(), version: cur.version + 1 });
  }

  // Returns the SERVER wire shape { taskId, dependsOnIds } — NOT a task.Task. The
  // real task-service replies with exactly this (it bumps the task version in the
  // DB but does not echo the task back). The old mock returned a full Task with a
  // `version`, which hid a real FE bug: callers read `.version` off this response
  // (undefined in prod) and corrupted the optimistic version chain. Mirror prod.
  private replaceDeps(id: string, body: task.ReplaceDependenciesRequest): { taskId: string; dependsOnIds: string[] } {
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
    // Bump the task version in the store (the real DB does the same) but reply with
    // only the wire shape { taskId, dependsOnIds }.
    this.taskById.set(id, { ...cur, version: cur.version + 1, updatedAt: new Date().toISOString() });
    return { taskId: id, dependsOnIds: [...body.dependsOnIds] };
  }

  // ---- send / receive handlers (simplified mock; the server does the real team/role
  //      decisions. Here: self→task, anyone-else→pending request; accept materialises
  //      both tasks + the cross-link. State + version are enforced so optimistic-UI
  //      rollback paths exercise real branches, matching the tasks/deps handlers). ----
  private issueRequest(body: task.IssueTaskRequestBody): task.IssueTaskRequestResponse {
    if (body.toUserId === this.currentUserId) {
      const t = this.createTask({
        ...(body.eventId != null ? { eventId: body.eventId } : {}),
        title: body.title,
        ...(body.description != null ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        assigneeId: body.toUserId,
        ...(body.dueAt != null ? { dueAt: body.dueAt } : {}),
        ...(body.targetTeamId != null ? { teamId: body.targetTeamId } : {}),
      });
      return { kind: "task", task: t };
    }
    const now = new Date().toISOString();
    const r: task.TaskRequest = {
      id: mintId("treq"),
      eventId: body.eventId ?? null,
      fromUserId: this.currentUserId,
      toUserId: body.toUserId,
      fromTeamId: null,
      toTeamId: body.targetTeamId ?? null,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? "medium",
      dueAt: body.dueAt ?? null,
      sourceTaskId: body.sourceTaskId ?? null,
      state: "pending",
      declineReason: null,
      createdTaskId: null,
      version: 1,
      createdAt: now,
      decidedAt: null,
      updatedAt: now,
    };
    this.requestsById.set(r.id, r);
    return { kind: "request", request: r };
  }

  private listRequests(query: Record<string, string | number | boolean | undefined>): task.ListTaskRequestsResponse {
    const box = String(query.box ?? "incoming");
    let items = [...this.requestsById.values()].filter((r) =>
      box === "incoming" ? r.toUserId === this.currentUserId : r.fromUserId === this.currentUserId,
    );
    if (query.state) {
      const states = String(query.state).split(",");
      items = items.filter((r) => states.includes(r.state));
    }
    if (query.eventId) items = items.filter((r) => (r.eventId ?? null) === query.eventId);
    items.sort((a, b) => b.id.localeCompare(a.id));
    return { items, nextCursor: null };
  }

  private getRequest(id: string): task.TaskRequest {
    const r = this.requestsById.get(id);
    if (!r) throw err(404, "TASK_REQUEST_NOT_FOUND", `request not found: ${id}`);
    return r;
  }

  private acceptRequest(id: string, body: task.AcceptTaskRequestBody): task.AcceptTaskRequestResponse {
    const r = this.requirePending(id, body.version);
    const now = new Date().toISOString();
    const toTeam = body.targetTeamId ?? r.toTeamId ?? null;
    // receiver task ("受け負った")
    const createdTask = this.createTask({
      ...(r.eventId != null ? { eventId: r.eventId } : {}),
      title: r.title,
      ...(r.description != null ? { description: r.description } : {}),
      priority: r.priority,
      assigneeId: r.toUserId,
      ...(r.dueAt != null ? { dueAt: r.dueAt } : {}),
      ...(toTeam != null ? { teamId: toTeam } : {}),
    });
    // requester tracking task ("お願いした"): reuse sourceTaskId, else generate one.
    let requesterTaskId = r.sourceTaskId ?? null;
    if (!requesterTaskId) {
      const rt = this.createTask({
        ...(r.eventId != null ? { eventId: r.eventId } : {}),
        title: r.title,
        priority: r.priority,
        assigneeId: r.fromUserId,
        ...(r.dueAt != null ? { dueAt: r.dueAt } : {}),
        ...(r.fromTeamId != null ? { teamId: r.fromTeamId } : {}),
      });
      requesterTaskId = rt.id;
    }
    const crossLink: task.TaskCrossLink = {
      id: mintId("txl"),
      requestId: id,
      requesterTaskId,
      requesteeTaskId: createdTask.id,
      eventId: r.eventId ?? null,
      createdAt: now,
    };
    this.crossLinks.push(crossLink);
    const request: task.TaskRequest = {
      ...r,
      state: "accepted",
      createdTaskId: createdTask.id,
      toTeamId: toTeam,
      version: r.version + 1,
      decidedAt: now,
      updatedAt: now,
    };
    this.requestsById.set(id, request);
    return { request, createdTask, crossLink };
  }

  private declineRequest(id: string, body: task.DeclineTaskRequestBody): task.TaskRequest {
    return this.decideRequest(id, body.version, "declined", body.reason ?? null);
  }

  private cancelRequest(id: string, body: task.CancelTaskRequestBody): task.TaskRequest {
    return this.decideRequest(id, body.version, "cancelled", null);
  }

  private requirePending(id: string, version: number): task.TaskRequest {
    const r = this.requestsById.get(id);
    if (!r) throw err(404, "TASK_REQUEST_NOT_FOUND", `request not found: ${id}`);
    if (r.state !== "pending") throw err(409, "TASK_REQUEST_INVALID_STATE", `request is ${r.state}, not pending`);
    if (version !== r.version) throw err(409, "TASK_VERSION_CONFLICT", "version conflict", { current: r.version });
    return r;
  }

  private decideRequest(
    id: string,
    version: number,
    state: task.TaskRequestState,
    reason: string | null,
  ): task.TaskRequest {
    const r = this.requirePending(id, version);
    const now = new Date().toISOString();
    const updated: task.TaskRequest = {
      ...r,
      state,
      ...(reason !== null ? { declineReason: reason } : {}),
      version: r.version + 1,
      decidedAt: now,
      updatedAt: now,
    };
    this.requestsById.set(id, updated);
    return updated;
  }

  private listCrossLinks(eventId: string): task.TaskCrossLink[] {
    return this.crossLinks.filter((c) => (c.eventId ?? null) === eventId);
  }

  // ---- gantt handlers ----
  private ganttRows(eventId: string): gantt.GanttRow[] {
    const parents = this.parentIdsWithChildren();
    return [...this.taskById.values()]
      .filter((t) => t.eventId === eventId && t.archivedAt === null)
      .map((t): gantt.GanttRow => {
        const h = this.hierarchy[t.id];
        // Mirror gantt-service dto.toRow: a work-package (hasChildren) row carries NO own
        // dates — the read model returns startsAt/endsAt null and the client rolls the span
        // up from the children. The mock previously echoed a parent's stored rowDates, so a
        // parent bar resize appeared to persist in dev but was DISCARDED in prod on the next
        // GET, and the parent's detail 開始/終了 looked populated in dev while blank in prod.
        // Null the parent here so dev/tests reproduce prod exactly (the client rolls the
        // span/detail dates up from the children).
        const isParent = parents.has(t.id);
        const schedule = isParent
          ? { startsAt: null, endsAt: null }
          : deriveSchedule(t, this.rowDates[t.id]);
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
    // Persist onto the task's real columns so list/detail views + a cache-bypassing
    // refetch stay consistent (startsAt→startAt, endsAt→dueAt), matching the server.
    this.taskById.set(taskId, {
      ...t,
      startAt: body.startsAt,
      ...(body.endsAt ? { dueAt: body.endsAt } : {}),
      updatedAt: new Date().toISOString(),
    });
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
    // Mirror gantt-service's normalize: orderedTaskIds is additive/optional and only
    // attached when non-empty, so the manual drag order round-trips (mock parity).
    const ordered = Array.isArray(body.orderedTaskIds)
      ? body.orderedTaskIds.filter((x): x is common.TaskId => typeof x === "string")
      : [];
    this.view = {
      eventId: eventId as common.EventId,
      zoom: body.zoom,
      collapsedTaskIds: body.collapsedTaskIds,
      ...(ordered.length > 0 ? { orderedTaskIds: ordered } : {}),
    };
    return this.view;
  }

  // ---- identity ----
  // Two modes, mirroring the real GET /identity/users:
  //   - `?ids=a,b`  → resolve exactly those users (name-batch resolve).
  //   - no ids      → roster list (all members), honouring `q` search + `limit`.
  // The old ids-only version returned [] for a roster query, so the assignee
  // dropdown could only ever show "未割当" on a fresh event (bug 1b).
  private listUsers(query: Record<string, string | number | boolean | undefined>): common.Paginated<identity.UserSummary> {
    const idsCsv = query.ids !== undefined ? String(query.ids) : undefined;
    if (idsCsv !== undefined) {
      const ids = idsCsv ? idsCsv.split(",") : [];
      const items = ids.map((id) => this.users.get(id)).filter((u): u is identity.UserSummary => u !== undefined);
      return { items, nextCursor: null };
    }
    let items = [...this.users.values()];
    if (query.q) {
      const needle = String(query.q).toLowerCase();
      items = items.filter((u) => u.displayName.toLowerCase().includes(needle));
    }
    const limit = query.limit ? Number(query.limit) : 200;
    return { items: items.slice(0, limit), nextCursor: null };
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
  const dur = DURATION_DAYS_BY_PRIORITY[t.priority] * MS_PER_DAY;
  // Real dates win (PR-C): both explicit ⇒ exact span; else derive from whichever is set.
  if (t.startAt && t.dueAt) return { startsAt: t.startAt, endsAt: t.dueAt };
  if (t.dueAt) return { startsAt: new Date(Date.parse(t.dueAt) - dur).toISOString(), endsAt: t.dueAt };
  if (t.startAt) return { startsAt: t.startAt, endsAt: new Date(Date.parse(t.startAt) + dur).toISOString() };
  return { startsAt: null, endsAt: null };
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
