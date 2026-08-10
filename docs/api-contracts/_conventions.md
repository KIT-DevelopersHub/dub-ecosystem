# Dub API Conventions

Status: Foundation contract (v1). This is the single source of truth for the shared
wire shape every Dub component depends on. It is a **documentation** contract — it
describes the behaviour already frozen in `@dub/errors`, `@dub/http`, `@dub/types` and
the running services, so that every component (FE1-8, MO1-3, all backend services) can
be built independently against a stable surface.

If code and this doc ever disagree, the code packages listed under **Source of truth**
win, and this doc must be corrected to match.

**Source of truth (code):**

| Concern | Package / file |
|---|---|
| Error envelope + codes | `packages/errors/src/wire.ts`, `packages/errors/src/index.ts` |
| Context headers + request id | `packages/http/src/context.ts`, `packages/observability/src/index.ts` |
| Service client (retry/timeout/idempotency) | `packages/http/src/client.ts` |
| Pagination / IDs / versioning primitives | `packages/types/src/common.ts` |
| Auth / session / permission types | `packages/types/src/auth.ts`, `packages/types/src/identity.ts`, `packages/types/src/gateway.ts` |

---

## 1. Topology & boundaries

There are exactly two **external** HTTP entrypoints. Everything else is reached only
over Cloudflare **Service Bindings** (internal, never exposed to the public internet).

| Boundary | Prefix | Audience | Notes |
|---|---|---|---|
| `api-gateway` | `/api/v1` (`common.API_PREFIX`) | Browsers (FE1-8) | Session cookie auth; the only web-facing router |
| `mo3-mobile-bff` | `/m/v1` (`common.MOBILE_API_PREFIX`) | Native apps (MO1 iOS, MO2 Android) | Bearer auth; BFF that fans out to internal services |
| internal services | service-local paths (`/authz/check`, `/verify`, ...) | Other services only | Require the `x-dub-internal` marker; reject external callers |

Only the gateway and the mobile BFF authenticate the caller and mint the trusted
`x-dub-user-id` header. Downstream services **trust** that header (they do not re-verify
tokens); this is the `trustedHeader` mode of `@dub/auth-client`. `verify` mode (calling
auth-service `/verify`) is used only at the two entrypoints.

---

## 2. Response envelope

### 2.1 Success

Success responses are **the payload itself** — there is no `{ data: ... }` wrapper. The
type is whatever the endpoint's `@dub/types` interface declares.

- `200 OK` — resource / result body.
- `201 Created` — created resource body (same shape as its `200` read form).
- `204 No Content` — mutation with nothing to return (empty body). `@dub/http` maps this
  to `undefined`.

Single resource:

```json
{
  "id": "task_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "title": "Design the landing page",
  "status": "in_progress",
  "version": 3
}
```

List (see §5 Pagination):

```json
{
  "items": [
    { "id": "task_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "title": "Design the landing page" },
    { "id": "task_01J9Z8Q0X7M3K2P5R8T1V4W6YA", "title": "Wire the auth flow" }
  ],
  "nextCursor": "eyJvIjoyMH0"
}
```

### 2.2 Failure

Every non-2xx response is a single, uniform shape — `errors.ErrorResponse`. **No endpoint
invents its own error body.** Services produce it via `@dub/errors` (`toResponse`,
`dubErrorHandler`); clients restore it via `fromResponse`.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [
      { "field": "title", "reason": "required" }
    ],
    "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "service": "task-service",
    "retryable": false
  }
}
```

Field contract:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `code` | string | yes | Machine code. A `CommonErrorCode` or a `<SERVICE>_<REASON>` code (§3). |
| `message` | string | yes | Human-readable. For 5xx it is redacted to `"Internal error"` at the boundary. |
| `retryable` | boolean | yes | Whether the *same* request may succeed on retry. Drives client backoff. |
| `details` | any | no | Code-specific structured data. For `VALIDATION_FAILED` it is `FieldError[]`. Dropped for redacted 5xx. |
| `requestId` | string | no | The `x-dub-request-id` (ULID) for this request. Present once the gateway/BFF minted one. Echo it in bug reports. |
| `service` | string | no | Originating service name, for triage. |

`isErrorResponse(body)` is the type guard; treat any 4xx/5xx body that fails the guard as
`UPSTREAM_UNAVAILABLE`.

**5xx redaction:** at the boundary, `redactInternal` (default `true`) rewrites any `status >= 500`
message to `"Internal error"` and strips `details`. Never rely on 5xx message text or
details on the client — only `code`, `retryable`, `requestId` survive.

---

## 3. Error codes

### 3.1 Common codes (closed set)

`CommonErrorCodes` in `@dub/errors/wire`. Fixed HTTP status per code:

| Code | HTTP | `retryable` default | When |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | false | Malformed / invalid input. `details: FieldError[]`. |
| `UNAUTHENTICATED` | 401 | false | No / invalid credentials. |
| `FORBIDDEN` | 403 | false | Authenticated but lacks permission. |
| `NOT_FOUND` | 404 | false | Resource does not exist (or is hidden by authz). |
| `CONFLICT` | 409 | false | State conflict, incl. optimistic-lock version mismatch. |
| `PRECONDITION_FAILED` | 412 | false | A required precondition (e.g. `If-Match`) failed. |
| `PAYLOAD_TOO_LARGE` | 413 | false | Body / upload exceeds the limit. |
| `RATE_LIMITED` | 429 | true | Throttled. `details: { retryAfterSec }`, plus `Retry-After` header. |
| `UPSTREAM_UNAVAILABLE` | 502 | true | A dependency failed / returned an unrecognized body. |
| `UPSTREAM_TIMEOUT` | 504 | true | A dependency timed out. |
| `INTERNAL` | 500 | false | Unexpected server fault. Message redacted at boundary. |

`retryable` is a **default per code**; a service may override it on a specific error.
Always read the response's `retryable`, not the table, at runtime.

### 3.2 Service-specific codes (open half)

Format: `<SERVICE>_<REASON>` in `SCREAMING_SNAKE_CASE` (e.g. `AUTH_INVALID_TOKEN`,
`TASK_CYCLE_DETECTED`, `TASK_VERSION_CONFLICT`). A service code always carries an explicit
HTTP status (it is not in `STATUS_BY_CODE`). Reasons a component should special-case
(e.g. render a distinct message) are enumerated per service in that service's contract doc;
everything else should fall back to generic handling keyed by HTTP status class.

**Optimistic-lock convention:** version mismatch surfaces as HTTP `409` with code
`<SERVICE>_VERSION_CONFLICT` (see §6).

### 3.3 Validation details

`VALIDATION_FAILED.details` is always a `FieldError[]`:

```json
{ "field": "items[2].due", "reason": "too_long", "message": "Must be before 2027-01-01" }
```

- `field` — dotted / bracketed path into the request body.
- `reason` — machine token (`required`, `too_long`, `invalid_json`, `not_allowed`, ...).
- `message` — optional human string; FE form rendering keys off `field` + `reason`.

---

## 4. Context headers

The `x-dub-*` family carries request context between the boundary and internal services.
Constants live in `@dub/observability`; parsing/minting lives only in `@dub/http`.

| Header | Direction | Meaning |
|---|---|---|
| `x-dub-request-id` | boundary -> everywhere | ULID correlation id. Minted **once** at an entrypoint (gateway / BFF / webhook-ingest / cron). Propagated unchanged. Echoed into `error.requestId`. |
| `x-dub-user-id` | boundary -> services | The authenticated user id. **Trusted** by downstream services. Absent = unauthenticated / system origin. |
| `x-dub-caller` | service -> service | Name of the calling service (correlation / logs). |
| `x-dub-internal` | service -> service | Presence-only marker, value `"1"`. Internal-only endpoints reject requests without it. |
| `x-dub-idempotency-key` | client -> service | Opt-in idempotency for non-idempotent methods (§7). |

Note (theme6): `x-dub-org-id` / `x-dub-roles` were **removed**. Authorization is never
carried in headers — it is resolved via identity `/authz/check` (see `auth.md`).

A missing `x-dub-request-id` at a non-entrypoint is a contract violation
(`HTTP_CONTEXT_MISSING`, 400). Entrypoints may generate one (`allowGenerate`).

---

## 5. Pagination

**Cursor-based only. Offset / page-number paging is forbidden** (`common.CursorQuery` /
`common.Paginated<T>`).

Request (query string):

| Param | Type | Default | Max |
|---|---|---|---|
| `cursor` | string (opaque) | — | — |
| `limit` | integer | 50 | 200 |

- `cursor` is **opaque**: the client never parses or constructs it; it only echoes the
  previous response's `nextCursor`. Encoding may change without a contract change.
- Response is `Paginated<T>`: `{ items: T[], nextCursor: string | null }`. `nextCursor === null`
  means the end of the result set.
- Batch fetch by id (where supported) uses `?ids=a,b,c` (comma-separated) instead of a cursor.

```
GET /api/v1/tasks?limit=20&cursor=eyJvIjoyMH0
```

```json
{
  "items": [ { "id": "task_...", "title": "..." } ],
  "nextCursor": "eyJvIjo0MH0"
}
```

---

## 6. IDs, time, versioning

### 6.1 IDs

- Prefix-ULID plain strings: `<prefix>_<ULID>` (e.g. `task_01J9Z...`, `user_01J9Z...`,
  `org_devhub`). Typed as plain `string` aliases in `common.ts` (no branding).
- `newId(prefix)` is the only mint. Clients treat ids as opaque.
- The canonical default org id is `org_devhub` (`common.DUB_DEFAULT_ORG_ID`).

### 6.2 Time

- All timestamps are **ISO-8601 UTC strings**: `ISODateTime` (`"2026-08-10T05:00:00Z"`),
  `ISODate` (`"2026-08-10"`).
- **Single frozen exception (theme10):** session-expiry fields carry **epoch-ms `number`** —
  `auth.SessionInfo.sessionExpiresAt` and `gateway.MeResponse.sessionExpiresAt`. Everywhere
  else, time is an ISO string.

### 6.3 Versioning (two distinct axes)

- **API version** — path prefix: `/api/v1`, `/m/v1`. A breaking change bumps the prefix
  (`v2`); additive changes (new optional field, new endpoint) stay in `v1`.
- **Resource version** — optimistic concurrency: `common.Versioned` adds `version: number`.
  Mutations send the version they read; a stale version yields `409` +
  `<SERVICE>_VERSION_CONFLICT`. This applies to all clients, mobile included (no exceptions).

---

## 7. Idempotency, retries, timeouts

Client behaviour is standardized in `@dub/http` (`createServiceClient`). External clients
(FE / mobile) should mirror it.

- `GET`, `HEAD`, `DELETE` are idempotent and **retried by default**.
- `POST`, `PATCH` are retried **only** when the caller supplies an `x-dub-idempotency-key`
  (`CallOptions.idempotencyKey`). Without a key they are attempted once.
- Retry policy: up to 3 attempts (1 + 2 retries), exponential backoff with **full jitter**,
  base 100 ms, cap 2000 ms. Retried on transport error or status in
  `{429, 500, 502, 503, 504}`.
- Per-attempt timeout defaults to 5000 ms; a timeout normalizes to `UPSTREAM_TIMEOUT` (504).
- `RATE_LIMITED` (429) responses carry a `Retry-After` header (seconds) and
  `details.retryAfterSec`. Honour it before retrying.

Idempotency keys should be client-generated UUID/ULIDs, stable across retries of the *same*
logical operation.

---

## 8. Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Path segments | lowercase kebab, plural collections | `/api/v1/event-actions` |
| Path params | prefixed-ULID ids | `/api/v1/tasks/task_01J9Z...` |
| Query params | lowerCamelCase | `?cursor=...&limit=50` |
| JSON fields | lowerCamelCase | `displayName`, `nextCursor`, `sessionExpiresAt` |
| Enum values | lowercase snake / kebab as declared in `@dub/types` | `"in_progress"`, `"web"` |
| Error codes | common: `SCREAMING_SNAKE`; service: `<SERVICE>_<REASON>` | `VALIDATION_FAILED`, `AUTH_SESSION_EXPIRED` |
| Permission keys | `<domain>:<action>` (`:self` scope suffix) | `task:write`, `notif:inbox:self` |
| Service binding names | `SVC_<UPPER_SNAKE>` | `SVC_DRIVE_PROXY` |
| Headers | `x-dub-<kebab>` | `x-dub-request-id` |

- Content type is `application/json` for request and response bodies (except binary
  file up/download on file/drive endpoints).
- Boolean fields are affirmative (`retryable`, `dangerous`, `accepted`) — no `notX`.

---

## 9. Contract-change discipline

- **Additive is safe within `v1`:** new endpoints, new optional response fields, new
  service-specific error codes.
- **Breaking requires a version bump** (`v2`) or an explicit frozen-decision review:
  removing/renaming a field, changing a type, making an optional field required, changing
  an error code's HTTP status, adding a permission key to the frozen catalog (theme2), or
  changing the epoch-ms time exception.
- Each component owns its endpoint contract doc under `docs/api-contracts/`; this file plus
  `auth.md` are the cross-cutting foundation every component may assume.
