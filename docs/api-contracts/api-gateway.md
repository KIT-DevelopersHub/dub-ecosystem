# API Contract — api-gateway

The only external HTTP entrypoint for browsers (`api.developershub.jp`). It is a
**config-driven transparent proxy** onto the internal Service Bindings (it strips the
`/api/v1` prefix and nothing else), plus a small set of **gateway-owned** endpoints it
composes or terminates itself (`/me`, `/bff/home`, the public inquiry receipt, and
liveness). It enforces the cross-cutting concerns for the whole web surface: CORS,
per-client rate limiting, entry authentication, and internal-only path masking.

This document is the wire contract for the gateway's HTTP surface. It is bound by the
ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and
[`auth.md`](./auth.md); anything those files state (success/error envelope, header
propagation, pagination, IDs, time, idempotency, retries) applies here and is not
restated. Types referenced below live in `@dub/types` (`gateway`, `identity`, `event`,
`notification`, `common`, `auth`) and `@dub/errors` (`ErrorResponse`).

- Service package: `@dub/api-gateway` (Cloudflare Worker + Hono)
- Source of truth read while writing this contract: `services/api-gateway/src/{app,routes,gateway-route,proxy,auth,cors,rate-limit,context,env}.ts`, `services/api-gateway/src/handlers/{me,bff-home,public-inquiry,healthz}.ts`, `packages/types/src/{gateway,identity,event,notification,common}.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0 freeze)

---

## 1. Surface model

Everything the browser can reach is under one public prefix, `API_PREFIX` = `/api/v1`
(`common.API_PREFIX`), with a single exception — `GET /healthz`, which sits **outside**
the prefix for the platform liveness probe. Requests fall into three disjoint classes:

| Class | Paths | Handled by | Auth |
|---|---|---|---|
| Gateway-owned | `/api/v1/me`, `/api/v1/bff/home`, `/api/v1/public/inquiries` | the gateway itself (composition / receipt) | see each endpoint |
| Proxied | `/api/v1/<segment>/*` for a known segment | transparent forward to a Service Binding | per-route (`public` or `required`) |
| Liveness | `/healthz` | the gateway itself | none |

Anything else — an unknown segment, a path not under `/api/v1`, or an internal-only
sub-path (§4.2) — is a uniform **`404 GATEWAY_ROUTE_NOT_FOUND`**. There is no directory
listing and no "method not allowed": an unmatched path is always a 404.

### 1.1 Middleware order (applies to every request, both classes)

The gateway runs a fixed middleware chain before any route:

1. **CORS** — answers `OPTIONS` preflight directly (§6); on other methods, decorates the
   response with the credentialed allow-origin headers.
2. **Request id** — inherits `x-dub-request-id` if present, else mints a ULID; always
   echoed back on the response `x-dub-request-id` header (§conventions 4).
3. **Rate limit** — per client key (§7); a rejected request short-circuits with `429`
   before auth or routing runs.

Only after all three does routing dispatch to a gateway-owned handler or the proxy.

### 1.2 What the browser sends

| Header | Purpose |
|---|---|
| `Authorization: Bearer <token>` **or** `Cookie: dub_session=<token>` | Session credential. Bearer wins if both present. Web normally uses the cookie; the gateway accepts either. |
| `Origin` | Must be an allowed origin for credentialed CORS (§6). |
| `x-dub-idempotency-key` | Optional; opt-in idempotency for `POST`/`PATCH` (§conventions 7). Forwarded downstream. |
| `Content-Type: application/json` | For bodied requests (except binary file/drive up/download). |

**Clients never send `x-dub-*` context headers.** The gateway strips **all** inbound
`x-dub-*` headers on every proxied request (spoof defense) and re-mints only the trusted
set it derives itself (§4.3). A browser cannot inject `x-dub-user-id`, `x-dub-internal`,
or a forged `x-dub-request-id` into a downstream service.

---

## 2. Error wire form

Every error is the standard `@dub/errors` `ErrorResponse` (see `_conventions.md` §2.2),
always carrying the request id:

```json
{
  "error": {
    "code": "GATEWAY_ROUTE_NOT_FOUND",
    "message": "No route for /api/v1/does-not-exist",
    "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "service": "api-gateway",
    "retryable": false
  }
}
```

Two error origins:

- **Gateway-originated** — 401/403/404/413/429 and the composition-owned codes below.
  These are minted at the edge; the gateway is `error.service` (`api-gateway`).
- **Upstream passthrough** — for a proxied request the downstream response is returned
  **unchanged**, including its status and its own `error.service`/`code` (e.g. a
  `403 FORBIDDEN` from identity, a `409 TASK_VERSION_CONFLICT` from task-service). The
  gateway only substitutes an error when the hop itself fails: `502 UPSTREAM_UNAVAILABLE`
  (binding missing / transport error) or `504 UPSTREAM_TIMEOUT` (per §5 timeout).

Gateway-specific codes (all gateway-originated):

| Code | HTTP | When |
|---|---|---|
| `GATEWAY_ROUTE_NOT_FOUND` | 404 | Unknown segment, path outside `/api/v1`, or an internal-only sub-path (masked). |
| `GATEWAY_WEBSOCKET_UNSUPPORTED` | 400 | An `Upgrade: websocket` request reached a proxied route (§4.4). |
| `GATEWAY_TURNSTILE_FAILED` | 403 | Public inquiry Turnstile verification failed (§3.3). |

Common codes the gateway itself emits: `UNAUTHENTICATED` (401), `PAYLOAD_TOO_LARGE`
(413), `RATE_LIMITED` (429), `UPSTREAM_UNAVAILABLE` (502), `UPSTREAM_TIMEOUT` (504),
`VALIDATION_FAILED` (400, public inquiry only). Auth code mapping (`AUTH_INVALID_TOKEN`
etc.) is owned by auth-service `/verify` and surfaces per [`auth.md`](./auth.md) §8; at
the gateway a missing/unverifiable credential collapses to `401 UNAUTHENTICATED`.

---

## 3. Gateway-owned endpoints

These are terminated or composed by the gateway; they are **not** proxied and have no 1:1
downstream counterpart.

### 3.1 `GET /api/v1/me`

Current user + org + effective permissions. Auth: **required** (cookie or bearer).

Composition: the gateway verifies the session once, then fans out in parallel to
identity-roster for the user master (`GET /users/:id`) and the effective org-wide
permission set (`GET /internal/users/:id/permissions`, an internal call carrying
`x-dub-internal`). See [`auth.md`](./auth.md) §5 — this is the canonical `MeResponse`.

Response `200` — `gateway.MeResponse`:

```json
{
  "user": {
    "id": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "displayName": "Kotaro Takaoka",
    "avatarUrl": "https://.../avatar.png"
  },
  "orgId": "org_devhub",
  "permissions": ["identity:read", "event:read", "task:read", "task:write", "notif:inbox:self"],
  "sessionExpiresAt": 1760000000000
}
```

| Field | Type | Meaning |
|---|---|---|
| `user` | `identity.UserSummary` | `id`, `displayName`, `avatarUrl` (nullable). |
| `orgId` | string | Active org (`org_devhub` in P0). |
| `permissions` | `identity.PermissionKey[]` | **Effective**, org-wide permission keys — the list the FE gates UI on. |
| `sessionExpiresAt` | number (**epoch-ms**) | Access-token expiry (the one time exception, §conventions 6.2). Emitted as `0` when the verify response carries no session object. |

Errors: no/invalid credential → `401 UNAUTHENTICATED` (the FE treats a 401 here as
"logged out"). If identity-roster is unreachable the composition fails whole →
`502 UPSTREAM_UNAVAILABLE` / `504 UPSTREAM_TIMEOUT` (unlike `/bff/home`, `/me` does not
partially degrade).

### 3.2 `GET /api/v1/bff/home`

SPA home one-shot: a single call that returns everything the home screen needs. Auth:
**required**.

Aggregation is **failure-tolerant**. The gateway fans out to its sources in parallel with
a per-call budget; a source that fails or times out is reported in `partialErrors` and its
slice degrades to an empty/zero default — the request still returns `200`. Only a
missing/invalid session is a whole-request failure (`401`, from the auth step).

Sources (P0): upcoming events (`event-service` `/events`, sorted by `startsAt`, capped at
5) and the unread notification count (`notification` `/inbox/unread-count`). Per-call
timeout is 3000 ms.

Response `200` — `gateway.BffHomeResponse`:

```json
{
  "upcomingEvents": [
    { "id": "evt_01J9Z...", "title": "Hokuriku IT Conference", "phase": "published", "startsAt": "2026-08-05T09:00:00Z" }
  ],
  "unreadCount": 3,
  "partialErrors": []
}
```

| Field | Type | Meaning |
|---|---|---|
| `upcomingEvents` | `event.EventSummary[]` | Up to 5 nearest events (`id`, `title`, `phase`, `startsAt`). Empty if that source failed. |
| `unreadCount` | number | Unread inbox count; `0` if that source failed. |
| `partialErrors` | `gateway.UpstreamPartialError[]` | One entry per degraded source: `{ source, code }`. Empty when all sources succeeded. |

`partialErrors` entry — `source` is the upstream service name (`"event-service"`,
`"notification-service"`); `code` is the upstream `error.code` (or `"INTERNAL"` when the
failure was not a `DubError`):

```json
{ "upcomingEvents": [], "unreadCount": 0, "partialErrors": [
  { "source": "event-service", "code": "UPSTREAM_TIMEOUT" }
] }
```

Consumers must render from whatever is present and surface a soft "couldn't load X" per
`partialErrors` — a partial failure is **not** an error status.

### 3.3 `POST /api/v1/public/inquiries`

Public contact / sponsor / press inquiry receipt. Auth: **none** (public form). Bot-gated
by Cloudflare Turnstile.

The gateway validates the body, verifies the Turnstile token, then **publishes** a
`public.inquiry.received` domain event onto the notification queue (this is the gateway's
single publish exception). The gateway itself does **not** persist or notify —
notification-service owns storage, dedup, and any downstream fan-out. Success means
"accepted for processing", not "stored".

Request — `gateway.PublicInquiryRequest`:

```json
{
  "kind": "sponsor",
  "name": "Acme Corp",
  "email": "partners@acme.example",
  "message": "We'd like to sponsor the conference.",
  "turnstileToken": "0.abc123..."
}
```

| Field | Type | Rules |
|---|---|---|
| `kind` | `"general" \| "sponsor" \| "press"` | Required; other values → validation error. |
| `name` | string | Required, non-empty after trim. |
| `email` | string | Required; must match a basic `local@domain.tld` shape. |
| `message` | string | Required, non-empty after trim. |
| `turnstileToken` | string | Required; the Turnstile widget token from the browser. |

Response `200` — `gateway.PublicInquiryResponse`:

```json
{ "accepted": true }
```

Errors:

| Situation | Code | HTTP |
|---|---|---|
| Body is not valid JSON | `VALIDATION_FAILED` (`{ field: "body", reason: "invalid_json" }`) | 400 |
| Missing/invalid field(s) | `VALIDATION_FAILED` (`FieldError[]`, one per bad field: `kind`/`name`/`email`/`message`/`turnstileToken` with `reason` `required` \| `invalid`) | 400 |
| Turnstile verification failed | `GATEWAY_TURNSTILE_FAILED` | 403 |

This route is rate-limited by the same per-IP limiter as everything else (§7); it has no
auth, so abuse control is Turnstile + rate limit.

### 3.4 `GET /healthz`

Liveness probe. Public, **outside** `API_PREFIX`. Never authenticated, never rate-limit
exempt in contract but intended for the platform.

Response `200`:

```json
{ "status": "ok", "version": "1.4.2", "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9" }
```

`version` is the deployed gateway build (`GATEWAY_VERSION`, `"0.0.0"` if unset).

---

## 4. Transparent proxy (`/api/v1/<segment>/*`)

Every non-owned path under `/api/v1` is matched by its **first segment** to a fixed route
table and forwarded to that segment's Service Binding. The transform is frozen: **strip
`/api/v1` and nothing else**, preserving method, query string, and body verbatim.

```
GET  /api/v1/tasks/task_01J9Z...?limit=20   ->  binding SVC_TASK   GET /tasks/task_01J9Z...?limit=20
POST /api/v1/events                         ->  binding SVC_EVENT  POST /events
```

### 4.1 Route table (segment → binding, auth)

| Segment(s) | Binding | Auth | Notes |
|---|---|---|---|
| `auth` | `SVC_AUTH` | public | `/api/v1/auth/*` proxies 1:1 to auth-service (login/refresh/logout/test-login). See [`auth.md`](./auth.md) §2. |
| `identity` | `SVC_IDENTITY` | required | Internal-only masks: `provision`, `authz/check`, `internal/` (§4.2). |
| `events`, `actions` | `SVC_EVENT` | required | Both segments map to event-service. |
| `tasks` | `SVC_TASK` | required | |
| `gantt` | `SVC_GANTT` | required | |
| `notifications` | `SVC_NOTIFICATION` | required | Internal-only masks: `notify`, `internal/`. |
| `files` | `SVC_FILE_META` | required | Larger body cap (§4.5). Binary up/download allowed. |
| `drive` | `SVC_DRIVE_PROXY` | required | Binary up/download allowed. |
| `chat` | `SVC_CHAT` | required | HTTP only; WebSocket upgrade rejected (§4.4). |
| `mail` | `SVC_MAIL_GATEWAY` | required | User mail (`/mail/messages`, `/mail/threads`, `/mail/outbox`) proxied; `mail/send` + `mail/internal/` masked (open-relay guard). |
| `deploy` | `SVC_DEPLOY` | required | |
| `github` | `SVC_GITHUB_SYNC` | required | |
| `audit` | `SVC_AUDIT_LOG` | required | Internal-only mask: `audit/internal/log`. |
| `webhooks` | `SVC_WEBHOOK_INGEST` | required | |

- **`auth` is the only `public` segment.** All others require a valid session; the gateway
  verifies once at the edge (§4.3) and only forwards on success.
- The gateway does **not** know per-endpoint methods or shapes for proxied routes — those
  are defined by each service's own contract doc. The gateway guarantees only the
  transform, the auth gate, and the header discipline below.

### 4.2 Internal-only masking (double-defense)

Some sub-paths of an otherwise-public segment are **service-to-service only** and must
never be reachable from the web. The gateway 404s them **before** forwarding — an external
caller hitting `/api/v1/identity/authz/check` gets `404 GATEWAY_ROUTE_NOT_FOUND`, exactly
as if the path did not exist (no hint that an internal endpoint lives there). This is the
first line of defense; the receiving service independently rejects any request lacking
`x-dub-internal: 1` as the second line.

Masked post-strip paths (exact or prefix, `/`-terminated entries are prefix matches):

| Segment | Masked paths |
|---|---|
| `identity` | `/identity/users/provision`, `/identity/authz/check`, `/identity/internal/*` |
| `notifications` | `/notifications/notify`, `/notifications/internal/*` |
| `mail` | `/mail/send`, `/mail/internal/*` |
| `audit` | `/audit/internal/log` |

### 4.3 Header discipline on forward

For every proxied request the gateway rebuilds the header set:

- **Strips** all inbound `x-dub-*` (anti-spoof), plus `Host`, `Authorization`, `Cookie`
  (the token stays at the edge — downstream services never see it), and `Content-Length`
  (recomputed by the runtime).
- **Adds** the trusted context: `x-dub-request-id` (the minted/inherited id),
  `x-dub-caller: api-gateway`, and — only for `auth: required` routes after a successful
  verify — `x-dub-user-id: <verified user id>`.
- **Never adds `x-dub-internal`.** That marker is reserved for genuine service-to-service
  calls; the gateway forwarding an external request must not set it (this is what makes the
  §4.2 masks meaningful).

Downstream services **trust** `x-dub-user-id` (they do not re-verify the token) — the
`trustedHeader` mode of `@dub/auth-client` (§conventions 1).

### 4.4 WebSocket

The gateway is HTTP-only and is **not** a WebSocket transit. A proxied request carrying
`Upgrade: websocket` (e.g. toward `chat`) is rejected with
`400 GATEWAY_WEBSOCKET_UNSUPPORTED`. Real-time chat connects to the chat Durable Object
directly, not through the gateway.

### 4.5 Body size cap

Requests are capped by `Content-Length` before forwarding. Over-cap →
`413 PAYLOAD_TOO_LARGE` (`"Request body exceeds <N> bytes"`).

| Route | Default cap |
|---|---|
| `files` | 25 MiB (`FILES_MAX_BODY_BYTES`) |
| everything else | 10 MiB (`DEFAULT_MAX_BODY_BYTES`) |

Caps are env-tunable without a contract change; the numbers above are the P0 defaults.

---

## 5. Timeouts, retries, upstream failures

- **Proxy hop timeout:** 15000 ms per forwarded request; on timeout the gateway aborts and
  returns `504 UPSTREAM_TIMEOUT`. (Gateway-owned composition uses its own tighter
  budgets — 3000 ms per source in `/bff/home`.)
- **Binding missing / transport error:** `502 UPSTREAM_UNAVAILABLE`.
- **Passthrough otherwise:** any response the upstream produces — including its 4xx/5xx
  `ErrorResponse` — is returned to the client **unchanged** (status, body, `error.service`
  preserved). The gateway does not rewrite downstream errors.
- The gateway does **not** retry proxied requests. Client-side retry/idempotency follows
  §conventions 7 (retry idempotent methods; supply `x-dub-idempotency-key` for
  `POST`/`PATCH`), and the gateway forwards the idempotency key downstream.

---

## 6. CORS

Credentialed, exact-allow-list CORS (cookies cross-site require it).

- **Allowed origins (P0 default):** `https://app.developershub.jp`,
  `http://localhost:5173`, `http://localhost:3000`. Overridable via `ALLOWED_ORIGINS`
  (comma-separated) without a contract change.
- **Preflight (`OPTIONS`):** answered directly with `204`. For an allowed `Origin` it
  returns `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials:
  true`, `Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS`,
  `Access-Control-Allow-Headers: authorization,content-type,x-dub-idempotency-key`,
  `Access-Control-Max-Age: 600`. Always `Vary: Origin`.
- **Actual requests:** an allowed `Origin` gets `Access-Control-Allow-Origin: <origin>` +
  `Access-Control-Allow-Credentials: true` echoed on the response. An unknown origin gets
  **no** ACAO header — the browser blocks the read (the request may still have executed;
  CORS is a browser read-guard, not server authorization).
- The allow-origin is always the specific requesting origin, never `*` (required with
  credentials).

---

## 7. Rate limiting

Per-client fixed-window limiting, applied to **every** request (owned and proxied) before
auth/routing.

- **Client key:** `cf-connecting-ip`, falling back to `x-forwarded-for`, else a shared
  `"unknown"` bucket.
- **P0 policy:** 100 requests / 60 s window, in-memory per isolate. The policy shape is
  internal and will be swapped for the Cloudflare native Rate Limiting binding in R1
  **without** a contract change — clients must depend only on the wire signals below.
- **Response headers (always, on allowed and rejected):** `RateLimit-Limit`,
  `RateLimit-Remaining`, `RateLimit-Reset` (epoch seconds).
- **On exceed:** `429 RATE_LIMITED` with `details.retryAfterSec` and a `Retry-After`
  header (seconds). Honour it before retrying (§conventions 7). `RateLimit-Remaining` is
  `0` on a rejection.

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded",
    "details": { "retryAfterSec": 42 },
    "requestId": "01J9Z...",
    "service": "api-gateway",
    "retryable": true
  }
}
```

---

## 8. Notes for consumers

- **Only two things are gateway-owned composition:** `/me` and `/bff/home`. Everything
  else under `/api/v1` (including all of `/auth/*`) is a transparent proxy — read the
  target service's own contract doc for its request/response shapes; the gateway only
  guarantees the transform, the auth gate, header discipline, and the failure mapping in
  §5.
- **Never send `x-dub-*` headers.** They are stripped unconditionally. Auth is the
  `dub_session` cookie or a `Bearer` token; correlation ids are minted for you and echoed
  on `x-dub-request-id`.
- **`404` is deliberately ambiguous.** Unknown route and masked internal path are the same
  `GATEWAY_ROUTE_NOT_FOUND` — do not infer the existence of internal endpoints from a 404.
- **`/bff/home` degrades, `/me` does not.** Treat `partialErrors` on the home BFF as
  soft per-section failures (still `200`); a `/me` failure is a hard error.
- Pagination, cursors, the error envelope, the epoch-ms `sessionExpiresAt` exception, and
  idempotency are all governed by [`_conventions.md`](./_conventions.md) and
  [`auth.md`](./auth.md).
