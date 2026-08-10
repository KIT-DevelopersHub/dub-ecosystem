# API Contract — mo3 sync.ts (offline snapshot sync)

The **offline snapshot sync** surface of the MO3 mobile-bff Worker: the single
read endpoint a mobile client hits to (re)build its offline mirror of the
caller's resources in one catch-up. `GET /m/v1/sync` **composes** — it fans out
to the three master services (event / task / notification), drains every page of
each, and returns their source-of-truth DTOs tagged with a `resource` kind. It
**re-defines no resource shape**: each `data` payload is an existing `@dub/types`
DTO (`EventSummary`, the full versioned `Task`, `InboxItem`), never renamed or
narrowed (design §1).

This document is the wire contract for that one endpoint. It is bound by the
ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and
[`auth.md`](./auth.md); anything those files state (success/error envelope,
`x-dub-*` header propagation, request-id minting, ID form, time format, cursor
opacity) applies here and is **not** restated. The rest of the MO3 HTTP surface
(auth entry, devices, BFF aggregates, the logic-free transparent proxy,
`POST /m/v1/mutations`, `/internal/push/dispatch`) is out of scope.

- App package: `@dub/mobile-bff` (Cloudflare Worker + Hono), public prefix `/m/v1`
- Source of truth read while writing this contract: `apps/mo3-mobile-bff/src/{sync,app,authn,errors}.ts`, `packages/types/src/{mobile,common,event,task,notification}.ts`, `packages/errors/src/wire.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0 freeze)

---

## 1. Design note — full snapshot today, differential tomorrow

`GET /m/v1/sync` is **not yet differential**. No upstream service honors a
change-since filter today, so the BFF cannot ask for "changed since X" and pulls
the whole set on every call. The opaque `cursor` is still round-tripped, but its
**only** live purpose is forward-compatibility: it carries a server-time
watermark that is forwarded to each master service as `updatedSince`, which they
currently ignore.

Two properties make this safe and stable:

- **Correct-by-superset.** A superset of "the changes" (i.e. the full set) is
  always safe for an upsert-merge client — it re-applies rows it may already
  hold, never dropping one. So treating every pull as a fresh full snapshot is
  correct while differential filtering is absent.
- **No wire-shape change on cutover.** When the physical change-log table + its
  queue writers land (theme14 D2 / #28), the same `cursor` becomes a real
  differential watermark with **no** change to request or response shape. Clients
  written against this contract keep working unchanged.

Client rule of thumb: **always persist and replay `nextCursor`**, and treat the
response as an upsert batch (merge by `resource`+`id`), never as a full replace.

---

## 2. Shared preconditions

**MO3 is an external entrypoint** (mobile clients MO1/MO2 know only MO3; they do
not reach the api-gateway). The endpoint runs the entry cross-cutting chain
before composition:

1. **Fresh request id** — a new ULID is minted per request and echoed on the
   response `x-dub-request-id`. Any inbound `x-dub-*` header is **ignored**
   (never trusted); the `@dub/http` client re-adds the trusted set on each
   downstream hop.
2. **Auth: required.** The caller must present `Authorization: Bearer <token>`.
   The token is verified **once** against auth-service (`authn.ts`); `userId` is
   taken only from the verify result and is what scopes the caller's tasks. A
   missing or unverifiable token is `401 UNAUTHENTICATED` (see
   [`auth.md`](./auth.md) for the underlying verify reasons).

### 2.1 Request headers

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | yes | Session credential; verified once at entry. |
| `Accept: application/json` | recommended | The endpoint only ever emits JSON. |

Clients send **no** `x-dub-*` headers — they are stripped/ignored at entry.

### 2.2 Error envelope

Every error is the standard `@dub/errors` `ErrorResponse` (`_conventions.md`
§2.2), carrying the request id and the emitting `service`:

```json
{
  "error": {
    "code": "MOBILE_SYNC_CURSOR_EXPIRED",
    "message": "sync cursor is invalid or expired",
    "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "service": "mobile-bff",
    "retryable": false
  }
}
```

---

## 3. `GET /m/v1/sync`

A **full snapshot** of the caller's mirrored resources in one response: every
event visible to the caller, every task assigned to the caller, and the caller's
notification inbox — each item tagged with its `resource` kind. Auth: **required.**

### 3.1 Composition

Three fan-out calls run in parallel (`buildSync`, `sync.ts`); each source is
**drained across all its pages** (following the source's opaque `nextCursor`
until it reports `null`) so a result set larger than one page is never truncated:

| `resource` | Upstream call | Scope | `data` DTO |
|---|---|---|---|
| `event` | `GET /events` (event-service) | all events visible to the caller | `event.EventSummary` |
| `task` | `GET /tasks?assigneeId=<userId>` (task-service) | tasks assigned to the verified caller only | `task.Task` (full, versioned) |
| `notification` | `GET /inbox` (notification-service) | the caller's inbox | `notification.InboxItem` |

The server captures its watermark (`serverTime`) **before** the fan-out, so a
write racing the read is picked up by the *next* pull rather than silently
skipped.

### 3.2 Query parameters

| Param | Type | Default | Bounds | Meaning |
|---|---|---|---|---|
| `cursor` | string (opaque, base64url) | — | — | A previous response's `nextCursor`. When present it wins over `since`; decoded to the server-time watermark forwarded downstream as `updatedSince` (see §1). Absent on the first pull. |
| `since` | string (`ISODateTime`) | — | — | Legacy hint, superseded by `cursor`. Forwarded as `updatedSince` only when `cursor` is absent. STUB — prefer `cursor`. |
| `limit` | integer | `50` | clamped to `[1, 200]` | **Per-page** size for each upstream drain, **not** a total cap on the response. Non-numeric / `<= 0` / missing → `50`; `> 200` → `200`. |

`cursor` and `since` are mutually reinforcing: if both are sent, `cursor`
decides the watermark and `since` is dropped.

Because the endpoint drains all pages, `limit` never limits how many items the
caller receives — it only tunes the page size of the internal fan-out. The
response itself is **not** paginated back to the client in the current wave:
`nextCursor` is a watermark, not a "more pages remain" marker (it is always a
non-null string — see §3.4).

### 3.3 Request examples

First pull (cold client, no cursor):

```
GET /m/v1/sync HTTP/1.1
Host: mobile.dub.example
Authorization: Bearer <token>
Accept: application/json
```

Subsequent pull (replaying the previous watermark, larger page size):

```
GET /m/v1/sync?cursor=eyJ2IjoxLCJzaW5jZSI6IjIwMjYtMDgtMDlUMTA6MDA6MDAuMDAwWiJ9&limit=200 HTTP/1.1
Host: mobile.dub.example
Authorization: Bearer <token>
Accept: application/json
```

### 3.4 Response — `200 OK`

Body is `mobile.SyncResponse`: a `Paginated<SyncChangeEntry>`-shaped `items`
array plus a `serverTime` watermark and the `nextCursor` to replay next time.

| Field | Type | Notes |
|---|---|---|
| `items` | `SyncChangeEntry[]` | All changed/mirrored resources, ordered events → tasks → notifications. Empty array when nothing is visible. |
| `items[].resource` | `"event" \| "task" \| "notification"` | The source-of-truth kind; the client keys its local mirror by this. |
| `items[].id` | string (prefix-ULID) | The resource's own id (`evt_*`, `tsk_*`, `ntf_*`). |
| `items[].data` | object | The upstream DTO **verbatim**, in upsert form (`event.EventSummary` / full `task.Task` / `notification.InboxItem`). MO3 never reshapes it. The `task` payload is the **full** versioned `Task` (not the `TaskSummary`), so it carries `version` for the client's optimistic-lock replay. |
| `nextCursor` | string (opaque, base64url) | The watermark to send as `?cursor=` on the next pull. **Always a non-null string** here (unlike a paging cursor); encodes `serverTime`. |
| `serverTime` | string (`ISODateTime`) | The watermark captured before fan-out; equals the value encoded in `nextCursor`. |

```json
{
  "items": [
    {
      "resource": "event",
      "id": "evt_01J9Z0000EVENT0000000001",
      "data": {
        "id": "evt_01J9Z0000EVENT0000000001",
        "title": "Autumn Hackathon",
        "phase": "live",
        "startsAt": "2026-09-01T09:00:00Z"
      }
    },
    {
      "resource": "task",
      "id": "tsk_01J9Z0000TASK00000000001",
      "data": {
        "id": "tsk_01J9Z0000TASK00000000001",
        "eventId": "evt_01J9Z0000EVENT0000000001",
        "title": "Book the venue",
        "description": null,
        "status": "todo",
        "priority": "high",
        "assigneeId": "usr_01J9Z00000ALICE000000001",
        "dueAt": "2026-08-20T09:00:00Z",
        "origin": "internal",
        "archivedAt": null,
        "createdAt": "2026-08-05T12:00:00Z",
        "updatedAt": "2026-08-08T08:30:00Z",
        "version": 3
      }
    },
    {
      "resource": "notification",
      "id": "ntf_01J9Z0000NOTIF0000000001",
      "data": {
        "id": "ntf_01J9Z0000NOTIF0000000001",
        "type": "task.assigned",
        "title": "You were assigned a task"
      }
    }
  ],
  "nextCursor": "eyJ2IjoxLCJzaW5jZSI6IjIwMjYtMDgtMTBUMDA6MDA6MDAuMDAwWiJ9",
  "serverTime": "2026-08-10T00:00:00.000Z"
}
```

Empty snapshot (nothing visible to the caller) — still a valid, replayable
watermark:

```json
{
  "items": [],
  "nextCursor": "eyJ2IjoxLCJzaW5jZSI6IjIwMjYtMDgtMTBUMDA6MDA6MDAuMDAwWiJ9",
  "serverTime": "2026-08-10T00:00:00.000Z"
}
```

> The `data` objects above show the fields this contract's source DTOs expose
> today; their authoritative shapes and full field sets live in the event / task
> / notification contracts. MO3 forwards whatever those services return, so
> clients should tolerate additive fields (`_conventions.md` forward-compat).

### 3.5 Cursor format (informative, non-normative)

The cursor is **opaque** — clients must treat it as a blob and never parse it
(`_conventions.md` D3). For implementers, the current encoding is base64url of
`{"v":1,"since":"<ISODateTime>"}` with padding stripped. A cursor that does not
decode to `{ v: 1, since: string }` is rejected as
`400 MOBILE_SYNC_CURSOR_EXPIRED` (§4). The `v` tag lets a later wave rotate the
encoding without breaking old clients.

### 3.6 Consistency & failure semantics

- **Fail-closed.** If *any* one of the three sources errors, the whole pull
  rejects with that upstream's status/code — no partial snapshot is emitted. The
  client retries with the **same** cursor, so the watermark never advances past
  a snapshot the client did not fully receive. (This differs from
  `GET /m/v1/bff/home`, which is failure-*tolerant* and degrades per source.)
- **Watermark-before-read.** `serverTime` / `nextCursor` are stamped before the
  fan-out; a row written mid-read surfaces on the next pull, never lost.
- **Idempotent.** Replaying the same cursor yields another correct (superset)
  snapshot; the client's upsert-merge makes repeated pulls harmless.

---

## 4. Errors

| HTTP | `error.code` | `retryable` | When | `service` |
|---|---|---|---|---|
| `401` | `UNAUTHENTICATED` | `false` | Missing or unverifiable `Authorization: Bearer` at entry (`app.ts` `requireAuth`). | `mobile-bff` |
| `400` | `MOBILE_SYNC_CURSOR_EXPIRED` | `false` | `?cursor=` is unparseable, tampered, or from an incompatible encoding version (`errors.ts` `syncCursorExpired`). Client should drop its cursor and do a cold full pull (no `cursor`). | `mobile-bff` |
| `4xx` / `5xx` | upstream passthrough | per upstream | Any error from event / task / notification while draining (fail-closed, §3.6). Status, `code`, and `error.service` are the upstream's, unchanged (e.g. `502 UPSTREAM_UNAVAILABLE`). | upstream service |

Notes:

- `MOBILE_SYNC_CURSOR_EXPIRED` is a service-owned open-half code (`MOBILE_*`,
  SCREAMING_SNAKE, theme3) with an explicit `400` status; it is `retryable:
  false` because retrying the *same* bad cursor cannot succeed — recover by
  dropping the cursor.
- An out-of-range or non-numeric `limit` is **not** an error: it is clamped
  (§3.2), so `?limit=0`, `?limit=abc`, and `?limit=9999` all succeed.
- There is no request body and no `4xx` for body validation on this endpoint —
  it is a pure `GET`.

---

## 5. Authorization summary

| Aspect | Rule |
|---|---|
| Authentication | **Required.** `Bearer` verified once at entry; `userId` from the verify result only. |
| Task scoping | Tasks are hard-scoped to the verified caller (`assigneeId=<userId>`); a client cannot widen this via query. |
| Event / inbox scoping | Whatever the upstream service authorizes for the caller's propagated `x-dub-*` identity — MO3 adds no filter and no capability check of its own here (unlike `GET /m/v1/bff/events/:eventId`). |
| Cross-user access | Not possible: the caller only ever sees their own assigned tasks, their own inbox, and the events the upstream grants them. |
