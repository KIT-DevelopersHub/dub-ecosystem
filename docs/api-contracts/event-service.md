# Dub API Contract — event-service

Status: Component contract (v1). event-service is the **source of truth for events and
their nested actions**. The hierarchy is absolute: an action is only ever created **under**
an event (`POST /events/:id/actions`); there is no top-level action-create. Every write
publishes a typed `event.*` / `action.*` fan-out to subscriber queues and records an audit
entry.

Read [`_conventions.md`](./_conventions.md) first (envelope, headers, codes, pagination,
optimistic-lock) and [`auth.md`](./auth.md) (session + permission model). This doc only
adds what is event-service–specific.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Wire entity / DTO / request types | `packages/types/src/event.ts` (`event` namespace) |
| HTTP routing + authz wiring | `services/event-service/src/app.ts` |
| Business rules (phase, versioning, archive) | `services/event-service/src/service.ts` |
| Phase-transition table, cursor codec, DTO mappers | `services/event-service/src/domain.ts` |
| Action request contracts (service-local) | `services/event-service/src/types.ts` |
| Fan-out payloads + subscriber routing | `packages/events/src/payloads.ts`, `packages/events/src/catalog.ts` |

If code and this doc disagree, the code wins and this doc must be corrected.

---

## 1. Surface & boundaries

event-service is an **internal** Worker. Browsers reach it **only through `api-gateway`**
under the `/api/v1` prefix; the gateway authenticates the session, mints the trusted
`x-dub-user-id`, and strips **only** `API_PREFIX` before proxying. Two gateway segments both
target this Worker's `SVC_EVENT` binding:

| Gateway segment | External prefix | Service-local path |
|---|---|---|
| `events` | `/api/v1/events…` | `/events…` |
| `actions` | `/api/v1/actions…` | `/actions…` |

Native apps reach the same data through `mo3-mobile-bff` (`/m/v1`), which fans out to this
service; the entity shapes below are identical on that path.

`GET /health` (`{ "status": "ok", "service": "event-service" }`) is service-local only and
is **not** exposed through the gateway.

All paths below are written at the **external** (gateway) prefix. Every endpoint requires an
authenticated session; an absent `x-dub-user-id` at the service yields `401 UNAUTHENTICATED`.

---

## 2. Entities

### 2.1 `DubEvent` (`event.DubEvent`)

```json
{
  "id": "evt_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "orgId": "org_devhub",
  "title": "Hokuriku IT Conference 2026",
  "description": "Annual regional developer conference.",
  "phase": "planning",
  "startsAt": "2026-08-05T00:00:00Z",
  "endsAt": "2026-08-05T09:00:00Z",
  "archivedAt": null,
  "version": 1,
  "createdAt": "2026-08-01T05:00:00Z",
  "updatedAt": "2026-08-01T05:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`evt_`-ULID) | Opaque. |
| `orgId` | string | Always the caller's org (`org_devhub`); cross-org rows are invisible (404). |
| `title` | string | Non-empty (trimmed). |
| `description` | string \| null | |
| `phase` | `EventPhase` | Closed enum, §4. Created events start at `"planning"`. |
| `startsAt` / `endsAt` | ISODateTime \| null | ISO-8601 UTC. |
| `archivedAt` | ISODateTime \| null | Non-null ⇒ archived (soft-delete), immutable. |
| `version` | number | Optimistic-lock counter (§_conventions 6.3). |
| `createdAt` / `updatedAt` | ISODateTime | |

`createdBy` is **internal only** and never crosses the wire.

`EventSummary` (list rows) is the projection `{ id, title, phase, startsAt }`.
`EventDetail` (single read) is `DubEvent` plus `actions: ActionSummary[]` (non-archived,
ordered by `sortOrder`, capped at 200).

### 2.2 `DubAction` (`event.DubAction`)

```json
{
  "id": "act_01J9Z8Q0X7M3K2P5R8T1V4W6YB",
  "eventId": "evt_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "kind": "session",
  "title": "Opening keynote",
  "sortOrder": 1024,
  "archivedAt": null,
  "version": 1,
  "createdAt": "2026-08-01T05:10:00Z",
  "updatedAt": "2026-08-01T05:10:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`act_`-ULID) | |
| `eventId` | string (`evt_`-ULID) | Owning event; immutable after create. |
| `kind` | string | **Open registry** — any non-empty string; new kinds allowed freely, no enum. |
| `title` | string | Non-empty. |
| `sortOrder` | number | Manual ordering; default = current max + 1024 on create. |
| `archivedAt` | ISODateTime \| null | |
| `version` | number | Optimistic-lock counter. |

`ActionSummary` (embedded in `EventDetail`) is `{ id, eventId, kind, title }`.

---

## 3. Endpoints

### 3.1 `GET /api/v1/events` — list events

Permission: `event:read`. Cursor-paginated (`ListEventsResponse = Paginated<EventSummary>`).

Query params (all optional):

| Param | Type | Notes |
|---|---|---|
| `cursor` | string (opaque) | Echo a prior `nextCursor`. A malformed cursor ⇒ `400 VALIDATION_FAILED` (`{ field: "cursor", reason: "invalid" }`), never a silent full scan. |
| `limit` | integer | Default 50, max 200. Out of range ⇒ `400 VALIDATION_FAILED` (`{ field: "limit", reason: "too_large" \| "invalid" }`). |
| `phase` | `EventPhase` | Filter by phase. |
| `startsAfter` | ISODateTime | Only events starting after this instant. |
| `sort` | `"startsAt"` | Only accepted value; default is id order. |
| `includeArchived` | boolean | Default `false` (archived hidden). |

Response `200`:

```json
{
  "items": [
    { "id": "evt_01J9Z...", "title": "Hokuriku IT Conference 2026", "phase": "planning", "startsAt": "2026-08-05T00:00:00Z" }
  ],
  "nextCursor": "eyJpZCI6ImV2dF8wMUo5WiJ9"
}
```

`nextCursor === null` ⇒ last page.

### 3.2 `POST /api/v1/events` — create event

Permission: `event:write`.

Request (`event.CreateEventRequest`):

```json
{
  "title": "Hokuriku IT Conference 2026",
  "description": "Annual regional developer conference.",
  "startsAt": "2026-08-05T00:00:00Z",
  "endsAt": "2026-08-05T09:00:00Z"
}
```

- `title` (required, non-empty). Missing/blank ⇒ `400 VALIDATION_FAILED` (`{ field: "title", reason: "required" }`).
- `description`, `startsAt`, `endsAt` optional.
- `phase` is **not** accepted here — every event is created at `"planning"`.

Response `201`: the full `DubEvent` (`version: 1`, `phase: "planning"`). Emits `event.created`.

### 3.3 `GET /api/v1/events/:id` — get event detail

Permission: `event:read` (resource-scoped to `event`/`:id`). Response `200`: `EventDetail`
(the event plus its non-archived `actions`).

```json
{
  "id": "evt_01J9Z...",
  "orgId": "org_devhub",
  "title": "Hokuriku IT Conference 2026",
  "description": "Annual regional developer conference.",
  "phase": "preparing",
  "startsAt": "2026-08-05T00:00:00Z",
  "endsAt": "2026-08-05T09:00:00Z",
  "archivedAt": null,
  "version": 4,
  "createdAt": "2026-08-01T05:00:00Z",
  "updatedAt": "2026-08-03T02:00:00Z",
  "actions": [
    { "id": "act_01J9Z...", "eventId": "evt_01J9Z...", "kind": "session", "title": "Opening keynote" }
  ]
}
```

Unknown / cross-org id ⇒ `404 NOT_FOUND` (existence-hiding).

### 3.4 `PATCH /api/v1/events/:id` — update event

Permission: `event:write` (resource-scoped). A **phase back-transition or entering
`"closed"`** additionally requires `event:admin` — checked live (fresh, never cached, D9),
denied ⇒ `403 FORBIDDEN`.

Request (`event.UpdateEventRequest`) — all mutable fields optional **except `version`**,
which is **required** (optimistic lock):

```json
{
  "version": 4,
  "title": "Hokuriku IT Conference 2026 (Final)",
  "description": null,
  "phase": "open",
  "startsAt": "2026-08-05T00:30:00Z",
  "endsAt": "2026-08-05T09:00:00Z"
}
```

| Field | Rule |
|---|---|
| `version` | Required. Missing/non-number ⇒ `400 VALIDATION_FAILED` (`{ field: "version", reason: "required" }`). Stale ⇒ `409 EVENT_VERSION_CONFLICT`. |
| `title` | If present, non-empty. |
| `description` | Nullable. |
| `phase` | Validated against the transition table (§4). Illegal ⇒ `400 EVENT_INVALID_PHASE_TRANSITION` (`details: { from, to }`). |
| `startsAt` / `endsAt` | Nullable ISODateTime. |

Archived event ⇒ `409 EVENT_ARCHIVED_IMMUTABLE`. Response `200`: the updated `DubEvent`
(`version` incremented). Emits `event.phase_changed` (when phase changed) and/or
`event.updated` (when any of title/description/startsAt/endsAt changed) — a phase-only
change emits `event.phase_changed` alone.

### 3.5 `DELETE /api/v1/events/:id` — archive event

Permission: `event:admin` (resource-scoped). **Soft-delete** (sets `archivedAt`), not a hard
delete. Idempotent: archiving an already-archived event still returns `204`. Response
`204 No Content`. Emits `event.archived`.

### 3.6 `GET /api/v1/events/:id/participants` — participant user ids

Permission: `event:read` (resource-scoped). Synthesizes the distinct set of user ids
involved in the event: the event creator, every (non-archived, capped) action's creator, and
the assignees of the event's tasks (read from task-service). Response `200`:

```json
{ "userIds": ["user_01J9Z...", "user_01J9Z...A"] }
```

Order is not significant; the list is de-duplicated.

### 3.7 `GET /api/v1/events/:id/actions` — list actions under an event

Permission: `event:read` (resource-scoped). Cursor-paginated
(`Paginated<DubAction>`), ordered by `sortOrder`.

Query params (all optional): `cursor`, `limit` (default 50 / max 200, same validation as
§3.1), `kind` (exact-match filter), `includeArchived` (default `false`).

```json
{
  "items": [
    { "id": "act_01J9Z...", "eventId": "evt_01J9Z...", "kind": "session", "title": "Opening keynote", "sortOrder": 1024, "archivedAt": null, "version": 1, "createdAt": "2026-08-01T05:10:00Z", "updatedAt": "2026-08-01T05:10:00Z" }
  ],
  "nextCursor": null
}
```

Unknown / cross-org event id ⇒ `404 NOT_FOUND`.

### 3.8 `POST /api/v1/events/:id/actions` — create action under an event

Permission: `event:write` (resource-scoped). This is the **only** way to create an action
(hierarchy rule).

Request (service-local `CreateActionRequest`):

```json
{ "kind": "session", "title": "Opening keynote", "sortOrder": 1024 }
```

- `kind` (required, non-empty) — open registry, any string.
- `title` (required, non-empty).
- `sortOrder` (optional) — omitted ⇒ appended as `maxSortOrder(event) + 1024`.

Parent event must exist (else `404`) and be non-archived (else `409 EVENT_ARCHIVED_IMMUTABLE`).
Response `201`: the full `DubAction` (`version: 1`). Emits `action.created`.

### 3.9 `GET /api/v1/actions/:id` — get one action

Permission: `event:read`. Response `200`: `DubAction`. Unknown id, or an action whose parent
event is cross-org, ⇒ `404 NOT_FOUND`.

### 3.10 `PATCH /api/v1/actions/:id` — update action

Permission: `event:write`. Request (service-local `UpdateActionRequest`) — `version` required,
other fields optional:

```json
{ "version": 1, "kind": "keynote", "title": "Opening keynote (updated)", "sortOrder": 512 }
```

| Field | Rule |
|---|---|
| `version` | Required. Missing/non-number ⇒ `400 VALIDATION_FAILED`. Stale ⇒ `409 EVENT_VERSION_CONFLICT`. |
| `kind` | If present, non-empty. |
| `title` | If present, non-empty. |
| `sortOrder` | If present, finite number; else `400 VALIDATION_FAILED` (`{ field: "sortOrder", reason: "invalid" }`). |

Archived action **or** archived parent event ⇒ `409 EVENT_ARCHIVED_IMMUTABLE`. Response `200`:
updated `DubAction`. Emits `action.updated` when any field changed.

### 3.11 `DELETE /api/v1/actions/:id` — archive action

Permission: `event:write` (note: **not** `event:admin`, unlike event archive). Soft-delete;
idempotent (already-archived ⇒ `204`). Response `204 No Content`. Emits `action.archived`.

---

## 4. Phase state machine

`EventPhase` is a **closed enum** (`event.EventPhase`); changing it is a contract change.
Transitions are validated against `event.EVENT_PHASE_TRANSITIONS` — the single source shared
with FE3's phase-transition control.

```
planning → preparing → open → live → wrapup → closed
             ↑            ↑        ↑        ↑
   (each stage may step one back to the previous)
```

| From | Allowed `to` | Permission |
|---|---|---|
| `planning` | `preparing` | `event:write` |
| `preparing` | `open`, `planning` | forward `event:write`; back (`planning`) `event:admin` |
| `open` | `live`, `preparing` | forward `event:write`; back `event:admin` |
| `live` | `wrapup`, `open` | forward `event:write`; back `event:admin` |
| `wrapup` | `closed`, `live` | `closed` `event:admin`; back (`live`) `event:admin` |
| `closed` | — (no reopen) | — |

Rules:
- **Forward one step** = `event:write`.
- **Any back-transition, or entering `closed`** = `event:admin` (re-checked fresh).
- **`closed` is terminal** — no transition out; attempting one ⇒ `400 EVENT_INVALID_PHASE_TRANSITION`.
- Any `to` not in the allowed set for the current `from` ⇒ `400 EVENT_INVALID_PHASE_TRANSITION`
  with `details: { from, to }`.

---

## 5. Authorization summary

All permission keys are from the frozen catalog (`auth.md` §9). Resource-scoped checks pass
`resourceType: "event"`, `resourceId: <event id>` to `/authz/check`.

| Endpoint | Permission | Scope |
|---|---|---|
| `GET /events` | `event:read` | org |
| `POST /events` | `event:write` | org |
| `GET /events/:id` | `event:read` | event/:id |
| `PATCH /events/:id` | `event:write` (+ `event:admin` for back / `closed` phase) | event/:id |
| `DELETE /events/:id` | `event:admin` | event/:id |
| `GET /events/:id/participants` | `event:read` | event/:id |
| `GET /events/:id/actions` | `event:read` | event/:id |
| `POST /events/:id/actions` | `event:write` | event/:id |
| `GET /actions/:id` | `event:read` | (action → event) |
| `PATCH /actions/:id` | `event:write` | (action → event) |
| `DELETE /actions/:id` | `event:write` | (action → event) |

A missing permission ⇒ `403 FORBIDDEN`. Cross-org or non-existent resources ⇒ `404 NOT_FOUND`
(existence-hiding — the client cannot distinguish "forbidden" from "absent" for another org's
data).

---

## 6. Service-specific error codes

Format `<SERVICE>_<REASON>` (`_conventions.md` §3.2). Each carries an explicit HTTP status.
Everything else falls back to the common codes in `_conventions.md` §3.1.

| Code | HTTP | `retryable` | When | `details` |
|---|---|---|---|---|
| `EVENT_INVALID_PHASE_TRANSITION` | 400 | false | `phase` update not allowed from the current phase (incl. any transition out of `closed`). | `{ from, to }` |
| `EVENT_VERSION_CONFLICT` | 409 | false | Optimistic-lock mismatch: the sent `version` is stale (event or action). Client should re-read and retry. | — |
| `EVENT_ARCHIVED_IMMUTABLE` | 409 | false | Write attempted against an archived event/action (update/archive-child/patch). | — |

Common codes this service also returns: `VALIDATION_FAILED` (400), `UNAUTHENTICATED` (401),
`FORBIDDEN` (403), `NOT_FOUND` (404). All share the standard error envelope
(`_conventions.md` §2.2).

Client note: both `EVENT_VERSION_CONFLICT` and `EVENT_ARCHIVED_IMMUTABLE` are `409`; branch on
the **code**, not the status, to tell a stale-write (re-read & retry) from an archived-target
(stop) case.

---

## 7. Fan-out events (`event.*` / `action.*`)

Every successful write publishes one or more typed envelopes to the frozen `dub-q-evt-*`
subscriber queues (`packages/events`). Publish is best-effort side-effect after the D1 commit;
consumers dedupe on the envelope `id`. Payload shapes are frozen in
`packages/events/src/payloads.ts`; the subscriber routing lives in
`packages/events/src/catalog.ts` (`SUBSCRIPTIONS`).

Envelope (`DubEventEnvelope`, one per event):

```json
{
  "name": "event.created",
  "version": 1,
  "id": "01J9Z8Q0X7M3K2P5R8T1V4W6YC",
  "occurredAt": "2026-08-01T05:00:00Z",
  "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "actorId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "payload": { "eventId": "evt_01J9Z...", "title": "Hokuriku IT Conference 2026", "phase": "planning" }
}
```

| Name | Emitted by | Payload | Subscribers |
|---|---|---|---|
| `event.created` | `POST /events` | `{ eventId, title, phase }` | notification, mobile-bff |
| `event.updated` | `PATCH /events/:id` (title/description/startsAt/endsAt changed) | `{ eventId, changed: string[] }` | notification, gantt, mobile-bff |
| `event.phase_changed` | `PATCH /events/:id` (phase changed) | `{ eventId, previousPhase, phase }` | notification, task, gantt, mobile-bff |
| `event.archived` | `DELETE /events/:id` | `{ eventId }` | notification, task, gantt, github-sync, file-meta, mobile-bff |
| `action.created` | `POST /events/:id/actions` | `{ actionId, eventId, kind }` | notification, task, gantt, mobile-bff |
| `action.updated` | `PATCH /actions/:id` (any field changed) | `{ actionId, eventId, changed: string[] }` | notification, gantt, mobile-bff |
| `action.archived` | `DELETE /actions/:id` | `{ actionId, eventId }` | notification, task, file-meta, mobile-bff |

Notes:
- A `PATCH /events/:id` that changes **both** phase and other fields emits **two** envelopes
  (`event.phase_changed` **and** `event.updated`). A no-op field set emits nothing.
- `changed` lists the field names that actually changed (e.g. `["title","startsAt"]`).
- `action.status_changed` exists in the catalog (subscribers: notification, gantt, mobile-bff)
  but is **reserved** — event-service does not emit it yet (there is no action-status field in
  v1). It is documented here so subscribers can wire it ahead of time.

---

## 8. Audit records

Every write also records an audit entry to the audit queue (`auditLog.AuditRecordInput`), with
`action` = `<domain>.<entity>.<verb>`:

| Endpoint | Audit `action` | `resourceType` |
|---|---|---|
| create event | `event.event.created` | `event` |
| update event (fields) | `event.event.updated` | `event` |
| update event (phase) | `event.event.phase_changed` | `event` |
| archive event | `event.event.archived` | `event` |
| create action | `event.action.created` | `action` |
| update action | `event.action.updated` | `action` |
| archive action | `event.action.archived` | `action` |

`actorId` is the caller's `x-dub-user-id`; `requestId` is propagated from
`x-dub-request-id`; `occurredAt` is server ISO time.

---

## 9. Contract-change discipline

Additive-safe within `v1`: a new optional list filter, a new action `kind` (open registry, not
a contract change), a new subscriber for an existing fan-out event. **Breaking** (needs a
version bump or frozen-decision review): adding/removing an `EventPhase`, changing a
transition rule, changing a fan-out payload shape or an emitted-event set, changing a
permission requirement, or making the `409` code split behave differently. See
[`_conventions.md`](./_conventions.md) §9.
