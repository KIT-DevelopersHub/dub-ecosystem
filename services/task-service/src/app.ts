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
import type { task, common, auditLog } from "@dub/types";
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

const TASK_ID_PREFIX = "task_";

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
    if (!id.startsWith(TASK_ID_PREFIX)) throw taskErrors.notFound(id);
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
    if (!id.startsWith(TASK_ID_PREFIX)) throw taskErrors.notFound(id);
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
    for (const f of ["title", "description", "priority", "dueAt"] as const) {
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
    if (!id.startsWith(TASK_ID_PREFIX)) throw taskErrors.notFound(id);

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
    if (!id.startsWith(TASK_ID_PREFIX)) throw taskErrors.notFound(id);
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
    if (!id.startsWith(TASK_ID_PREFIX)) throw taskErrors.notFound(id);
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
    if (!id.startsWith(TASK_ID_PREFIX)) throw taskErrors.notFound(id);
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
    if (!id.startsWith(TASK_ID_PREFIX)) throw taskErrors.notFound(id);
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
    const liveIds = await deps.repo.listLiveTaskIdsByEvent(bucket);
    const liveSet = new Set(liveIds);
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

  return app;
}
