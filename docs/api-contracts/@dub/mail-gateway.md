# API Contract — @dub/mail-gateway

Outbound transactional email (multi-provider), inbound normalization / ingest, and
daily retention purge for the Dub ecosystem. Outbound is a provider abstraction over
Amazon SES / MailChannels / Resend selected by configured credentials (SES暫定,
ADR-001); inbound arrives through the Cloudflare Email Routing `email()` handler and is
de-duplicated by RFC `Message-Id`.

This document is the wire contract for the service's HTTP surface. It is bound by the
ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and
[`auth.md`](./auth.md); anything those files state (error envelope, header propagation,
cursor pagination, idempotency, trusted-header authn) applies here and is not restated.
Wire types referenced below live in `@dub/types` (`mail`, `common`) and `@dub/errors`
(`ErrorResponse`, `FieldError`, `RateLimitDetails`).

- Service package: `@dub/mail-gateway` (Cloudflare Worker + Hono)
- Source of truth read while writing this contract: `services/mail-gateway/src/{app,send,inbound,validation,rate-limit,config-check,repo,config,env}.ts`, `packages/types/src/mail.ts`, `packages/types/src/common.ts`, `packages/errors/src/wire.ts`, `services/api-gateway/src/routes.ts`
- `CONTRACT_VERSION`: `1.0.0`

---

## 1. Surface model

Three entrypoints share one Worker (`src/index.ts`):

| Entrypoint | Trigger | Handler |
|---|---|---|
| HTTP `fetch` | Service Binding (internal) and api-gateway (external subset) | the Hono app below |
| `email()` | Cloudflare Email Routing delivers an inbound RFC822 message | inbound normalize + ingest (§7). Not an HTTP surface. |
| `scheduled()` | Cron `20 3 * * *` (03:20 UTC daily) | retention purge, send_log 30d / inbound 30d (§8). Not an HTTP surface. |

The HTTP routes split into two disjoint auth surfaces, and the split is a security
boundary ("open-relay guard"), not merely a naming convention.

| Surface | Routes | Reachable via | Auth gate | Callers |
|---|---|---|---|---|
| External | `/outbox`, `/messages`, `/messages/:id`, `/threads/:id`, `/mailboxes*` | api-gateway (`/api/v1/mail/*`) | trusted `x-dub-user-id` **and** the route's `mail:*` permission | FE mail module, MO BFF |
| Internal | `/send`, `/internal/*`, `/health/quota` | Service Binding only | `x-dub-internal: 1` (presence-only in P0) | mail-automation, notification, other services' system-origin sends |

**Open-relay guard (double-defence).** The gateway config
(`services/api-gateway/src/routes.ts`, `segment: "mail"`) marks
`internalOnlyPaths: ["/mail/send", "/mail/internal/"]`, so an external client hitting
`/api/v1/mail/send` gets a gateway `404` (first line). Even if a request reached the
Worker, `POST /send` and every `/internal/*` route reject anything without
`x-dub-internal: 1` with `403 FORBIDDEN` (second line). External clients therefore
cannot drive the raw system send under any circumstance.

**Org scoping.** All routes operate against the single implicit org
`common.DUB_DEFAULT_ORG_ID` (`"org_devhub"` in P0). Clients never pass an org id.
Permission checks resolve through identity-roster `/authz/check` via `@dub/auth-client`.

### 1.1 External path prefix (gateway) — reconciliation note

The gateway strips **only** `API_PREFIX` (`/api/v1`) and preserves the `mail` segment
when forwarding to the binding: `GET /api/v1/mail/messages` →
`forwardRequest(SVC_MAIL_GATEWAY, "/mail/messages", …)`.

> **Known discrepancy (open item, not yet reconciled in code).** The Worker's Hono app
> (`src/app.ts`) currently mounts its routes at **bare** paths (`/messages`, `/outbox`,
> `/send`, …) with no `/mail` basePath, whereas identity-roster mounts its external
> routes under a segment (`app.route("/identity", ext)`). As written, a gateway-forwarded
> `/mail/messages` would not match the Worker's `/messages` route. The contract below
> documents the Worker's **actual implemented** paths. To make the external surface
> reachable, the Worker must either mount its external routes under `/mail`
> (mirroring identity-roster) **or** the gateway must strip the segment for this binding.
> Recommendation: mount under `/mail` in the Worker (least blast radius, matches the
> ecosystem pattern). Internal callers (Service Bindings) address the Worker directly and
> are unaffected either way; they use the bare paths shown here.

### 1.2 Request context headers

| Header | Constant | Meaning | Who sets it |
|---|---|---|---|
| `x-dub-request-id` | `HEADERS.requestId` | Correlation id; echoed into `ErrorResponse.error.requestId`, events, and audit. Generated as a fallback when absent (`dubContext({ allowGenerate: true })`). | gateway / caller |
| `x-dub-user-id` | `HEADERS.userId` | Trusted subject id, verified once at the gateway. Actor for external routes; if present on `/send`, `mail:send` is enforced fresh. | gateway |
| `x-dub-internal` | `HEADERS.internal` | Presence-only marker `"1"`; required by `/send` and every `/internal/*` route. | calling service (Service Binding) |
| `x-dub-idempotency-key` | `HEADERS.idempotencyKey` | Idempotency key for sends (§4.1). **Required** on `/send`; optional on `/outbox` (minted when absent). | caller |
| `x-dub-caller` | `HEADERS.caller` | Originating service name; recorded as the send `requester`. | calling service |

### 1.3 Authentication / authorization failures

| Condition | Code | HTTP |
|---|---|---|
| External route without a trusted `x-dub-user-id` | (auth-client `requireAuth`) | 401 |
| External route, user lacks the route's `mail:*` permission | `FORBIDDEN` | 403 |
| `/send` or `/internal/*` without `x-dub-internal: 1` | `FORBIDDEN` | 403 |
| `/send` with `x-dub-user-id` present but user lacks `mail:send` | `FORBIDDEN` | 403 |

Permissions used: `mail:send` (`/send`, `/outbox`), `mail:read` (`/messages*`,
`/threads/*`), `mail:admin` (`/mailboxes*`). `mail:send` is a dangerous permission, so
its check is always resolved fresh (`{ fresh: true }`).

---

## 2. Error wire form

Every error is the standard `@dub/errors` `ErrorResponse` (see `_conventions.md`):

```json
{
  "error": {
    "code": "MAIL_INVALID_REQUEST",
    "message": "mail request invalid",
    "details": [
      { "field": "to[0].email", "reason": "invalid_email" },
      { "field": "subject", "reason": "invalid_length", "message": "1..998" }
    ],
    "requestId": "req_01J...",
    "service": "mail-gateway",
    "retryable": false
  }
}
```

Codes this service returns:

| Code | HTTP | retryable | Meaning |
|---|---|---|---|
| `MAIL_INVALID_REQUEST` | 400 | false | Body / query failed validation; `details` is a `FieldError[]`. |
| `VALIDATION_FAILED` | 400 | false | Bad opaque `cursor` (`{ field: "cursor", reason: "invalid_cursor" }`). |
| `FORBIDDEN` | 403 | false | Auth gate (see §1.3). |
| `MAIL_MESSAGE_NOT_FOUND` | 404 | false | Unknown message id / empty thread. |
| `MAIL_IDEMPOTENCY_CONFLICT` | 409 | false | Same `x-dub-idempotency-key`, different request body (§4.1). |
| `MAIL_RATE_LIMITED` | 429 | true | Provider returned 429; carries `details.retryAfterSec` when the provider sent a `Retry-After` (`RateLimitDetails`). |
| `MAIL_PROVIDER_UNAVAILABLE` | 502 | true | Provider send failed after the bounded retry (network / timeout / 5xx / 2xx-without-id). |

`MAIL_RATE_LIMITED` and `MAIL_PROVIDER_UNAVAILABLE` are the only `retryable: true` codes.

---

## 3. Idempotency & delivery guarantees (frozen semantics)

**Outbound — 二重送信ゼロ (at-most-one delivery per key).** `POST /send` requires
`x-dub-idempotency-key`; `POST /outbox` mints one (`crypto.randomUUID()`) when absent.
The send-log row is claimed with `INSERT OR IGNORE` on a `UNIQUE(idempotency_key)`:

- First claim wins → assemble MIME → hand to the provider.
- A replay of a **`sent`** or in-flight **`pending`** key returns the original result
  (`status: "duplicate"`, HTTP `200`) — no second delivery.
- A **failed** key is re-attempted on the same row, reproducing the same `messageId`.
- Same key + **different body** → `409 MAIL_IDEMPOTENCY_CONFLICT` (body hashed FNV-1a).
- A lost `INSERT OR IGNORE` race re-reads and dedups to the winner's result.

The returned `messageId` is a stable RFC Message-Id derived from the send-log id, so a
replay reproduces the exact same `messageId` the first attempt returned.

**Provider retry.** A transient provider failure (network reset / timeout / HTTP 429 /
5xx) is retried with exponential backoff + jitter up to `MAIL_SEND_MAX_ATTEMPTS` (default
3 = 1 try + 2 retries, ceiling 6). Deterministic rejections (validation, unverified
domain, 2xx-without-id) fail on the first try. The DB claim stays `pending` across
attempts so a mid-retry replay still dedups.

**Inbound — 受信取りこぼしゼロ / no double-processing.** `email()` normalizes the
message and dedups by RFC `Message-Id` (`INSERT OR IGNORE` on `mail_inbound.message_id`).
An Email-Routing redelivery is a no-op; only a first-seen message publishes
`mail.message.received`.

---

## 4. Internal endpoints (`x-dub-internal: 1`)

Not exposed through the gateway. Missing `x-dub-internal: 1` → `403 FORBIDDEN`.

### 4.1 `POST /send`

Raw system-origin send. Internal binding only. Idempotency key **required**.

Headers: `x-dub-internal: 1` (required); `x-dub-idempotency-key` (required — absent →
`400 MAIL_INVALID_REQUEST` `"Idempotency-Key header required"`); `x-dub-user-id`
(optional — when present, `mail:send` is enforced fresh); `x-dub-caller` (recorded as
`requester`, defaults to the user id then `"unknown"`).

Request — `mail.SendMailRequest`:

```json
{
  "to": [{ "email": "member@example.com", "name": "Member" }],
  "cc": [{ "email": "cc@example.com" }],
  "subject": "Welcome to DevHub",
  "textBody": "Hello and welcome.",
  "htmlBody": "<p>Hello and welcome.</p>",
  "inReplyTo": "<prev-msg-id@developershub.jp>",
  "loopHeaders": { "auto-submitted": "auto-generated", "x-dub-mail-loop": "1" }
}
```

Validation (`parseSendMailRequest`): `to` is a non-empty `MailAddress[]`, max 100
recipients; each address `email` matches a basic email regex; `subject` length 1..998;
`textBody` non-empty; `cc` / `htmlBody` / `inReplyTo` optional; `loopHeaders` keys are
allowlisted to exactly `x-dub-mail-loop` and `auto-submitted` (anything else →
`not_allowlisted`). Any failure → `400 MAIL_INVALID_REQUEST` with a `FieldError[]`.

Response `202 Accepted` (freshly sent) — `mail.SendMailResponse`:

```json
{
  "messageId": "maillog_01J...@developershub.jp",
  "provider": "ses",
  "acceptedAt": "2026-08-10T00:00:00.000Z"
}
```

Response `200 OK` (idempotent replay) — the identical `mail.SendMailResponse` from the
first attempt.

Errors: bad body → `400 MAIL_INVALID_REQUEST`; missing key → `400 MAIL_INVALID_REQUEST`;
missing `x-dub-internal` → `403 FORBIDDEN`; user present without `mail:send` →
`403 FORBIDDEN`; key reused with a different body → `409 MAIL_IDEMPOTENCY_CONFLICT`;
provider 429 → `429 MAIL_RATE_LIMITED`; provider failure → `502
MAIL_PROVIDER_UNAVAILABLE`.

Side effects: on success emits `mail.message.sent` (→ notification) and a success audit
`mail.message.send`; on failure emits `mail.message.send_failed` and a failure audit.
Event/audit publish failures are logged and never turn a completed send into a 5xx.

### 4.2 `GET /internal/health`

Liveness. No auth gate. Response `200`:

```json
{ "status": "ok", "service": "mail-gateway" }
```

### 4.3 `GET /internal/health/ready`

Readiness — whether the configured provider is actually wired (credentials present) plus
non-secret tuning, so a deploy smoke-test can gate on it. **Never echoes a secret value.**
Requires `x-dub-internal: 1`.

Response `200` when ready, `503` when not (issues listed). Body — `ProviderReadiness` +
`tuning`:

```json
{
  "service": "mail-gateway",
  "provider": "ses",
  "known": true,
  "credentialsPresent": true,
  "fromAddress": "info@developershub.jp",
  "region": "ap-northeast-1",
  "ready": true,
  "issues": [],
  "tuning": { "maxAttempts": 3, "timeoutMs": 15000 }
}
```

When not ready, `ready: false` and `issues` carries secret-free strings (e.g. unknown
provider name, absent credentials, malformed `MAIL_FROM_ADDRESS`). `region` is present
only for the `ses` provider.

### 4.4 `GET /internal/status`

Live send-health self-report for an operator dashboard (FE admin). Requires
`x-dub-internal: 1`. Derives a "recently rate-limited" window from the send-log so the UI
can show a "メール送信APIが制限中" banner.

Response `200` — `{ service, provider, rateLimit }` where `rateLimit` is
`MailRateLimitStatus`:

```json
{
  "service": "mail-gateway",
  "provider": "ses",
  "rateLimit": {
    "active": true,
    "code": "MAIL_RATE_LIMITED",
    "since": "2026-08-10T00:00:00.000Z",
    "recoversAt": "2026-08-10T00:01:00.000Z",
    "cooldownSec": 60
  }
}
```

When not rate-limited: `{ "active": false, "cooldownSec": 60 }` (only `active` and
`cooldownSec` present). `active` is true iff the most recent **failed** send was a
`MAIL_RATE_LIMITED` whose timestamp is within `cooldownSec` (var
`MAIL_RATE_LIMIT_COOLDOWN_SEC`, default 60, clamp 5..86400) of now.

### 4.5 `GET /health/quota`

Minimal ops self-report (CF-routing model). Requires `x-dub-internal: 1`. Response `200`:

```json
{ "service": "mail-gateway", "provider": "ses", "inboundTransport": "cf-email-routing" }
```

---

## 5. External endpoints (`/api/v1/mail/*`)

Reached through the gateway with the caller's session identity. Each requires a trusted
`x-dub-user-id` and the listed permission. (See §1.1 for the path-prefix reconciliation
note; paths shown are the Worker's implemented paths.)

### 5.1 `POST /outbox`

User-facing compose + send. Permission: `mail:send`. Same send core as `/send` (so
二重送信ゼロ still holds per key), but the caller's session identity is the actor and
`x-dub-idempotency-key` is **optional** — a fresh key is minted when absent, so a retried
UI submit is still safe.

Request — `mail.SendMailRequest` (validated identically to §4.1). Response `202` (sent) /
`200` (idempotent replay) — `mail.SendMailResponse`. Errors as §4.1, minus the
missing-key `400` (a key is always available here).

Side effects identical to §4.1 (`mail.message.sent` / `send_failed` + audit).

### 5.2 `GET /messages`

List inbound messages (newest first), cursor-paginated. Permission: `mail:read`.

Query parameters:

| Param | Type | Notes |
|---|---|---|
| `threadId` | string | Optional filter to one thread. |
| `cursor` | string | Opaque; from a prior `nextCursor` (base64url of the last row id). Bad value → `400 VALIDATION_FAILED` (`reason: "invalid_cursor"`). |
| `limit` | number | Default 50, max 200. Out of range → `400 MAIL_INVALID_REQUEST` (`reason: "invalid_range"` / `"too_large"`). |

Response `200` — `common.Paginated<mail.MailMessage>`:

```json
{
  "items": [
    {
      "id": "mailin_01J...",
      "messageId": "<abc@sender.example>",
      "threadId": "<root@sender.example>",
      "from": { "email": "sender@example.com", "name": "Sender" },
      "to": [{ "email": "info@developershub.jp" }],
      "subject": "Question about the conference",
      "snippet": "Hi, I wanted to ask about...",
      "receivedAt": "2026-08-10T00:00:00.000Z"
    }
  ],
  "nextCursor": "bWFpbGluXzAxSg"
}
```

`nextCursor` is `null` on the last page. `MailMessage` carries no body — only a bounded
`snippet` (≤200 chars) is retained.

### 5.3 `GET /messages/:id`

Fetch one inbound message by its row `id`. Permission: `mail:read`. Response `200` —
`mail.MailMessage` (shape as an `items[]` element in §5.2). Unknown id →
`404 MAIL_MESSAGE_NOT_FOUND`.

### 5.4 `GET /threads/:id`

Fetch a whole thread (up to 200 messages, newest first). Permission: `mail:read`.

Response `200` — `{ id, messages }`:

```json
{
  "id": "<root@sender.example>",
  "messages": [
    {
      "id": "mailin_01J...",
      "messageId": "<abc@sender.example>",
      "threadId": "<root@sender.example>",
      "from": { "email": "sender@example.com" },
      "to": [{ "email": "info@developershub.jp" }],
      "subject": "Re: Question about the conference",
      "snippet": "Thanks for the reply...",
      "receivedAt": "2026-08-10T00:05:00.000Z"
    }
  ]
}
```

`messages` is `mail.MailMessage[]`. A thread with no messages → `404
MAIL_MESSAGE_NOT_FOUND`.

### 5.5 `GET /mailboxes`

List configured inbound mailboxes. Permission: `mail:admin`. Response `200` —
`{ items }` where each item is `mail.Mailbox`:

```json
{ "items": [{ "address": "info@developershub.jp" }] }
```

### 5.6 `POST /mailboxes/:id`

Create or update a mailbox's address (upsert by `:id`). Permission: `mail:admin`.

Request:

```json
{ "address": "info@developershub.jp" }
```

`address` is required and must be a string; missing / wrong type →
`400 MAIL_INVALID_REQUEST` (`"address required"`). New rows record
`provider: "cf-email-routing"`.

Response `200` — the upserted pair:

```json
{ "id": "info", "address": "info@developershub.jp" }
```

---

## 6. Wire types (frozen `@dub/types` `mail`)

```ts
interface MailAddress { email: string; name?: string; }

interface SendMailRequest {
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;              // Message-Id being replied to
  loopHeaders?: MailLoopHeaders;   // allowlist: x-dub-mail-loop, auto-submitted
}

interface SendMailResponse {
  messageId: string;               // stable RFC Message-Id (replayable)
  provider: "ses" | "mailchannels" | "resend";
  acceptedAt: string;              // ISO8601
}

interface MailMessage {
  id: string;                      // row id (mailin_*)
  messageId: string;               // RFC Message-Id
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  subject: string;
  snippet: string;                 // ≤200 chars; no body persisted
  receivedAt: string;              // ISO8601
}

interface MailLoopHeaders { "x-dub-mail-loop"?: string; "auto-submitted"?: string; }

interface Mailbox { address: string; }   // ② STUB (pending 9-B); listed as { address }
```

`common.Paginated<T> = { items: T[]; nextCursor: string | null }`. Idempotency key,
`x-dub-caller`, and the retry/rate-limit tuning are **not** wire fields on
`SendMailRequest` — they travel as headers / server config.

---

## 7. Inbound ingest (`email()` — not an HTTP route)

Cloudflare Email Routing delivers a raw RFC822 message to the Worker's `email()`
handler. It is documented here because it is a contract-bearing ingress, but it has no
request/response body a client can call.

1. Read a bounded prefix of the raw stream (`INBOUND_RAW_READ_BYTES` = 64 KiB; only
   headers + snippet are needed, the body is never persisted).
2. Normalize (`parseInbound`) into `mail.MailMessage`:
   - `messageId` = RFC `Message-Id` (fallback `nomsgid-<ulid>` when absent).
   - `threadId` = first `References` token, else `In-Reply-To`, else the message's own
     `messageId` (a new thread).
   - `from` / `to` parsed from headers (falling back to the envelope), `subject`
     RFC2047-decoded, `snippet` ≤200 chars, `receivedAt` from `Date` (else now).
   - Loop-prevention headers (`auto-submitted`, `x-dub-mail-loop`) are passed through
     untouched — the loop decision belongs to mail-automation, not here.
3. Dedup by `Message-Id` (`INSERT OR IGNORE`); a redelivery is a no-op.
4. On first-seen only, publish `mail.message.received` (→ mail-automation). A publish
   failure is re-thrown so Email Routing can retry.

**Cross-service inbound view.** `@dub/mail-gateway` also exports `InboundMailView`
(`extends mail.MailMessage` with optional `mailbox` / `headers` / `references`), the
shape mail-automation consumes. It is a superset reconciliation type, kept structurally
identical to mail-automation's mirror; the HTTP read routes (§5.2–5.4) return the frozen
`mail.MailMessage` subset only.

---

## 8. Retention purge (`scheduled()` — Cron)

Cron `20 3 * * *` (03:20 UTC daily). Deletes `mail_send_log` rows older than 30 days and
`mail_inbound` rows older than 30 days (`SEND_LOG_RETENTION_DAYS` /
`INBOUND_RETENTION_DAYS`). Returns `{ sendLog, inbound }` deleted counts (logged, not a
wire response).

---

## 9. Domain events emitted (frozen catalog)

| Event | When | Consumer (queue binding) |
|---|---|---|
| `mail.message.sent` | send succeeded | notification (`EVT_NOTIFICATION`) |
| `mail.message.send_failed` | send failed (carries `error` code) | notification (`EVT_NOTIFICATION`) |
| `mail.message.received` | first-seen inbound message | mail-automation (`EVT_MAIL_AUTOMATION`) |

Plus a `mail.message.send` audit record (`success` / `failure`) on every send attempt
via `AUDIT_QUEUE`. All event/audit publishes are best-effort: a publish failure never
turns a completed DB action into a 5xx.
