# Dub Task Service API Contract

Status: Component contract (v1). Read [`_conventions.md`](./_conventions.md) first for the
shared envelope, headers, error codes, pagination, IDs, and versioning; and
[`auth.md`](./auth.md) for authn/authz. This doc only adds what is **task-specific**: the
resource shape, the six endpoints, the status-transition machine, the origin-field
protection rule, the full-replace dependency graph with cycle detection, and the events /
audit records the service emits.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Task / request / response types, status-transition table | `packages/types/src/task.ts` |
| HTTP routes + guards | `services/task-service/src/app.ts` |
| Input validation | `services/task-service/src/validate.ts` |
| Service error codes | `services/task-service/src/errors.ts` |
| Emitted events + audit seam | `services/task-service/src/events.ts`, `packages/events/src/payloads.ts` |
| Queue consumer (`event.archived`) | `services/task-service/src/consumer.ts` |
| Due-soon cron | `services/task-service/src/scheduled.ts` |
| Principal / origin gating | `services/task-service/src/principal.ts` |

If code and this doc disagree, the code wins and this doc must be corrected.

---

## 1. Topology

task-service is an **internal** service (no public hostname). Two callers reach it:

| Caller | External path | Internal path | Auth carried in |
|---|---|---|---|
| `api-gateway` (web, FE4) | `/api/v1/tasks…` | `/tasks…` (prefix stripped) | `x-dub-user-id` (trusted; gateway verified the session) |
| `mo3-mobile-bff` (native) | `/m/v1/tasks…` | `/tasks…` | `x-dub-user-id` (trusted; BFF verified the bearer) |
| `github-sync` (service) | — | `/tasks…` | `x-dub-internal: 1` + `x-dub-caller: github-sync` |

The service **trusts** `x-dub-user-id` and does not re-verify tokens (`trustedHeader` mode).
A request with neither a trusted user header nor a valid internal service marker is
rejected `401 AUTH_INVALID_TOKEN` before any handler runs. All paths below are written in
their **external** `/api/v1` form; drop the prefix for the internal/service-binding form.

**Principal & actor:** a user principal comes from `x-dub-user-id`; a service principal from
`x-dub-internal: 1` + an allow-listed `x-dub-caller` (default allow-list: `github-sync`)
**with no** user header. The audit/event `actorId` is the `userId` for users and
`service:<caller>` for services (`service:github-sync`).

---

## 2. Resource shape

`task.Task` (`extends Versioned`). This is the exact `200`/`201` read body for every
single-task endpoint.

```json
{
  "id": "task_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "eventId": "evt_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "title": "Design the landing page",
  "description": "Hero + pricing section",
  "status": "in_progress",
  "priority": "high",
  "assigneeId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YB",
  "dueAt": "2026-08-20T09:00:00Z",
  "origin": "internal",
  "archivedAt": null,
  "createdAt": "2026-08-10T05:00:00Z",
  "updatedAt": "2026-08-12T11:30:00Z",
  "version": 3
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`task_` ULID) | Opaque. |
| `eventId` | string (`evt_` ULID) | Owning event; immutable after create. |
| `title` | string | 1..200 chars. |
| `description` | string \| null | Free text. |
| `status` | `TaskStatus` | `todo` \| `in_progress` \| `blocked` \| `done` \| `cancelled` (closed set). |
| `priority` | `TaskPriority` | `low` \| `medium` \| `high` \| `urgent`. Default `medium`. |
| `assigneeId` | string \| null | A user id, or null (unassigned). |
| `dueAt` | ISODateTime \| null | ISO-8601 UTC. |
| `origin` | `TaskOrigin` | `internal` \| `github`. See §5 protection. |
| `archivedAt` | ISODateTime \| null | Non-null once soft-deleted. |
| `createdAt` / `updatedAt` | ISODateTime | Server-set. |
| `version` | number | Optimistic-lock counter; send it back on every mutation. |

`TaskDependency` (composite-PK, owned solely by this service):
`{ "taskId": "task_…", "dependsOnId": "task_…" }`.

---

## 3. Endpoint map

| Method & path (external) | Permission | Success | Purpose |
|---|---|---|---|
| `GET /api/v1/tasks` | `task:read` (+`task:delete` if `includeArchived`) | `200` `Paginated<Task>` | List tasks in an event (or the caller's own). |
| `POST /api/v1/tasks` | `task:write` | `201` `Task` | Create a task. |
| `GET /api/v1/tasks/{id}` | `task:read` | `200` `Task` | Read one task. |
| `PATCH /api/v1/tasks/{id}` | `task:write` | `200` `Task` | Partial update (optimistic-locked). |
| `DELETE /api/v1/tasks/{id}` | `task:delete` | `200` `Task` | Soft-delete (archive). |
| `PUT /api/v1/tasks/{id}/dependencies` | `task:write` | `200` `{ taskId, dependsOnIds }` | Full-replace this task's dependency edges. |
| `GET /api/v1/tasks/dependencies` | `task:read` | `200` `{ items: TaskDependency[] }` | All dependency edges for an event. |

Permission is resolved via identity-roster `/authz/check` (see `auth.md` §10); a denied
key surfaces as `403 FORBIDDEN`. All mutations that carry a `version` follow the frozen
optimistic-lock rule (`_conventions.md` §6.3): a stale version → `409 TASK_VERSION_CONFLICT`.

---

## 4. Endpoints in detail

### 4.1 `GET /api/v1/tasks` — list

Cursor-paged (`_conventions.md` §5). Query params:

| Param | Type | Notes |
|---|---|---|
| `eventId` | string | Scopes to one event. **Required** unless listing your own tasks (see below). |
| `assigneeId` | string | Filter by assignee. |
| `status` | string | Repeatable and/or comma-separated: `?status=todo,blocked` or `?status=todo&status=blocked`. Each value must be a valid `TaskStatus`. |
| `includeArchived` | `"true"` | Include soft-deleted tasks. Requires `task:delete`. |
| `limit` | integer | Default 50, max 200. `>200` → `400 VALIDATION_FAILED` (`{ field: "limit", reason: "too_large" }`). |
| `cursor` | string (opaque) | Echo the previous `nextCursor`. |

**"My tasks" rule:** `eventId` may be omitted **only** when the caller is a user and
`assigneeId` equals their own `x-dub-user-id`. Any other omission →
`400 VALIDATION_FAILED` (`{ field: "eventId", reason: "required" }`).

Request:

```
GET /api/v1/tasks?eventId=evt_01J9Z...&status=todo,in_progress&limit=20
```

Response `200` (`ListTasksResponse = Paginated<Task>`):

```json
{
  "items": [
    {
      "id": "task_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
      "eventId": "evt_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
      "title": "Design the landing page",
      "description": null,
      "status": "todo",
      "priority": "medium",
      "assigneeId": null,
      "dueAt": null,
      "origin": "internal",
      "archivedAt": null,
      "createdAt": "2026-08-10T05:00:00Z",
      "updatedAt": "2026-08-10T05:00:00Z",
      "version": 1
    }
  ],
  "nextCursor": "eyJvIjoyMH0"
}
```

`nextCursor === null` means the end of the result set.

### 4.2 `POST /api/v1/tasks` — create

Request (`CreateTaskRequest`):

```json
{
  "eventId": "evt_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "title": "Wire the auth flow",
  "description": "OAuth PKCE start + callback",
  "priority": "high",
  "assigneeId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YB",
  "dueAt": "2026-08-20T09:00:00Z"
}
```

| Field | Required | Rule |
|---|---|---|
| `eventId` | yes | Must reference a live (non-archived) event. |
| `title` | yes | 1..200 chars. |
| `description` | no | string or null. |
| `priority` | no | Enum; default `medium`. |
| `assigneeId` | no | If present, must be an existing user. |
| `dueAt` | no | ISO-8601 UTC. |
| `origin` | no | **service-role only.** A non-service caller supplying it → `400` (`{ field: "origin", reason: "not_allowed" }`). Defaults to `internal`. |

New tasks start `status: "todo"`, `version: 1`, `archivedAt: null`. Response `201` is the
full `Task` body (§2). On success the service emits `task.created` (+`task.assigned` when
an assignee is set).

Errors: `TASK_EVENT_NOT_FOUND` (404) if the event does not exist;
`TASK_EVENT_ARCHIVED` (422) if the event is archived; `VALIDATION_FAILED` (400) for bad
input incl. `{ field: "assigneeId", reason: "not_found" }`.

### 4.3 `GET /api/v1/tasks/{id}` — read

Response `200` is the `Task` body. Unknown id, malformed id (not `task_`-prefixed), or an
archived task → `404 TASK_NOT_FOUND`.

### 4.4 `PATCH /api/v1/tasks/{id}` — partial update

Optimistic-locked partial update. **`version` is required**; only the keys you send are
touched. A version-only body (no changed fields) is a no-op that returns the current task.

Request (`UpdateTaskRequest`):

```json
{
  "version": 3,
  "status": "done",
  "priority": "urgent",
  "assigneeId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YB"
}
```

All content fields are optional; `description`, `assigneeId`, `dueAt` accept `null` to
clear. `status` is validated against the transition table (§5.1). `assigneeId`, when set to
a concrete user, must exist.

Response `200` is the updated `Task` (with `version` incremented). A single PATCH may emit
several events: `task.updated` (with `changed: string[]` for title/description/priority/dueAt),
`task.status_changed`, and/or `task.assigned`.

Errors, in the order they are checked:

| Situation | Code | HTTP |
|---|---|---|
| `version` missing / non-number | `VALIDATION_FAILED` (`{ field: "version", reason: "required" }`) | 400 |
| Bad field value | `VALIDATION_FAILED` | 400 |
| Task missing / archived | `TASK_NOT_FOUND` | 404 |
| `version` ≠ current | `TASK_VERSION_CONFLICT` | 409 |
| Writing a protected field on an `origin: "github"` task as a non-service caller | `TASK_GITHUB_ORIGIN_READONLY` | 422 |
| Illegal status transition | `TASK_INVALID_STATUS_TRANSITION` | 409 |
| `assigneeId` not an existing user | `VALIDATION_FAILED` (`{ field: "assigneeId", reason: "not_found" }`) | 400 |

### 4.5 `DELETE /api/v1/tasks/{id}` — soft delete

Archives the task (`archivedAt` set); it is not physically removed. Idempotent-ish:
deleting a missing/malformed id → `404 TASK_NOT_FOUND`. Response `200` returns the archived
`Task`. Emits `task.archived` and writes an audit record (`action: "task.task.archived"`).

### 4.6 `PUT /api/v1/tasks/{id}/dependencies` — full-replace edges

Replaces the **entire** set of "this task depends on …" edges in one call
(not add/remove deltas). Optimistic-locked on the task's `version`.

Request (`ReplaceDependenciesRequest`):

```json
{
  "version": 3,
  "dependsOnIds": [
    "task_01J9Z8Q0X7M3K2P5R8T1V4W6YC",
    "task_01J9Z8Q0X7M3K2P5R8T1V4W6YD"
  ]
}
```

Rules:

- `dependsOnIds` must be an array of task-id strings. Duplicates are de-duped server-side.
- A self-edge (`id` present in `dependsOnIds`) → `400 VALIDATION_FAILED`
  (`{ field: "dependsOnIds", reason: "self_dependency" }`).
- Every referenced task must be a **live task in the same event**. Any id that is unknown,
  cross-event, or archived → `400 VALIDATION_FAILED` with one `FieldError` per bad id
  (`reason: "unknown_task_ref"`).
- The resulting graph is validated for cycles by the single `@dub/gantt-calc`
  `validateDependencies` engine. A cycle → `409 TASK_DEPENDENCY_CYCLE`, `details` carrying
  `{ cycles: [...] }`.

Response `200`:

```json
{
  "taskId": "task_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "dependsOnIds": [
    "task_01J9Z8Q0X7M3K2P5R8T1V4W6YC",
    "task_01J9Z8Q0X7M3K2P5R8T1V4W6YD"
  ]
}
```

Emits `task.dependency_changed` (with `added` / `removed` id lists) and writes an audit
record (`action: "task.dependency.replaced"`).

### 4.7 `GET /api/v1/tasks/dependencies` — event edges

`eventId` query param is required (`400 VALIDATION_FAILED` `{ field: "eventId", reason:
"required" }` when absent). Returns every dependency edge in the event. Edge decoration
(`id` / `type` / `lagDays`) is **not** part of this payload — the gantt layer composes
those; the wire shape is the frozen `{ items: TaskDependency[] }`.

```json
{
  "items": [
    { "taskId": "task_01J9Z...Y9", "dependsOnId": "task_01J9Z...YC" },
    { "taskId": "task_01J9Z...Y9", "dependsOnId": "task_01J9Z...YD" }
  ]
}
```

---

## 5. Domain rules

### 5.1 Status transition machine

`status` is a closed enum; changes are validated against `TASK_STATUS_TRANSITIONS`. Setting
`status` to its current value is always a no-op (allowed). Any move not in the table →
`409 TASK_INVALID_STATUS_TRANSITION` (`details: { from, to }`).

| From | Allowed → |
|---|---|
| `todo` | `in_progress`, `blocked`, `done`, `cancelled` |
| `in_progress` | `todo`, `blocked`, `done`, `cancelled` |
| `blocked` | `todo`, `in_progress`, `cancelled` (reach `done` only via `in_progress`) |
| `done` | `in_progress` (reopen) |
| `cancelled` | `todo` (reopen) |

### 5.2 `origin: "github"` field protection

Tasks synced from GitHub carry `origin: "github"`. For those, a **non-service** caller may
not change any of the six protected fields — `title`, `description`, `status`, `priority`,
`assigneeId`, `dueAt`. Attempting to → `422 TASK_GITHUB_ORIGIN_READONLY` (`details: { fields:
[...] }`, the subset actually violated). Only the `github-sync` service role (via
`x-dub-internal` + `x-dub-caller: github-sync`) may edit them. `origin: "internal"` tasks
have no such restriction.

### 5.3 Optimistic locking

Every mutation body carries the `version` the client last read. On mismatch the write is
rejected `409 TASK_VERSION_CONFLICT` (no partial write). The client must re-read, re-apply,
and retry. Applies to web and mobile alike (no exceptions).

---

## 6. Task-specific error codes

Service codes (`_conventions.md` §3.2). Common codes (`VALIDATION_FAILED`,
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, …) behave per the foundation doc.

| Code | HTTP | `retryable` | When |
|---|---|---|---|
| `TASK_NOT_FOUND` | 404 | false | Unknown / malformed / archived task id. |
| `TASK_EVENT_NOT_FOUND` | 404 | false | `eventId` not found in event-service (`details: { eventId }`). |
| `TASK_VERSION_CONFLICT` | 409 | false | Optimistic-lock version mismatch. |
| `TASK_DEPENDENCY_CYCLE` | 409 | false | Requested edges would form a cycle (`details: { cycles }`). |
| `TASK_INVALID_STATUS_TRANSITION` | 409 | false | Status move not in the transition table (`details: { from, to }`). |
| `TASK_GITHUB_ORIGIN_READONLY` | 422 | false | Non-service write to a protected field on an `origin: "github"` task (`details: { fields }`). |
| `TASK_EVENT_ARCHIVED` | 422 | false | Create/mutate under an archived event (`details: { eventId }`). |

Always branch on `code` + HTTP status, never on `message` text (5xx messages are redacted).

---

## 7. Events emitted

The service publishes canonical event envelopes (`@dub/events` `createEvent`: ULID id,
`requestId`, `actorId`) onto the event queue. Every payload extends `TaskEventContext`
(`{ taskId, eventId }`).

| Event | Emitted when | Extra payload | Consumers |
|---|---|---|---|
| `task.created` | POST create | — | notification, github-sync, gantt, mobile-bff |
| `task.updated` | PATCH changed title/description/priority/dueAt | `changed: string[]` | github-sync, gantt, mobile-bff |
| `task.assigned` | Create/PATCH sets a (new) assignee | `assigneeId: string \| null` | notification, github-sync, gantt, mobile-bff |
| `task.status_changed` | PATCH changes status | `previousStatus`, `status` | notification, github-sync, gantt, mobile-bff |
| `task.archived` | DELETE (soft delete) | — | notification, github-sync, gantt, file-meta, mobile-bff |
| `task.dependency_changed` | PUT dependencies | `added: TaskId[]`, `removed: TaskId[]` | gantt |
| `task.due_soon` | Cron (§9), once per task | `dueAt: ISODateTime` | notification, mobile-bff |

**Audit records** (`auditLog.AuditRecordInput`, `resourceType: "task"`) are written for
`task.task.archived` (DELETE) and `task.dependency.replaced` (PUT dependencies).

---

## 8. Events consumed

task-service runs a queue consumer on its task lane:

| Event | Action |
|---|---|
| `event.archived` | Bulk soft-archive all of the event's tasks **without** emitting per-task `task.archived` (storm prevention — other consumers react to `event.archived` directly). |

Envelope-id idempotency is enforced by the shared `IdempotencyStore`; unknown events are
acked (no-op).

---

## 9. Due-soon cron

A scheduled scan finds tasks whose `dueAt` falls inside the frozen **24h** window
(`DUE_SOON_WINDOW_HOURS`, default 24) and emits `task.due_soon` **once per task** (deduped
via a `due_soon_notified_at` marker). These events originate from cron, so `actorId` is
`null` and the `requestId` is freshly minted for the run.

---

## 10. Contract-change discipline

Additive changes (new optional field, new endpoint, new `TASK_*` code) stay in `v1`.
Breaking changes — removing/renaming a field, changing a type, altering a code's HTTP
status, editing the status-transition table or the protected-field set — require a version
bump or a frozen-decision review (`_conventions.md` §9). This file is the task-service
component contract; `_conventions.md` + `auth.md` are the cross-cutting foundation it
builds on.
