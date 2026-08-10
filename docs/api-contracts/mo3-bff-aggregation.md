# API Contract — mo3 bff.ts (BFF aggregation)

The **BFF aggregation** surface of the MO3 mobile-bff Worker: the two endpoints that
*compose* a mobile-shaped payload by fanning out to the master services (event / task /
notification / identity) and re-projecting their DTOs. This module **re-defines no
resource shape** — every field it emits is an existing `@dub/types` DTO (`EventSummary`,
`TaskSummary`, `PermissionKey`, …), narrowed or bundled but never renamed (design §1).

Two composition endpoints are owned here, and they differ by design in one axis —
**upstream-failure tolerance**:

| Endpoint | Sources | On upstream failure |
|---|---|---|
| `GET /m/v1/bff/home` | event + task + notification (fan-out, parallel) | **tolerant** — each failed source degrades to its empty/zero default; the aggregate still returns `200` |
| `GET /m/v1/bff/events/:eventId` | event (**required**) + identity capabilities | event source is **required** — its error propagates unchanged; capabilities are attached resource-scoped |

This document is the wire contract for those two endpoints only. It is bound by the
ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and
[`auth.md`](./auth.md); anything those files state (success/error envelope, `x-dub-*`
header propagation, request-id, IDs, time format) applies here and is not restated. The
rest of the MO3 HTTP surface (auth entry, devices, the logic-free transparent proxy,
`/sync`, `/mutations`, `/internal/push/dispatch`) is out of scope for this contract.

- App package: `@dub/mobile-bff` (Cloudflare Worker + Hono), public prefix `/m/v1`
- Source of truth read while writing this contract: `apps/mo3-mobile-bff/src/{bff,app,authn,errors}.ts`, `packages/types/src/{mobile,event,task,identity,notification}.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0 freeze)

---

## 1. Shared preconditions (both endpoints)

**MO3 is an external entrypoint** (mobile clients MO1/MO2 know only MO3; they do not
reach the api-gateway). Both endpoints therefore run the entry cross-cutting chain
before composition:

1. **Fresh request id** — a new ULID is minted per request and echoed on the response
   `x-dub-request-id`. Any inbound `x-dub-*` header is **ignored** (never trusted); the
   `@dub/http` client re-adds the trusted set on each downstream hop.
2. **Auth: required.** The caller must present `Authorization: Bearer <token>`. The token
   is verified **once** against auth-service (`authn.ts`); `userId` is taken only from the
   verify result. A missing or unverifiable token is `401 UNAUTHENTICATED` (see
   [`auth.md`](./auth.md) §8 for the underlying verify reasons).

### 1.1 Request headers

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | yes | Session credential; verified once at entry. |
| `Accept: application/json` | recommended | Both endpoints only ever emit JSON. |

Clients send **no** `x-dub-*` headers — they are stripped/ignored at entry.

### 1.2 Error envelope

Every error is the standard `@dub/errors` `ErrorResponse` (`_conventions.md` §2.2),
carrying the request id and the emitting `service`:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "missing bearer token",
    "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "service": "mobile-bff",
    "retryable": false
  }
}
```

Errors surfaced at this layer come from two origins:

- **Entry-originated** — `401 UNAUTHENTICATED` (missing/invalid bearer). `service` is
  `mobile-bff`.
- **Upstream passthrough** — for `GET /m/v1/bff/events/:eventId`, an error from the
  **required** event source is returned unchanged, keeping the downstream status and its
  own `error.service`/`code` (e.g. `404 EVENT_NOT_FOUND` from event-service). The home
  aggregate never passes an upstream error through (see §2.3).

---

## 2. `GET /m/v1/bff/home`

The mobile home screen in a single round-trip: the caller's upcoming events, their
assigned tasks, and their unread-notification count. Auth: **required**.

### 2.1 Composition

Three fan-out calls run in parallel (`buildHome`, `bff.ts`), each scoped to the verified
`userId`:

| # | Downstream call | Projected to |
|---|---|---|
| 1 | `GET event-service /events?sort=startsAt&limit=20` | `upcomingEvents: EventSummary[]` |
| 2 | `GET task-service /tasks?assigneeId=<userId>&limit=20` | `myTasks: TaskSummary[]` |
| 3 | `GET notification-service /inbox/unread-count` | `unreadCount: number` |

No field is re-shaped: `EventSummary` is passed through as-is; each task is narrowed to
`TaskSummary` (`{ id, title, status, assigneeId }`); the unread count is unwrapped from
its `{ count }` envelope to a bare integer.

### 2.2 Request

No path params, no body, no client-supplied query (the `limit`/`sort`/`assigneeId`
values are fixed by the aggregator, not forwarded from the client).

```
GET /m/v1/bff/home
Authorization: Bearer <token>
```

### 2.3 Partial-failure tolerance (defining behavior)

Each of the three sources is independently `try`/`catch`-guarded. **A failed source does
not fail the request** — it degrades to its neutral default and the aggregate still
returns `200`:

| Failed source | Degraded field value |
|---|---|
| event-service | `upcomingEvents: []` |
| task-service | `myTasks: []` |
| notification-service | `unreadCount: 0` |

Internally the aggregator records a `partialErrors: { source, code }[]` list for each
degraded source. **`partialErrors` is not currently serialized on the wire** — the home
handler returns only the `MobileHomeResponse` body (`app.ts`). Clients therefore cannot
today distinguish "genuinely empty" from "upstream degraded"; the field is reserved for a
future envelope addition and, until then, exists only for server-side observability.
> Contract note (for reviewers): if the client needs to render a "couldn't load" state,
> `partialErrors` must be lifted into the response body in a follow-up — it is computed
> but dropped at `c.json(home)`. Flagging rather than silently freezing.

### 2.4 Response `200` — `mobile.MobileHomeResponse`

```json
{
  "upcomingEvents": [
    {
      "id": "evt_01J9Z8...",
      "title": "北陸ITカンファレンス 2026",
      "phase": "preparing",
      "startsAt": "2026-08-05T09:00:00.000Z"
    }
  ],
  "myTasks": [
    {
      "id": "tsk_01J9Z9...",
      "title": "会場レイアウト確定",
      "status": "in_progress",
      "assigneeId": "usr_01J9ZA..."
    }
  ],
  "unreadCount": 3
}
```

Field notes:

- `upcomingEvents[].phase` — closed union `planning | preparing | open | live | wrapup | closed` (`event.EventPhase`).
- `upcomingEvents[].startsAt` — `ISODateTime | null` (unscheduled events carry `null`).
- `myTasks[].status` — closed union `todo | in_progress | blocked | done | cancelled` (`task.TaskStatus`).
- `myTasks[].assigneeId` — `UserId | null`.
- `unreadCount` — non-negative integer; `0` both when there are no unread items **and** when notification-service degraded (see §2.3).

All-sources-down example (every fan-out failed; still `200`):

```json
{ "upcomingEvents": [], "myTasks": [], "unreadCount": 0 }
```

### 2.5 Errors

| HTTP | code | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing or unverifiable bearer token (entry). |

No `5xx` originates here for upstream failure — that is the whole point of §2.3. The only
way this endpoint fails is auth.

---

## 3. `GET /m/v1/bff/events/:eventId`

The mobile event-detail header: the event summary plus the **resource-scoped
capabilities** the caller holds on that event (used purely for client-side UI gating —
the device never calls authz directly). Auth: **required**.

### 3.1 Composition

Two calls run in parallel (`buildEventOverview`, `bff.ts`):

| # | Downstream call | Projected to | Failure mode |
|---|---|---|---|
| 1 | `GET event-service /events/:eventId` | `event: EventSummary` | **required** — error propagates unchanged |
| 2 | identity authz `checkPermissions` (event-scoped) | `capabilities: PermissionKey[]` | see §3.3 |

The event source is **required**: unlike home, its error is not swallowed. The full
`GetEventResponse` (an `EventDetail`) is narrowed to `EventSummary` (`{ id, title, phase,
startsAt }`) — the actions/detail payload is intentionally dropped from this overview.

### 3.2 Request

```
GET /m/v1/bff/events/evt_01J9Z8...
Authorization: Bearer <token>
```

| Param | In | Type | Notes |
|---|---|---|---|
| `eventId` | path | `EventId` (`evt_…`) | Forwarded verbatim to event-service; MO3 does not validate its shape. |

### 3.3 Capabilities resolution

`capabilities` is the subset of a fixed **candidate set** that the caller is allowed on
this specific event. The candidate set is frozen to catalog keys (`authn.ts`
`CAPABILITY_CANDIDATES`); `mobile:*` keys are deliberately **not** invented here (identity
owns the catalog):

```
event:read, event:write, task:read, task:write
```

Each candidate is checked against identity authz with the resource scope
`{ resourceType: "event", resourceId: <eventId> }` and the caller's default org; only the
allowed keys are returned, in candidate order. `capabilities` is thus always a (possibly
empty) subset of the four keys above. It never contains a key outside the candidate set.

If the authz call fails or denies everything, `capabilities` is `[]` — an empty array is a
valid, non-error result (the client simply gates all actions off). The event source, not
authz, governs whether the request succeeds.

### 3.4 Response `200` — `mobile.MobileEventOverviewResponse`

```json
{
  "event": {
    "id": "evt_01J9Z8...",
    "title": "北陸ITカンファレンス 2026",
    "phase": "live",
    "startsAt": "2026-08-05T09:00:00.000Z"
  },
  "capabilities": ["event:read", "event:write", "task:read"]
}
```

Read-only viewer example (allowed to read, not write):

```json
{
  "event": { "id": "evt_01J9Z8...", "title": "…", "phase": "open", "startsAt": null },
  "capabilities": ["event:read", "task:read"]
}
```

### 3.5 Errors

| HTTP | code | Origin | When |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | mobile-bff (entry) | Missing or unverifiable bearer token. |
| 404 | `EVENT_NOT_FOUND` | event-service (passthrough) | `:eventId` does not resolve; status/code/`service` are the downstream's, returned unchanged. |
| 403 | `FORBIDDEN` | event-service (passthrough) | Caller may not read the event at all (event-service's own guard, if any). |
| 5xx | upstream error | event-service (passthrough) | The required event hop failed; the downstream status/body is surfaced as-is. |

Because the event source is required, **any** non-2xx from it becomes the response —
MO3 adds no envelope of its own and never degrades this endpoint to a partial result.

---

## 4. Authorization summary

| Endpoint | Entry auth | Resource authz |
|---|---|---|
| `GET /m/v1/bff/home` | Bearer required | none at MO3 — each downstream applies its own per-user scoping (`assigneeId`, inbox owner). MO3 passes the verified `userId` only. |
| `GET /m/v1/bff/events/:eventId` | Bearer required | event read is enforced by event-service; the returned `capabilities` are advisory UI hints (event-scoped authz checks), **not** an access gate. |

The `capabilities` array is a UI-gating convenience: a client must still expect the
authoritative per-action authz to be re-enforced by the owning service when it later
mutates (e.g. `PATCH /m/v1/actions/:id`). A capability present here is necessary-looking
but never a guarantee against a later `403`.
