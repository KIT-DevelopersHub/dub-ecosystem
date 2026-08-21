// task-service HTTP surface (Hono). Built from injected Deps so it is fully
// testable without the Cloudflare runtime. Routes + guards follow the P0a design
// and the FROZEN @dub/types task namespace + P0b decisions (themes 1/3/6/9/13).
import { Hono } from "hono";
import type { Context } from "hono";
import { dubErrorHandler, errors, type FieldError } from "@dub/errors";
import { extractContext, type RequestContext } from "@dub/http";
import { newId, nowIso } from "@dub/db";
import { HEADERS } from "@dub/observability";
import type { DubEventEnvelope } from "@dub/events";
import type { common, auditLog } from "@dub/types";
// value import: needs the runtime DEPENDENCY_REJECT_REASONS constant (also gives the
// `task.*` types). Mirrors validate.ts using `task.TASK_STATUS_TRANSITIONS`.
import { task } from "@dub/types";
import type { Deps } from "./deps";
import { taskErrors } from "./errors";
import { resolvePrincipal, isServiceRole, actorIdOf, type Principal } from "./principal";
import { emit, type EventSpec } from "./events";
import { dispatchEvent } from "./consumer";
import { validateDependencies } from "@dub/gantt-calc";
import {
  assertStatusTransition,
  checkTitle,
  checkIso,
  checkPriority,
  checkStatusValue,
  checkOptString,
  normalizeLimit,
  assertValid,
  PROTECTED_ORIGIN_FIELDS,
} from "./validate";
import { decodeCursor, type ListFilter } from "./repo";

function ctxOf(c: Context): RequestContext {
  return extractContext(c.req.raw.headers, { allowGenerate: true });
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

function auditRecord(
  action: string,
  actorId: string | null,
  orgId: string,
  requestId: string,
  resourceId: string,
  details: Record<string, unknown> | null,
): auditLog.AuditRecordInput {
  return {
    action,
    actorId,
    orgId,
    result: "success",
    resourceType: "task",
    resourceId,
    details,
    requestId,
    occurredAt: nowIso(),
  };
}

export function buildApp(deps: Deps): Hono {
  const app = new Hono();
  app.onError(dubErrorHandler({ service: "task-service" }));

  const { config } = deps;

  const principalOf = (c: Context): Principal => resolvePrincipal(c, config.serviceCallers);

  app.get("/health", (c) => c.json({ ok: true, service: "task-service" }));

  // ---- internal-only guard: /internal/* requires the x-dub-internal marker.
  // Mirrors the gateway internalOnlyPaths 404 (never expose the compensation route
  // publicly). Same pattern as audit-log /internal/*. ----
  app.use("/internal/*", async (c, next) => {
    if (!c.req.header(HEADERS.internal)) throw errors.notFound("route", c.req.path);
    await next();
  });

  // ---- POST /internal/events-async (free-tier consumer landing route) ----
  // Free-plan replacement for the dub-q-evt-task Queue consumer: event-service's own
  // @dub/freeq drain POSTs each due event.archived envelope here. Runs the SAME
  // compensation + envelope.id idempotency as the Queue path (dispatchEvent). A non-2xx
  // response tells the caller's drain to retry, so an event is never lost. task-service
  // does NOT call event-service back, so no event↔task cycle is reintroduced.
  app.post("/internal/events-async", async (c) => {
    const body = await readJson<Partial<DubEventEnvelope>>(c);
    if (!body || typeof body.name !== "string" || typeof body.id !== "string") {
      throw errors.validationFailed([{ field: "body", reason: "invalid_envelope" }]);
    }
    await dispatchEvent(deps, body as DubEventEnvelope);
    return c.json({ ok: true }, 202);
  });

  // ---- GET /tasks/dependencies (LITERAL route registered before :id) ----
  app.get("/tasks/dependencies", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:read");
    const eventId = c.req.query("eventId");
    if (!eventId) throw errors.validationFailed([{ field: "eventId", reason: "required" }]);
    const items = await deps.repo.listDependenciesByEvent(eventId);
    // ListDependenciesResponse: edge id/type/lagDays are NOT here (frozen) — gantt
    // composes those. Shape is { items: TaskDependency[] }.
    const res: { items: task.TaskDependency[] } = { items };
    return c.json(res);
  });

  // ---- GET /tasks/cross-links (LITERAL route registered before :id) ----
  // The event's arrow-less cross-team links (送る・受け取る). Same wire shape as
  // /tasks/dependencies; gantt/My Tasks read this to badge rows「お願いした/受け負った」
  // WITHOUT drawing an arrow (these never enter task_dependencies / CPM).
  app.get("/tasks/cross-links", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:read");
    const eventId = c.req.query("eventId");
    if (!eventId) throw errors.validationFailed([{ field: "eventId", reason: "required" }]);
    const items = await deps.repo.listCrossLinksByEvent(eventId);
    const res: task.ListTaskCrossLinksResponse = { items };
    return c.json(res);
  });

  // ---- GET /tasks (list; cursor paging) ----
  app.get("/tasks", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:read");

    const eventId = c.req.query("eventId");
    const assigneeId = c.req.query("assigneeId");
    const teamId = c.req.query("teamId");
    const createdById = c.req.query("createdById");
    const includeArchived = c.req.query("includeArchived") === "true";
    if (includeArchived) await deps.authz.require(ctx, principal, "task:delete");

    // eventId may be omitted by: (a) a service-role caller (e.g. gantt-service building
    // a global chart, github-sync) — trusted internal reads; or (b) a user listing their
    // OWN tasks — assigned to them (担当) or issued by them (依頼), which scope to self so
    // the "My Tasks" hub never leaks other people's lists. Since tasks may be unlinked to
    // any event (判断44), a bare `GET /tasks` from a user for someone else is still gated.
    if (!eventId && !isServiceRole(principal)) {
      const isSelf =
        principal.kind === "user" &&
        (assigneeId === principal.userId || createdById === principal.userId);
      if (!isSelf) throw errors.validationFailed([{ field: "assigneeId", reason: "required" }]);
    }

    const statusRaw = (c.req.queries("status") ?? []).flatMap((s) => s.split(",")).filter(Boolean);
    const fe: FieldError[] = [];
    for (const s of statusRaw) checkStatusValue(s, fe);
    assertValid(fe);

    const cursorRaw = c.req.query("cursor");
    const filter: ListFilter = {
      includeArchived,
      limit: normalizeLimit(c.req.query("limit")),
      ...(eventId ? { eventId } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(createdById ? { createdById } : {}),
      ...(statusRaw.length > 0 ? { statuses: statusRaw as task.TaskStatus[] } : {}),
      ...(cursorRaw ? { cursorId: decodeCursor(cursorRaw) } : {}),
    };
    const page = await deps.repo.list(filter);
    const res: task.ListTasksResponse = { items: page.items, nextCursor: page.nextCursor };
    return c.json(res);
  });

  // ---- POST /tasks (create) ----
  app.post("/tasks", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const body = await readJson<Partial<task.CreateTaskRequest>>(c);

    const fe: FieldError[] = [];
    checkTitle(body.title, fe);
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      fe.push({ field: "description", reason: "invalid_type" });
    }
    checkPriority(body.priority, fe);
    checkIso(body.startAt, "startAt", fe);
    checkIso(body.dueAt, "dueAt", fe);
    if (body.assigneeId !== undefined && typeof body.assigneeId !== "string") {
      fe.push({ field: "assigneeId", reason: "invalid_type" });
    }
    checkOptString(body.teamId, "teamId", fe);
    checkOptString(body.parentTaskId, "parentTaskId", fe);
    checkOptString(body.wbs, "wbs", fe);
    // eventId is now OPTIONAL (判断44). If present it must be a string; when omitted the
    // task is issued unlinked to any event. Only validate against event-service when set.
    if (body.eventId !== undefined && body.eventId !== null && typeof body.eventId !== "string") {
      fe.push({ field: "eventId", reason: "invalid_type" });
    }
    // origin is service-role only; a normal client specifying it is a 400.
    if (body.origin !== undefined && !isServiceRole(principal)) {
      fe.push({ field: "origin", reason: "not_allowed", message: "origin is service-role only" });
    }
    assertValid(fe);

    const eventId: common.EventId | null = body.eventId ?? null;
    if (eventId) {
      const ref = await deps.eventClient.getEvent(ctx, eventId);
      if (!ref) throw taskErrors.eventNotFound(eventId);
      if (ref.archivedAt) throw taskErrors.eventArchived(eventId);
    }

    if (body.assigneeId) {
      const exists = await deps.identity.userExists(ctx, body.assigneeId);
      if (!exists) throw errors.validationFailed([{ field: "assigneeId", reason: "not_found" }]);

      // D4 (ADR-0007): a task must not be assigned directly to someone on another team —
      // that would bypass the request/approval flow (送る・受け取る). This guard fires ONLY
      // when the task HAS a team (team_id non-null) AND the assignee's teams are KNOWN and
      // do NOT include it. Teamless tasks (team_id=null) and assignees whose teams are
      // unresolvable (no linked member ⇒ []) pass through unchanged — back-compat.
      const teamId = body.teamId ?? null;
      if (teamId) {
        const assigneeTeams = await deps.member.teamsOfUser(ctx, body.assigneeId);
        if (assigneeTeams.length > 0 && !assigneeTeams.includes(teamId)) {
          throw taskErrors.crossTeamAssignee(body.assigneeId, teamId);
        }
      }
    }

    // 親子は同一チーム: 親を指定して作る子タスクは、親と同じチームでなければならない（親から
    // 作る導線はチームを親に固定する。整合はサーバでも担保）。null=未割当同士は一致。親が存在
    // しないときは比較対象がないので素通し（既存の後方互換）。
    const parentTaskId = body.parentTaskId ?? null;
    if (parentTaskId) {
      const parent = await deps.repo.getById(parentTaskId);
      if (parent) {
        const childTeam = body.teamId ?? null;
        const parentTeam = parent.teamId ?? null;
        if (childTeam !== parentTeam) throw taskErrors.parentChildTeamMismatch(parentTeam, childTeam);
      }
    }

    const now = nowIso();
    const id = newId("task");
    const actorId = actorIdOf(principal);
    const created = await deps.repo.insert({
      id,
      eventId,
      title: body.title!,
      description: body.description ?? null,
      status: "todo",
      priority: body.priority ?? "medium",
      assigneeId: body.assigneeId ?? null,
      teamId: body.teamId ?? null,
      parentId: body.parentTaskId ?? null,
      wbs: body.wbs ?? null,
      startAt: body.startAt ?? null,
      dueAt: body.dueAt ?? null,
      origin: (isServiceRole(principal) ? body.origin : undefined) ?? "internal",
      createdBy: actorId,
      now,
    });

    const evt = eventId ? { eventId } : {};
    const specs: EventSpec[] = [{ name: "task.created", payload: { taskId: id, ...evt } }];
    if (created.assigneeId) {
      specs.push({ name: "task.assigned", payload: { taskId: id, ...evt, assigneeId: created.assigneeId } });
    }
    await emit(deps.events, { requestId: ctx.requestId, actorId }, specs);

    return c.json(created, 201);
  });

  // ---- GET /tasks/:id ----
  app.get("/tasks/:id", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:read");
    const id = c.req.param("id");
    const found = await deps.repo.getById(id);
    if (!found) throw taskErrors.notFound(id);
    return c.json(found);
  });

  // ---- PATCH /tasks/:id (partial update; optimistic lock) ----
  app.patch("/tasks/:id", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const id = c.req.param("id");
    const body = await readJson<Partial<task.UpdateTaskRequest>>(c);

    if (typeof body.version !== "number") {
      throw errors.validationFailed([{ field: "version", reason: "required" }]);
    }
    const fe: FieldError[] = [];
    if (body.title !== undefined) checkTitle(body.title, fe);
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      fe.push({ field: "description", reason: "invalid_type" });
    }
    checkPriority(body.priority, fe);
    checkStatusValue(body.status, fe);
    checkIso(body.startAt, "startAt", fe);
    checkIso(body.dueAt, "dueAt", fe);
    if (body.assigneeId !== undefined && body.assigneeId !== null && typeof body.assigneeId !== "string") {
      fe.push({ field: "assigneeId", reason: "invalid_type" });
    }
    checkOptString(body.teamId, "teamId", fe);
    checkOptString(body.parentTaskId, "parentTaskId", fe);
    checkOptString(body.wbs, "wbs", fe);
    assertValid(fe);

    const current = await deps.repo.getById(id);
    if (!current) throw taskErrors.notFound(id);
    if (body.version !== current.version) throw taskErrors.versionConflict();

    // origin=github protection (non-service principals cannot write protected fields).
    if (current.origin === "github" && !isServiceRole(principal)) {
      const violated: string[] = [];
      if (body.title !== undefined && body.title !== current.title) violated.push("title");
      if (body.description !== undefined && body.description !== current.description) violated.push("description");
      if (body.status !== undefined && body.status !== current.status) violated.push("status");
      if (body.priority !== undefined && body.priority !== current.priority) violated.push("priority");
      if (body.assigneeId !== undefined && body.assigneeId !== current.assigneeId) violated.push("assigneeId");
      if (body.dueAt !== undefined && body.dueAt !== current.dueAt) violated.push("dueAt");
      const blocked = violated.filter((f) => PROTECTED_ORIGIN_FIELDS.includes(f));
      if (blocked.length > 0) throw taskErrors.githubOriginReadonly(blocked);
    }

    // status transition (only when it actually changes).
    const statusChanged = body.status !== undefined && body.status !== current.status;
    if (statusChanged) assertStatusTransition(current.status, body.status!);

    // assignee existence when set to a concrete user.
    const assigneeChanged = body.assigneeId !== undefined && body.assigneeId !== current.assigneeId;
    if (assigneeChanged && body.assigneeId) {
      const exists = await deps.identity.userExists(ctx, body.assigneeId);
      if (!exists) throw errors.validationFailed([{ field: "assigneeId", reason: "not_found" }]);
    }

    // 親子は同一チーム (整合をサーバでも担保)。teamId か parentTaskId が変わるとき、このタスクと
    // その親・子のチームが食い違わないか検証する。null=未割当同士は一致。フロントは子作成時に
    // チームを親に固定し・子タスクのチーム欄をロックするが、直接APIや将来のクライアントに備えた門番。
    if (body.teamId !== undefined || body.parentTaskId !== undefined) {
      const nextTeam = (body.teamId !== undefined ? body.teamId : current.teamId) ?? null;
      const nextParentId = (body.parentTaskId !== undefined ? body.parentTaskId : current.parentTaskId) ?? null;
      // 親側: 付け替え先/現在の親と同一チームでなければならない。
      if (nextParentId) {
        const parent = await deps.repo.getById(nextParentId);
        if (parent && (parent.teamId ?? null) !== nextTeam) {
          throw taskErrors.parentChildTeamMismatch(parent.teamId ?? null, nextTeam);
        }
      }
      // 子側: このタスクの team 変更で子が別チームになるのを拒否（親のチーム変更で親子が食い違うのを防ぐ）。
      if (body.teamId !== undefined) {
        const childTeams = await deps.repo.liveChildrenTeams(id);
        const mismatch = childTeams.find((ct) => ct !== nextTeam);
        if (mismatch !== undefined) throw taskErrors.parentChildTeamMismatch(nextTeam, mismatch ?? null);
      }
    }

    // build patch (only provided keys).
    const patch: {
      title?: string;
      description?: string | null;
      status?: task.TaskStatus;
      priority?: task.TaskPriority;
      assigneeId?: common.UserId | null;
      teamId?: common.TeamId | null;
      parentId?: common.TaskId | null;
      wbs?: string | null;
      startAt?: common.ISODateTime | null;
      dueAt?: common.ISODateTime | null;
    } = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.status !== undefined) patch.status = body.status;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId;
    if (body.teamId !== undefined) patch.teamId = body.teamId;
    if (body.parentTaskId !== undefined) patch.parentId = body.parentTaskId;
    if (body.wbs !== undefined) patch.wbs = body.wbs;
    if (body.startAt !== undefined) patch.startAt = body.startAt;
    if (body.dueAt !== undefined) patch.dueAt = body.dueAt;

    if (Object.keys(patch).length === 0) return c.json(current); // version-only no-op

    const now = nowIso();
    const ok = await deps.repo.update(id, patch, body.version, now);
    if (!ok) throw taskErrors.versionConflict();
    const updated = await deps.repo.getById(id);
    if (!updated) throw taskErrors.notFound(id);

    // events (a single PATCH can raise several).
    const actorId = actorIdOf(principal);
    const evt = current.eventId ? { eventId: current.eventId } : {};
    const specs: EventSpec[] = [];
    const changed: string[] = [];
    for (const f of ["title", "description", "priority", "startAt", "dueAt"] as const) {
      if (patch[f] !== undefined && current[f] !== updated[f]) changed.push(f);
    }
    if (changed.length > 0) {
      specs.push({ name: "task.updated", payload: { taskId: id, ...evt, changed } });
    }
    if (statusChanged) {
      specs.push({
        name: "task.status_changed",
        payload: { taskId: id, ...evt, previousStatus: current.status, status: updated.status },
      });
    }
    if (assigneeChanged) {
      specs.push({
        name: "task.assigned",
        payload: { taskId: id, ...evt, assigneeId: updated.assigneeId },
      });
    }
    await emit(deps.events, { requestId: ctx.requestId, actorId }, specs);

    return c.json(updated);
  });

  // ---- DELETE /tasks/:id (soft delete = archive) ----
  app.delete("/tasks/:id", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:delete");
    const id = c.req.param("id");

    const current = await deps.repo.getById(id);
    if (!current) throw taskErrors.notFound(id);

    const now = nowIso();
    const ok = await deps.repo.archive(id, now);
    if (!ok) throw taskErrors.notFound(id);

    const actorId = actorIdOf(principal);
    const evt = current.eventId ? { eventId: current.eventId } : {};
    await emit(deps.events, { requestId: ctx.requestId, actorId }, [
      { name: "task.archived", payload: { taskId: id, ...evt } },
    ]);
    await deps.audit.record(
      auditRecord("task.task.archived", actorId, config.orgId, ctx.requestId, id, { eventId: current.eventId ?? null }),
    );

    const archived = await deps.repo.getById(id, true);
    return c.json(archived ?? { ok: true });
  });

  // ---- GET /tasks/:id/attachments (list a task's file/url attachments) ----
  app.get("/tasks/:id/attachments", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:read");
    const id = c.req.param("id");
    const found = await deps.repo.getById(id);
    if (!found) throw taskErrors.notFound(id);
    const items = await deps.repo.listAttachments(id);
    const res: task.ListTaskAttachmentsResponse = { items };
    return c.json(res);
  });

  // ---- POST /tasks/:id/attachments (attach a file's meta or an external URL) ----
  // The file BLOB lives in file-meta/R2 (uploaded by the client via POST /files);
  // here we persist only the task↔attachment index + display meta. `url` is the
  // file-meta download path (kind=file) or the external URL (kind=url).
  app.post("/tasks/:id/attachments", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const id = c.req.param("id");
    const found = await deps.repo.getById(id);
    if (!found) throw taskErrors.notFound(id);

    const body = await readJson<Partial<task.CreateTaskAttachmentRequest>>(c);
    const fe: FieldError[] = [];
    if (body.kind !== "file" && body.kind !== "url") fe.push({ field: "kind", reason: "invalid_type" });
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 300) {
      fe.push({ field: "name", reason: "required" });
    }
    if (typeof body.url !== "string" || body.url.length === 0) fe.push({ field: "url", reason: "required" });
    else if (body.kind === "url" && !/^https?:\/\//i.test(body.url)) fe.push({ field: "url", reason: "invalid_url" });
    if (body.fileId !== undefined && typeof body.fileId !== "string") fe.push({ field: "fileId", reason: "invalid_type" });
    if (body.mimeType !== undefined && typeof body.mimeType !== "string") fe.push({ field: "mimeType", reason: "invalid_type" });
    if (body.sizeBytes !== undefined && (typeof body.sizeBytes !== "number" || body.sizeBytes < 0)) {
      fe.push({ field: "sizeBytes", reason: "invalid_type" });
    }
    assertValid(fe);

    const now = nowIso();
    const actorId = actorIdOf(principal);
    const created = await deps.repo.addAttachment({
      id: newId("tatt"),
      taskId: id,
      kind: body.kind!,
      name: body.name!.trim(),
      url: body.url!,
      fileId: body.fileId ?? null,
      mimeType: body.mimeType ?? null,
      sizeBytes: body.sizeBytes ?? null,
      createdBy: actorId,
      now,
    });
    return c.json(created, 201);
  });

  // ---- DELETE /tasks/:id/attachments/:attachmentId (soft-remove) ----
  app.delete("/tasks/:id/attachments/:attachmentId", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const id = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    const ok = await deps.repo.archiveAttachment(id, attachmentId, nowIso());
    if (!ok) throw taskErrors.notFound(attachmentId);
    return c.json({ ok: true });
  });

  // ---- PUT /tasks/:id/dependencies (full replace; cycle-checked) ----
  app.put("/tasks/:id/dependencies", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const id = c.req.param("id");
    const body = await readJson<Partial<task.ReplaceDependenciesRequest>>(c);

    if (typeof body.version !== "number") {
      throw errors.validationFailed([{ field: "version", reason: "required" }]);
    }
    if (!Array.isArray(body.dependsOnIds) || body.dependsOnIds.some((x) => typeof x !== "string")) {
      throw errors.validationFailed([{ field: "dependsOnIds", reason: "invalid_type" }]);
    }
    const dependsOnIds = [...new Set(body.dependsOnIds)];
    if (dependsOnIds.includes(id)) {
      throw errors.validationFailed([{ field: "dependsOnIds", reason: "self_dependency" }]);
    }

    const current = await deps.repo.getById(id);
    if (!current) throw taskErrors.notFound(id);
    if (body.version !== current.version) throw taskErrors.versionConflict();

    // Single-engine dependency validation via @dub/gantt-calc. taskIds = the live
    // tasks of this bucket (existence + same-bucket + non-archived in one set): any
    // dependsOnId outside it surfaces as unknownTaskIds (4xx). The bucket is the task's
    // event, or the unlinked bucket (event_id IS NULL) when the task has no event. The
    // graph is the bucket's edges with this task's swapped for the requested ones (409
    // on cycle).
    const bucket = current.eventId ?? null;
    const bucketTasks = await deps.repo.listLiveTasksByEvent(bucket);
    const liveIds = bucketTasks.map((t) => t.id);
    const liveSet = new Set(liveIds);

    // Team gate (ADR-0007): a dependency (arrow) may only join tasks of the SAME team.
    // `team_id === null` counts as its own "no team" bucket, so two teamless tasks may
    // still depend (back-compat); a one-sided null is a mismatch. Cross-team links go
    // through the 送る・受け取る request/approval flow instead — never a dependency arrow.
    // We only flag candidates that exist in this bucket; unknown ids fall through to the
    // gantt-calc `unknownTaskIds` check below (so they surface as unknown_task_ref).
    const teamOf = new Map(bucketTasks.map((t) => [t.id, t.teamId ?? null]));
    const currentTeam = current.teamId ?? null;
    const crossTeamIds = dependsOnIds.filter(
      (dep) => liveSet.has(dep) && teamOf.get(dep) !== currentTeam,
    );
    if (crossTeamIds.length > 0) {
      throw errors.validationFailed(
        crossTeamIds.map((dep) => ({
          field: "dependsOnIds",
          reason: task.DEPENDENCY_REJECT_REASONS.crossTeamNotAllowed,
          message: `cross-team dependency not allowed: ${dep}`,
        })),
      );
    }

    const dependencies: task.TaskDependency[] = (await deps.repo.listDependenciesByEvent(bucket))
      .filter((e) => e.taskId !== id && liveSet.has(e.taskId) && liveSet.has(e.dependsOnId))
      .concat(dependsOnIds.map((dep) => ({ taskId: id, dependsOnId: dep })));
    const verdict = validateDependencies({ taskIds: liveIds, dependencies });
    if (verdict.unknownTaskIds.length > 0) {
      throw errors.validationFailed(
        verdict.unknownTaskIds.map((dep) => ({
          field: "dependsOnIds",
          reason: "unknown_task_ref",
          message: `unknown, cross-event, or archived task: ${dep}`,
        })),
      );
    }
    if (verdict.cycles.length > 0) throw taskErrors.dependencyCycle({ cycles: verdict.cycles });

    const now = nowIso();
    const result = await deps.repo.replaceDependencies(id, dependsOnIds, body.version, now);
    if (!result.ok) throw taskErrors.versionConflict();

    const actorId = actorIdOf(principal);
    const evt = current.eventId ? { eventId: current.eventId } : {};
    await emit(deps.events, { requestId: ctx.requestId, actorId }, [
      {
        name: "task.dependency_changed",
        payload: { taskId: id, ...evt, added: result.added, removed: result.removed },
      },
    ]);
    await deps.audit.record(
      auditRecord("task.dependency.replaced", actorId, config.orgId, ctx.requestId, id, {
        eventId: current.eventId ?? null,
        added: result.added,
        removed: result.removed,
      }),
    );

    return c.json({ taskId: id, dependsOnIds });
  });

  // ---- POST /task-requests (send / 送る) ----
  // Issue a task request. The server (never the client) resolves the destination's
  // team membership and branches (ADR-0007): self / same-team → a task is created
  // immediately (D1, {kind:"task"}); other team → a pending TaskRequest is created and
  // the receiver is notified ({kind:"request"}).
  app.post("/task-requests", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    // Issuing is a human action — the requester is the "from". A service principal has
    // no identity to route by, so it cannot issue a request.
    if (principal.kind !== "user") {
      throw errors.validationFailed([{ field: "toUserId", reason: "requester_must_be_user" }]);
    }
    const fromUserId = principal.userId;
    const body = await readJson<Partial<task.IssueTaskRequestBody>>(c);

    const fe: FieldError[] = [];
    if (typeof body.toUserId !== "string" || body.toUserId.length === 0) {
      fe.push({ field: "toUserId", reason: "required" });
    }
    checkTitle(body.title, fe);
    checkPriority(body.priority, fe);
    checkIso(body.dueAt, "dueAt", fe);
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      fe.push({ field: "description", reason: "invalid_type" });
    }
    checkOptString(body.targetTeamId, "targetTeamId", fe);
    checkOptString(body.sourceTaskId, "sourceTaskId", fe);
    if (body.eventId !== undefined && body.eventId !== null && typeof body.eventId !== "string") {
      fe.push({ field: "eventId", reason: "invalid_type" });
    }
    assertValid(fe);

    const toUserId = body.toUserId!;
    const eventId: common.EventId | null = body.eventId ?? null;
    if (eventId) {
      const ref = await deps.eventClient.getEvent(ctx, eventId);
      if (!ref) throw taskErrors.eventNotFound(eventId);
      if (ref.archivedAt) throw taskErrors.eventArchived(eventId);
    }
    if (!(await deps.identity.userExists(ctx, toUserId))) {
      throw errors.validationFailed([{ field: "toUserId", reason: "not_found" }]);
    }

    // Server-side self/other-team decision. A client-supplied team hint is UX-only and
    // never trusted — the branch is decided here from member-service memberships.
    const fromTeams = await deps.member.teamsOfUser(ctx, fromUserId);
    const toTeams = toUserId === fromUserId ? fromTeams : await deps.member.teamsOfUser(ctx, toUserId);
    const shared = fromTeams.filter((t) => toTeams.includes(t));
    const sameTeam = toUserId === fromUserId || shared.length > 0;

    const now = nowIso();
    const priority = body.priority ?? "medium";

    if (sameTeam) {
      // D1: self / same-team → materialise a normal task now (no approval). The existing
      // task.created/task.assigned events drive gantt + My Tasks sync (no new event).
      const teamId: common.TeamId | null = body.targetTeamId ?? shared[0] ?? fromTeams[0] ?? null;
      const id = newId("task");
      const created = await deps.repo.insert({
        id,
        eventId,
        title: body.title!,
        description: body.description ?? null,
        status: "todo",
        priority,
        assigneeId: toUserId,
        teamId,
        parentId: null,
        wbs: null,
        startAt: null,
        dueAt: body.dueAt ?? null,
        origin: "internal",
        createdBy: fromUserId,
        now,
      });
      const evt = eventId ? { eventId } : {};
      const specs: EventSpec[] = [
        { name: "task.created", payload: { taskId: id, ...evt } },
        { name: "task.assigned", payload: { taskId: id, ...evt, assigneeId: toUserId } },
      ];
      await emit(deps.events, { requestId: ctx.requestId, actorId: fromUserId }, specs);
      await deps.audit.record(
        auditRecord("task.request.materialized", fromUserId, config.orgId, ctx.requestId, id, {
          toUserId,
          teamId,
          via: toUserId === fromUserId ? "self" : "same_team",
        }),
      );
      const res: task.IssueTaskRequestResponse = { kind: "task", task: created };
      return c.json(res, 201);
    }

    // Other team → pending request; a task only materialises when the receiver accepts.
    const id = newId("treq");
    const request = await deps.repo.insertRequest({
      id,
      eventId,
      fromUserId,
      toUserId,
      fromTeamId: fromTeams[0] ?? null,
      toTeamId: body.targetTeamId ?? toTeams[0] ?? null,
      title: body.title!,
      description: body.description ?? null,
      priority,
      dueAt: body.dueAt ?? null,
      sourceTaskId: body.sourceTaskId ?? null,
      now,
    });
    await emit(deps.events, { requestId: ctx.requestId, actorId: fromUserId }, [
      { name: "task.request.created", payload: { requestId: id, fromUserId, toUserId, ...(eventId ? { eventId } : {}) } },
    ]);
    await deps.audit.record(
      auditRecord("task.request.created", fromUserId, config.orgId, ctx.requestId, id, {
        toUserId,
        eventId: eventId ?? null,
      }),
    );
    const res: task.IssueTaskRequestResponse = { kind: "request", request };
    return c.json(res, 201);
  });

  // ---- GET /task-requests (my incoming / outgoing) ----
  app.get("/task-requests", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:read");
    // incoming/outgoing are self-scoped ("my" requests), so a caller identity is required.
    if (principal.kind !== "user") {
      throw errors.validationFailed([{ field: "box", reason: "requires_user" }]);
    }
    const box = c.req.query("box");
    if (box !== "incoming" && box !== "outgoing") {
      throw errors.validationFailed([{ field: "box", reason: "required" }]);
    }
    const statesRaw = (c.req.queries("state") ?? []).flatMap((s) => s.split(",")).filter(Boolean);
    const valid = new Set<task.TaskRequestState>(["pending", "accepted", "declined", "cancelled"]);
    const fe: FieldError[] = [];
    for (const s of statesRaw) if (!valid.has(s as task.TaskRequestState)) fe.push({ field: "state", reason: "invalid" });
    assertValid(fe);

    const eventId = c.req.query("eventId");
    const cursorRaw = c.req.query("cursor");
    const page = await deps.repo.listRequests({
      box,
      userId: principal.userId,
      limit: normalizeLimit(c.req.query("limit")),
      ...(statesRaw.length > 0 ? { states: statesRaw as task.TaskRequestState[] } : {}),
      ...(eventId ? { eventId } : {}),
      ...(cursorRaw ? { cursorId: decodeCursor(cursorRaw) } : {}),
    });
    const res: task.ListTaskRequestsResponse = { items: page.items, nextCursor: page.nextCursor };
    return c.json(res);
  });

  // ---- GET /task-requests/:id ----
  app.get("/task-requests/:id", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:read");
    const id = c.req.param("id");
    const found = await deps.repo.getRequestById(id);
    if (!found) throw taskErrors.requestNotFound(id);
    // Only the two participants (requester / receiver) may read a request; to anyone else
    // it is 404 (never leak its existence). Service-role reads (mobile-bff) are trusted.
    if (principal.kind === "user" && principal.userId !== found.fromUserId && principal.userId !== found.toUserId) {
      throw taskErrors.requestNotFound(id);
    }
    return c.json(found);
  });

  // ---- POST /task-requests/:id/accept (受け取る) ----
  // The receiver accepts a pending cross-team request. This materialises BOTH sides:
  // the receiver's task ("受け負った"), the requester's tracking task ("お願いした" —
  // the request's sourceTaskId if given, else auto-generated per D3), and the arrow-less
  // cross-link joining them. Receiver-only (403) and pending-only (409, atomic).
  app.post("/task-requests/:id/accept", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const id = c.req.param("id");
    const body = await readJson<Partial<task.AcceptTaskRequestBody>>(c);

    const fe: FieldError[] = [];
    if (typeof body.version !== "number") fe.push({ field: "version", reason: "required" });
    checkOptString(body.targetTeamId, "targetTeamId", fe);
    assertValid(fe);

    const req = await deps.repo.getRequestById(id);
    if (!req) throw taskErrors.requestNotFound(id);
    // Only the receiver may accept.
    if (principal.kind === "user" && principal.userId !== req.toUserId) {
      throw taskErrors.requestForbiddenRole("accept");
    }
    if (req.state !== "pending") throw taskErrors.requestInvalidState(req.state, "accept");
    if (body.version !== req.version) throw taskErrors.versionConflict();

    const now = nowIso();
    const evt = req.eventId ? { eventId: req.eventId } : {};
    const toTeam: common.TeamId | null = body.targetTeamId ?? req.toTeamId ?? null;
    const actorId = actorIdOf(principal);
    const specs: EventSpec[] = [];

    // 1) Receiver task — the "受け負った" side (assignee = receiver, team = receiver team).
    const receiverTaskId = newId("task");
    const createdTask = await deps.repo.insert({
      id: receiverTaskId,
      eventId: req.eventId ?? null,
      title: req.title,
      description: req.description,
      status: "todo",
      priority: req.priority,
      assigneeId: req.toUserId,
      teamId: toTeam,
      parentId: null,
      wbs: null,
      startAt: null,
      dueAt: req.dueAt,
      origin: "internal",
      createdBy: req.fromUserId, // issued by the requester (powers the 依頼 lens)
      now,
    });
    specs.push({ name: "task.created", payload: { taskId: receiverTaskId, ...evt } });
    specs.push({ name: "task.assigned", payload: { taskId: receiverTaskId, ...evt, assigneeId: req.toUserId } });

    // 2) Requester tracking task — the "お願いした" side. Reuse sourceTaskId when the
    //    request came from a specific task, else auto-generate one (D3) so BOTH sides
    //    always have a task to badge.
    let requesterTaskId: common.TaskId;
    if (req.sourceTaskId) {
      requesterTaskId = req.sourceTaskId;
    } else {
      requesterTaskId = newId("task");
      await deps.repo.insert({
        id: requesterTaskId,
        eventId: req.eventId ?? null,
        title: req.title,
        description: req.description,
        status: "todo",
        priority: req.priority,
        assigneeId: req.fromUserId,
        teamId: req.fromTeamId ?? null,
        parentId: null,
        wbs: null,
        startAt: null,
        dueAt: req.dueAt,
        origin: "internal",
        createdBy: req.fromUserId,
        now,
      });
      specs.push({ name: "task.created", payload: { taskId: requesterTaskId, ...evt } });
      specs.push({ name: "task.assigned", payload: { taskId: requesterTaskId, ...evt, assigneeId: req.fromUserId } });
    }

    // 3) Arrow-less cross-link joining the two tasks (NOT a dependency).
    const crossLinkId = newId("txl");
    const crossLink = await deps.repo.insertCrossLink({
      id: crossLinkId,
      requestId: id,
      requesterTaskId,
      requesteeTaskId: receiverTaskId,
      eventId: req.eventId ?? null,
      now,
    });

    // 4) Atomic gate: pending→accepted with the version guard. A concurrent accept /
    //    stale version loses here (state is no longer pending) → 409.
    const moved = await deps.repo.decideRequest(
      id,
      { state: "accepted", createdTaskId: receiverTaskId, toTeamId: toTeam },
      req.version,
      now,
    );
    if (!moved) throw taskErrors.requestInvalidState("accepted", "accept");

    specs.push({
      name: "task.request.accepted",
      payload: { requestId: id, createdTaskId: receiverTaskId, sourceTaskId: requesterTaskId, ...evt },
    });
    specs.push({
      name: "task.cross_link.created",
      payload: { crossLinkId, requesterTaskId, requesteeTaskId: receiverTaskId, ...evt },
    });
    await emit(deps.events, { requestId: ctx.requestId, actorId }, specs);
    await deps.audit.record(
      auditRecord("task.request.accepted", actorId, config.orgId, ctx.requestId, id, {
        createdTaskId: receiverTaskId,
        requesterTaskId,
        crossLinkId,
      }),
    );

    const updated = await deps.repo.getRequestById(id);
    const res: task.AcceptTaskRequestResponse = { request: updated!, createdTask, crossLink };
    return c.json(res);
  });

  // ---- POST /task-requests/:id/decline (receiver rejects a pending request) ----
  app.post("/task-requests/:id/decline", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const id = c.req.param("id");
    const body = await readJson<Partial<task.DeclineTaskRequestBody>>(c);
    if (typeof body.version !== "number") {
      throw errors.validationFailed([{ field: "version", reason: "required" }]);
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      throw errors.validationFailed([{ field: "reason", reason: "invalid_type" }]);
    }
    const req = await deps.repo.getRequestById(id);
    if (!req) throw taskErrors.requestNotFound(id);
    if (principal.kind === "user" && principal.userId !== req.toUserId) {
      throw taskErrors.requestForbiddenRole("decline");
    }
    if (req.state !== "pending") throw taskErrors.requestInvalidState(req.state, "decline");
    if (body.version !== req.version) throw taskErrors.versionConflict();

    const now = nowIso();
    const actorId = actorIdOf(principal);
    const moved = await deps.repo.decideRequest(id, { state: "declined", declineReason: body.reason ?? null }, req.version, now);
    if (!moved) throw taskErrors.requestInvalidState("declined", "decline");
    const evt = req.eventId ? { eventId: req.eventId } : {};
    await emit(deps.events, { requestId: ctx.requestId, actorId }, [
      { name: "task.request.declined", payload: { requestId: id, ...evt } },
    ]);
    await deps.audit.record(
      auditRecord("task.request.declined", actorId, config.orgId, ctx.requestId, id, { eventId: req.eventId ?? null }),
    );
    return c.json((await deps.repo.getRequestById(id))!);
  });

  // ---- POST /task-requests/:id/cancel (requester withdraws a pending request) ----
  app.post("/task-requests/:id/cancel", async (c) => {
    const ctx = ctxOf(c);
    const principal = principalOf(c);
    await deps.authz.require(ctx, principal, "task:write");
    const id = c.req.param("id");
    const body = await readJson<Partial<task.CancelTaskRequestBody>>(c);
    if (typeof body.version !== "number") {
      throw errors.validationFailed([{ field: "version", reason: "required" }]);
    }
    const req = await deps.repo.getRequestById(id);
    if (!req) throw taskErrors.requestNotFound(id);
    // Only the requester may cancel their own request.
    if (principal.kind === "user" && principal.userId !== req.fromUserId) {
      throw taskErrors.requestForbiddenRole("cancel");
    }
    if (req.state !== "pending") throw taskErrors.requestInvalidState(req.state, "cancel");
    if (body.version !== req.version) throw taskErrors.versionConflict();

    const now = nowIso();
    const actorId = actorIdOf(principal);
    const moved = await deps.repo.decideRequest(id, { state: "cancelled" }, req.version, now);
    if (!moved) throw taskErrors.requestInvalidState("cancelled", "cancel");
    const evt = req.eventId ? { eventId: req.eventId } : {};
    await emit(deps.events, { requestId: ctx.requestId, actorId }, [
      { name: "task.request.cancelled", payload: { requestId: id, ...evt } },
    ]);
    await deps.audit.record(
      auditRecord("task.request.cancelled", actorId, config.orgId, ctx.requestId, id, { eventId: req.eventId ?? null }),
    );
    return c.json((await deps.repo.getRequestById(id))!);
  });

  return app;
}
