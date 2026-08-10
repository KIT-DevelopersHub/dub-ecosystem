# API Contract — mo3-mobile-bff (`app.ts`, Hono HTTP surface)

The **single** external HTTP entrypoint for the native apps (MO1 iOS, MO2 Android). MO1/MO2
know only MO3 — they never call the internal services or the web gateway directly. MO3 is a
**Backend-for-Frontend**: it authenticates the bearer token once, mints a fresh request id,
fans out to the internal Service Bindings (event / task / notification / identity /
auth-service), and returns mobile-shaped payloads. It re-defines no resource — the summary
DTOs it composes are owned by their master services (design §1).

This document is the wire contract for MO3's HTTP surface. It is bound by the ecosystem-wide
rules in [`_conventions.md`](./_conventions.md) and [`auth.md`](./auth.md); anything those
files state (success/error envelope, header propagation, pagination, IDs, time, idempotency,
retries, redaction) applies here and is **not** restated. Types referenced below live in
`@dub/types` (`mobile`, `auth`, `event`, `task`, `notification`, `identity`, `common`) and
`@dub/errors` (`ErrorResponse`).

- Service package: `@dub/mo3-mobile-bff` (Cloudflare Worker + Hono)
- Source of truth read while writing this contract: `apps/mo3-mobile-bff/src/{app,bff,sync,mutations,devices,push,errors,deps}.ts`, `packages/types/src/{mobile,auth,event,task,notification,identity,common}.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0 freeze)

---

## 1. Surface model

MO3 exposes exactly two prefixes plus a liveness probe:

| Prefix | Audience | Auth | Notes |
|---|---|---|---|
| `/m/v1/*` (`common.MOBILE_API_PREFIX`) | native apps | Bearer (except the `/auth/*` bootstrap trio) | The public mobile API |
| `/internal/push/dispatch` | other services (Service Binding) | `x-dub-internal: 1` | Not reachable from the public internet |
| `/healthz` | platform liveness probe | none | Outside the prefix |

Requests fall into five disjoint classes, all under `/m/v1` unless noted:

| Class | Paths | Handled by | Auth |
|---|---|---|---|
| Auth bootstrap | `/m/v1/auth/{exchange,refresh,logout}` | forwards to auth-service | `exchange`/`refresh` public; `logout` bearer |
| MO3-owned | `/m/v1/devices*`, `/m/v1/me` | MO3 itself (device registry / identity compose) | bearer |
| BFF aggregate | `/m/v1/bff/home`, `/m/v1/bff/events/:eventId` | MO3 composition | bearer |
| Transparent proxy | `/m/v1/{events,tasks,actions,inbox,preferences}*` | logic-free forward to a Service Binding | bearer |
| Offline | `/m/v1/sync`, `/m/v1/mutations` | MO3 snapshot / replay | bearer |
| Internal | `/internal/push/dispatch` | MO3 push fan-out | `x-dub-internal` |
| Liveness | `/healthz` | MO3 | none |

### 1.1 Cross-cutting behaviour (every request)

1. **Fresh request id.** MO3 mints a brand-new `x-dub-request-id` (ULID) on **every** request
   and **ignores any inbound `x-dub-*`** — a native client can never spoof user id, org, or
   correlation id. The `@dub/http` client re-adds the trusted headers on each downstream fan-out.
2. **Bearer verified once.** On any bearer route, MO3 calls auth-service `/verify` a single time
   (see [`auth.md`](./auth.md) §8), sets the trusted `x-dub-user-id` for downstream calls, and
   never forwards the raw token past itself. Downstream services trust that header.
3. **Uniform envelope.** Success is the payload itself (no `{ data }` wrapper); every non-2xx is
   `errors.ErrorResponse` produced by `dubErrorHandler({ service: "mobile-bff" })`. 5xx messages
   are redacted at this boundary.

### 1.2 What the app sends

| Header | Purpose |
|---|---|
| `Authorization: Bearer <token>` | Session credential. Required on all `/m/v1/*` routes except `auth/exchange` and `auth/refresh`. |
| `x-dub-idempotency-key` | Optional; opt-in idempotency for `POST`/`PATCH` (§conventions 7). Offline mutations carry their key in the body instead (§8). |
| `Content-Type: application/json` | For bodied requests. |

Any inbound `x-dub-request-id` / `x-dub-user-id` / other `x-dub-*` header is **discarded**.

---

## 2. Auth bootstrap — `/m/v1/auth/*`

These three forward to auth-service; the semantics (token lifetimes, error codes, session shape)
are frozen in [`auth.md`](./auth.md). MO3 adds no session logic of its own (theme8: token pass-through,
MO3 never mints tokens).

### 2.1 `POST /m/v1/auth/exchange` — mobile OAuth code exchange (public)

The native app runs Google OAuth (PKCE) itself, then hands MO3 the authorization code. MO3
forwards to auth-service `POST /mobile/exchange` (adding `x-dub-internal`).

Request (`auth.MobileExchangeRequest`; `authorizationCode` is accepted as an alias for `code`):

```json
{ "code": "4/0Ax7...google-auth-code" }
```

- `code` (required, non-empty string) — the Google authorization code. Missing/empty →
  `400 VALIDATION_FAILED` `{ "field": "code", "reason": "required" }`.

Response `200` (`{ token, session }`):

```json
{
  "token": "dst_01J9Z8Q0X7M3K2P5R8T1V4W6Y9....",
  "session": {
    "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "client": "mobile",
    "sessionExpiresAt": 1760000000000
  }
}
```

The app stores `token` in the secure keychain and sends it as `Authorization: Bearer` thereafter.
`sessionExpiresAt` is **epoch-ms** (`number`, the one time exception, §conventions 6.2).

Errors: OAuth failures surface with the `auth.md` §11 codes (e.g. `AUTH_OAUTH_EXCHANGE_FAILED`,
`AUTH_USER_REJECTED` for a non-invited email), forwarded 1:1 from auth-service.

### 2.2 `POST /m/v1/auth/refresh` — slide the session (public)

Rotates the bearer token. The token to refresh is read from `Authorization: Bearer` if present,
else from the body `refreshToken`. Forwards to auth-service `POST /auth/refresh` (bearer path).

Request (`auth.AuthRefreshRequest`, body optional):

```json
{ "refreshToken": "dst_01J9Z...current" }
```

Response `200` (`{ token, session }` — a **new** token):

```json
{
  "token": "dst_01J9Z...NEW",
  "session": {
    "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "client": "mobile",
    "sessionExpiresAt": 1760003600000
  }
}
```

Errors (from auth-service): `AUTH_INVALID_TOKEN` (401) if malformed, `AUTH_SESSION_REVOKED` (401)
if revoked or past the 180-day absolute lifetime → the app must re-run OAuth.

### 2.3 `POST /m/v1/auth/logout` — revoke current session (bearer)

Verifies the caller, then forwards the current token to auth-service `POST /auth/logout`.
Idempotent — returns `200` even if the token was already invalid.

Response `200`:

```json
{ "ok": true }
```

---

## 3. `GET /m/v1/me` — current user (bearer)

Composes the caller's identity by proxying to identity-roster `GET /users/:userId` (the user id
comes from the verified session, never the request body). Returns `identity.IdentityUserDetail`
— the full user record plus **effective** permissions, which the app gates its UI on.

Response `200` (`identity.IdentityUserDetail`):

```json
{
  "id": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "orgId": "org_devhub",
  "displayName": "Kotaro Takaoka",
  "email": "kotaro@developershub.jp",
  "githubLogin": "ko-tarou",
  "avatarUrl": "https://.../avatar.png",
  "status": "active",
  "roleIds": ["role_organizer"],
  "permissions": ["identity:read", "event:read", "task:read", "task:write", "notif:inbox:self"],
  "createdAt": "2026-01-10T02:00:00Z",
  "updatedAt": "2026-08-01T09:30:00Z"
}
```

- Unauthenticated (missing/invalid bearer) → `401 UNAUTHENTICATED`. The app treats 401 on `/me`
  as "logged out": attempt one silent `/m/v1/auth/refresh`, and if that also 401s, route to login.

> Note: unlike the web gateway's `GET /api/v1/me` (which returns the trimmed `gateway.MeResponse`),
> MO3's `/me` returns the fuller `IdentityUserDetail`. Both carry `permissions`; gate on that list.

---

## 4. Devices — `/m/v1/devices*` (MO3-owned)

Push-token registry, owned by MO3 (`mobile_devices`). Registration is idempotent on
`(platform, pushToken)`: re-registering the same token by the same user refreshes it; registering
it under a **different** user re-owns the row (device hand-off) and stops push to the previous user.

### 4.1 `POST /m/v1/devices` — register / refresh a push token (bearer)

Request (`mobile.RegisterDeviceRequest`):

```json
{ "platform": "ios", "pushToken": "a1b2c3...apns-or-fcm-token" }
```

- `platform` (required) — `"ios"` or `"android"`. Other → `400 VALIDATION_FAILED`
  `{ "field": "platform", "reason": "invalid" }`.
- `pushToken` (required, non-empty) — APNs device token or FCM registration token. Missing/empty →
  `400 VALIDATION_FAILED` `{ "field": "pushToken", "reason": "required" }`.

Response `201` (`mobile.RegisterDeviceResponse`):

```json
{ "deviceId": "mdev_01J9Z8Q0X7M3K2P5R8T1V4W6Y9" }
```

### 4.2 `GET /m/v1/devices` — list the caller's active devices (bearer)

Returns only the caller's own, non-disabled devices.

Response `200` (`{ devices: mobile.DeviceDto[] }`):

```json
{
  "devices": [
    { "id": "mdev_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "platform": "ios", "registeredAt": "2026-08-01T09:00:00Z" }
  ]
}
```

`DeviceDto` deliberately exposes only `id` / `platform` / `registeredAt` — never the push token.

### 4.3 `DELETE /m/v1/devices/:deviceId` — deregister a device (bearer)

Disables one of the caller's own devices (e.g. at logout). Ownership-scoped: a device that does
not exist **or** belongs to another user is treated identically.

Response `204` (no body) on success.

Errors: `404 MOBILE_DEVICE_NOT_FOUND` `{ "details": { "deviceId": "mdev_..." } }` when the device
is unknown or not the caller's.

---

## 5. BFF aggregates — `/m/v1/bff/*` (bearer)

MO3 composes these from multiple upstreams. It defines no new resource shapes — it re-packages the
owner services' DTOs.

### 5.1 `GET /m/v1/bff/home` — home screen aggregate

One round trip that yields the home screen: upcoming events, the caller's tasks, and the unread
count. **Partial-failure tolerant** — if an upstream fails, that slice degrades to its empty/zero
default (`[]` / `0`) and the response still returns `200`; the failure is not surfaced as a field
in P0 (design: never block the home screen on one slow dependency).

Fans out to: event `GET /events?sort=startsAt&limit=20`, task `GET /tasks?assigneeId=<me>&limit=20`,
notification `GET /inbox/unread-count`.

Response `200` (`mobile.MobileHomeResponse`):

```json
{
  "upcomingEvents": [
    { "id": "evt_01J9Z...", "title": "Hokuriku IT Conference", "phase": "planning", "startsAt": "2026-08-05T00:00:00Z" }
  ],
  "myTasks": [
    { "id": "task_01J9Z...", "title": "Design the landing page", "status": "in_progress", "assigneeId": "user_01J9Z..." }
  ],
  "unreadCount": 3
}
```

### 5.2 `GET /m/v1/bff/events/:eventId` — event overview + capabilities

Event summary joined with the caller's **resource-scoped** permission keys for that event (resolved
via the auth-client against identity `/authz/check`, event scope). Unlike home, the single event
source is **required** — if event-service errors, the whole call propagates that error.

Response `200` (`mobile.MobileEventOverviewResponse`):

```json
{
  "event": { "id": "evt_01J9Z...", "title": "Hokuriku IT Conference", "phase": "planning", "startsAt": "2026-08-05T00:00:00Z" },
  "capabilities": ["event:read", "event:write"]
}
```

- `capabilities` — the subset of the frozen catalog the caller holds for **this** event; the app
  uses it to show/hide edit affordances.
- Unknown event → `404 NOT_FOUND` (propagated from event-service).

---

## 6. Transparent proxy — logic-free forward (bearer)

These routes forward 1:1 to the owning service with **no** MO3 logic: the request body, query
string, response body, and error envelope (including optimistic-lock `409`) pass through unchanged.
The contract for each is the owner service's contract — MO3 only strips the `/m/v1` prefix, attaches
the trusted `x-dub-user-id`, and forwards. Read those services' contract docs for full field detail.

| MO3 route | Forwards to | Owner |
|---|---|---|
| `GET /m/v1/events` | `GET /events` | event-service |
| `GET /m/v1/events/:id` | `GET /events/:id` | event-service |
| `GET /m/v1/tasks` | `GET /tasks` | task-service |
| `GET /m/v1/tasks/:id` | `GET /tasks/:id` | task-service |
| `PATCH /m/v1/tasks/:id` | `PATCH /tasks/:id` | task-service |
| `PATCH /m/v1/actions/:id` | `PATCH /actions/:id` | event-service |
| `GET /m/v1/inbox` | `GET /inbox` | notification-service |
| `PATCH /m/v1/inbox/:id/read` | `PATCH /inbox/:id/read` | notification-service |
| `POST /m/v1/inbox/read-all` | `POST /inbox/read-all` | notification-service |
| `GET /m/v1/preferences` | `GET /preferences` | notification-service |
| `PATCH /m/v1/preferences` | `PATCH /preferences` | notification-service |

Notes:
- Pagination on the `GET` list routes is the standard cursor form (§conventions 5): `?limit=&cursor=`.
- `PATCH` bodies carry the resource `version` for optimistic concurrency; a stale version returns
  `409` with the owner's `<SERVICE>_VERSION_CONFLICT` code, passed through verbatim.
- A `204` upstream (e.g. an empty mutation) is forwarded as `204` with no body.
- These `PATCH`/`POST` routes are retried only with a client-supplied `x-dub-idempotency-key`
  (§conventions 7), forwarded downstream.

Example — `GET /m/v1/tasks?assigneeId=user_01J9Z...&limit=20` → `200` (`task.ListTasksResponse`):

```json
{
  "items": [
    {
      "id": "task_01J9Z...", "eventId": "evt_01J9Z...", "title": "Design the landing page",
      "description": null, "status": "in_progress", "priority": "high",
      "assigneeId": "user_01J9Z...", "dueAt": "2026-08-20T00:00:00Z", "origin": "manual",
      "archivedAt": null, "version": 3,
      "createdAt": "2026-08-01T00:00:00Z", "updatedAt": "2026-08-05T00:00:00Z"
    }
  ],
  "nextCursor": null
}
```

---

## 7. Offline snapshot — `GET /m/v1/sync` (bearer)

Returns a **full snapshot** of the caller's mirrored resources (all events + the caller's tasks +
the caller's inbox) so an offline client can rebuild its mirror in one catch-up. It fans out to the
three master services, draining **every** page of each (no truncation past page one), and tags each
row with its resource kind.

**Not yet differential.** The `cursor` is round-tripped as an opaque, base64url-wrapped server-time
watermark for forward-compatibility, but no upstream honours a change-since filter today, so every
pull is a fresh full snapshot (a superset of "the changes" is always safe for an upsert-merge
client). This is invisible at the wire level: when differential sync lands, the same shape gains
real semantics with no contract change.

**Fail-closed:** if any source errors, the whole pull rejects (the client retries with the *same*
cursor) so the watermark never advances past a snapshot the client did not fully receive.

Query (`mobile.SyncQuery`):

| Param | Type | Default | Notes |
|---|---|---|---|
| `cursor` | string (opaque) | — | Echo the previous response's `nextCursor`. Tampered/incompatible → `400 MOBILE_SYNC_CURSOR_EXPIRED`. Wins over `since`. |
| `since` | ISO-8601 string | — | Legacy hint; used only when no `cursor` is supplied. |
| `limit` | integer | 50 | Per-page fan-out size (not a total cap); clamped to 200. |

Response `200` (`mobile.SyncResponse` — `common.Paginated<unknown>` + `serverTime`):

```json
{
  "items": [
    { "resource": "event", "id": "evt_01J9Z...", "data": { "id": "evt_01J9Z...", "title": "Hokuriku IT Conference", "phase": "planning", "startsAt": "2026-08-05T00:00:00Z" } },
    { "resource": "task", "id": "task_01J9Z...", "data": { "id": "task_01J9Z...", "title": "Design the landing page", "status": "in_progress", "version": 3, "assigneeId": "user_01J9Z..." } },
    { "resource": "notification", "id": "ntf_01J9Z...", "data": { "id": "ntf_01J9Z...", "type": "task.assigned", "title": "New task", "body": "You were assigned a task", "readAt": null, "createdAt": "2026-08-05T00:00:00Z", "resourceType": "task", "resourceId": "task_01J9Z..." } }
  ],
  "nextCursor": "eyJ2IjoxLCJzaW5jZSI6IjIwMjYtMDgtMTBUMDU6MDA6MDBaIn0",
  "serverTime": "2026-08-10T05:00:00Z"
}
```

Each item is `{ resource: "event" | "task" | "notification", id, data }` where `data` is the
source-of-truth snapshot in its **upsert** form (the owner service's full resource shape). The
client applies each as an idempotent upsert keyed by `id`. `nextCursor` is always present (a
watermark, never `null` in the snapshot phase); persist it and send it on the next pull.

- Invalid/tampered `cursor` → `400 MOBILE_SYNC_CURSOR_EXPIRED` (`retryable: false`) — the client
  should discard its cursor and re-pull from scratch (no `cursor`).

---

## 8. Offline mutation replay — `POST /m/v1/mutations` (bearer)

A client that acted while offline replays its queued writes here as one batch. MO3 adds no business
logic: it routes each mutation to the **same** owner routes the transparent proxy exposes (§6) and
reports a **per-mutation** outcome. One bad or conflicting mutation never blocks the rest of the batch.

**Idempotency (two layers):** each mutation carries a client-minted `idempotencyKey`. Within the
batch a repeated key reuses the first outcome (returned as `status: "duplicate"`, never re-hitting
the service); across requests the key is forwarded downstream as `x-dub-idempotency-key` so the
owner service dedupes/retries.

Request (`MutationsRequest`):

```json
{
  "mutations": [
    { "idempotencyKey": "5f0c...uuid-A", "op": "task.update", "id": "task_01J9Z...", "patch": { "status": "done", "version": 3 } },
    { "idempotencyKey": "5f0c...uuid-B", "op": "inbox.read", "id": "ntf_01J9Z..." },
    { "idempotencyKey": "5f0c...uuid-C", "op": "inbox.readAll" }
  ]
}
```

Per-mutation fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idempotencyKey` | string | yes | Client-minted UUID/ULID, stable across retries of the *same* logical write. |
| `op` | enum | yes | One of `task.update`, `action.update`, `inbox.read`, `inbox.readAll`. |
| `id` | string | conditional | Target resource id; required for all ops except `inbox.readAll`. Missing → this mutation fails `VALIDATION_FAILED`. |
| `patch` | object | for update ops | Body forwarded to the owner (carries `version` for optimistic concurrency). |

Op → forwarded route:

| `op` | Forwards to | Owner |
|---|---|---|
| `task.update` | `PATCH /tasks/:id` | task-service |
| `action.update` | `PATCH /actions/:id` | event-service |
| `inbox.read` | `PATCH /inbox/:id/read` | notification-service |
| `inbox.readAll` | `POST /inbox/read-all` | notification-service |

Response `200` (`MutationsResponse`, results in request order):

```json
{
  "results": [
    { "idempotencyKey": "5f0c...uuid-A", "status": "applied", "resource": { "id": "task_01J9Z...", "status": "done", "version": 4 } },
    { "idempotencyKey": "5f0c...uuid-B", "status": "applied", "resource": { "id": "ntf_01J9Z...", "readAt": "2026-08-10T05:00:00Z" } },
    { "idempotencyKey": "5f0c...uuid-C", "status": "duplicate" }
  ]
}
```

Per-mutation `status`:

| `status` | Meaning | Extra fields |
|---|---|---|
| `applied` | Write succeeded | `resource` — the owner's updated resource |
| `conflict` | Optimistic-lock `409` from the owner (stale `version`) — reconcile against a fresh `/sync` | `error: { code, message }` |
| `duplicate` | Same `idempotencyKey` seen earlier in this batch; the first outcome stands | — |
| `error` | Any other failure (bad fields, unsupported op, upstream error) | `error: { code, message }` |

- **Envelope-level** failure (`mutations` not an array / missing) → `400 VALIDATION_FAILED`
  `{ "field": "mutations", "reason": "required" }` — the whole request is rejected.
- An unsupported `op` fails only that mutation (`status: "error"`, code
  `MOBILE_MUTATION_UNSUPPORTED_TYPE`), not the batch.

---

## 9. Internal — `POST /internal/push/dispatch` (Service Binding only)

Reached only over a Service Binding (notification-service dispatches a push here). Rejects any
request without the `x-dub-internal: 1` marker with `403 FORBIDDEN` ("internal endpoint: Service
Binding only"). Not a bearer route — the caller is a service, not a user.

MO3 expands the target user to their active devices, records a delivery per device, and sends via
the platform adapter (APNs / FCM). An empty device set is **not** an error (returns `202` with
`deviceCount: 0`). Invalid tokens auto-disable the device; hard failures are audited.

Request (`mobile.PushDispatchRequest`; `notificationId` is accepted off-wire and minted if absent):

```json
{
  "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "type": "task.assigned",
  "payload": {
    "title": "New task assigned",
    "body": "You were assigned: Design the landing page",
    "data": { "taskId": "task_01J9Z..." }
  },
  "notificationId": "mntf_01J9Z..."
}
```

- `userId` (required, non-empty), `type` (required, non-empty), `payload.title` (required,
  non-empty) — each missing/empty → `400 VALIDATION_FAILED` keyed on that field. `payload` absent
  or non-object → `{ "field": "payload", "reason": "required" }`.
- `payload.data` is an optional `Record<string, string>` (silent-data extras).

Response `202` (accepted; delivery is asynchronous):

```json
{ "accepted": true, "deviceCount": 2 }
```

`deviceCount` is the number of active devices targeted (`0` is a valid, non-error outcome).

---

## 10. Health — `GET /healthz`

Liveness probe, outside `/m/v1`, no auth.

Response `200`:

```json
{ "ok": true, "service": "mobile-bff" }
```

---

## 11. Error codes (quick reference)

Common codes and the auth codes are defined in [`_conventions.md`](./_conventions.md) §3 and
[`auth.md`](./auth.md) §11 and are not restated. MO3-owned open-half codes (`MOBILE_*`, theme3):

| Code | HTTP | `retryable` | When |
|---|---|---|---|
| `MOBILE_DEVICE_NOT_FOUND` | 404 | false | `DELETE /m/v1/devices/:id` of a device that is unknown or not the caller's. `details: { deviceId }`. |
| `MOBILE_SYNC_CURSOR_EXPIRED` | 400 | false | `/m/v1/sync` cursor is unparseable / tampered / from an incompatible version. Discard cursor and re-pull. |
| `MOBILE_MUTATION_UNSUPPORTED_TYPE` | 400 | false | A `/m/v1/mutations` entry carried an `op` outside the supported registry. Per-mutation only (batch continues). |

Cross-cutting reminders (full detail in the foundation docs):

- **401 on any bearer call** → attempt one silent `/m/v1/auth/refresh`; if that also 401s, treat as
  logged out and re-run OAuth. Auth failures surface as `UNAUTHENTICATED` / `AUTH_INVALID_TOKEN` /
  `AUTH_SESSION_EXPIRED` / `AUTH_SESSION_REVOKED` (`auth.md` §11).
- **403** → logged in but not permitted (or an internal-only route reached without the marker); do
  not send the user to login.
- **409** on a proxied `PATCH` or a mutation → optimistic-lock conflict; re-read via `/m/v1/sync`
  and retry with the fresh `version`.
- Never branch on error `message` text (5xx is redacted); branch on `code` + HTTP status.

---

## 12. Authorization

MO3 authenticates (verifies the bearer) but does **not** itself hold an authorization catalog —
authorization is resolved downstream. Two patterns:

- **Proxy / sync / mutations routes** carry the trusted `x-dub-user-id` to the owner service, which
  runs its own `requirePermission` check; a denial returns `403 FORBIDDEN` passed through verbatim.
- **`GET /m/v1/bff/events/:eventId`** resolves resource-scoped capabilities up front via the
  auth-client (identity `/authz/check`, event scope) and returns them as `capabilities` so the app
  can gate UI without a round trip per action.

The permission catalog (frozen 32 keys) and the check API are defined in [`auth.md`](./auth.md) §9–10.
