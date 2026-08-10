# API Contract — audit-log

Append-only audit store for the Dub ecosystem. It records who did what, where, and
with what outcome, and serves those records back to admins. Writes come in on two
disjoint paths — a **synchronous, fail-close** HTTP write for the five actions that
must never be lost, and an **asynchronous queue consumer** for everything else.
Reads are a single `audit:read`-gated search surface. A monthly Cron archives
out-of-window rows to R2 as NDJSON and prunes them from D1.

This document is the wire contract for the service's HTTP surface. It is bound by
the ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and
[`auth.md`](./auth.md); anything those files state (envelope shapes, header
propagation, pagination, error wire form, idempotency) applies here and is not
restated. Types referenced below live in `@dub/types` (`auditLog`, `common`) and
`@dub/errors` (`ErrorResponse`).

- Service package: `@dub/audit-log` (Cloudflare Worker + Hono; also a Queue consumer and a Cron)
- Source of truth read while writing this contract: `services/audit-log/src/{app,validation,repo,queue,archive,config,env}.ts`, `services/audit-log/db/0001_audit_logs.sql`, `services/audit-log/wrangler.toml`, `packages/types/src/audit-log.ts`, `packages/events/src/api.ts`, `services/api-gateway/src/routes.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0b freeze)

---

## 1. Surface model

There are two disjoint HTTP surfaces plus two non-HTTP ingest paths. The
external/internal split is a security boundary ("double-defence"), not merely a
naming convention.

| Surface | Route(s) | Reachable via | Auth gate | Callers |
|---|---|---|---|---|
| External read | `GET /audit/logs`, `GET /audit/logs/:id` | api-gateway (`/api/v1/audit/*`, `API_PREFIX` stripped) | `x-dub-user-id` present **and** `audit:read` | FE7 admin roster (audit viewer), MO3 BFF |
| Internal write | `POST /internal/log` | Service Binding only | `x-dub-internal: 1` (presence-only in P0) | deploy-service, identity-roster (the 5 SYNC actions) |
| Internal health | `GET /internal/health` | Service Binding only | `x-dub-internal: 1` | infra / platform probes |
| Queue consumer | channel `dub-q-audit-record` | Cloudflare Queue (not HTTP) | producer trust (`publishAudit`) | every service, for async audits |
| Cron | monthly archive+prune | scheduled trigger (not HTTP) | platform | (self) |

**Double-defence.** The gateway routes only `/api/v1/*` and marks
`/audit/internal/log` as internal-only, so an external client hitting the write
path gets a gateway `404` (first line). The Worker itself mounts every write/health
route under `/internal/*` behind a marker check, so any request without
`x-dub-internal` is rejected with `404 NOT_FOUND` (second line). External clients
therefore cannot reach `/internal/log` under any circumstance. Note the Worker uses
`404` (not `403`) for a missing marker on internal routes — it mirrors the gateway's
"this route does not exist publicly" stance and does not confirm the path to an
outside caller.

**Org scoping.** Audit records are org-stamped by the producer (`orgId` in the
record body), not by a Worker-configured default. The read surface is **not**
org-filtered in P0: `audit:read` (admin) sees all orgs. `orgId` is stored and
returned but is not yet a query filter (P1).

### 1.1 Request context headers

| Header | Meaning | Who sets it |
|---|---|---|
| `x-dub-request-id` | Correlation id; echoed into `ErrorResponse.error.requestId`. Generated as a fallback if absent (`dubContext({ allowGenerate: true })`). | gateway / originating service |
| `x-dub-user-id` | Trusted subject id, verified once at the entrypoint. The actor for read authorization. | gateway (after token verification) |
| `x-dub-internal` | Presence-only marker `"1"`. Required by every `/internal/*` route. | calling service (Service Binding) |
| `x-dub-idempotency-key` | Optional on `POST /internal/log`. When present it becomes the stored record `id`, making a retry a safe no-op (`INSERT OR IGNORE`). Absent → a fresh bare ULID is minted. | sync producer (deploy / identity) |

Note (theme6): the audit read path resolves `audit:read` centrally via
`@dub/auth-client` → identity-roster `authz/check`. The service never trusts
caller-supplied roles.

### 1.2 Authentication / authorization failures

| Condition | Code | HTTP |
|---|---|---|
| Read route without `x-dub-user-id` | `AUTH_INVALID_TOKEN` | 401 |
| Read route, user lacks `audit:read` | `FORBIDDEN` | 403 |
| Internal route without `x-dub-internal: 1` | `NOT_FOUND` | 404 |

---

## 2. Error wire form

Every error is the standard `@dub/errors` `ErrorResponse` (see `_conventions.md`):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "action is not a synchronous audit action",
    "details": [
      { "field": "action", "reason": "not_in_sync_catalog", "message": "task.item.created must use Queue publishAudit, not POST /internal/log" }
    ],
    "requestId": "req_01J...",
    "service": "audit-log",
    "retryable": false
  }
}
```

Codes used by this service: `VALIDATION_FAILED` (400), `AUTH_INVALID_TOKEN` (401),
`FORBIDDEN` (403), `NOT_FOUND` (404). This service has **no** service-specific
(`AUDIT_LOG_*`) conflict codes — audit writes are idempotent, never conflicting.

---

## 3. Core data types (frozen)

All shapes come from `@dub/types` `auditLog`. The record columns mirror the D1
table `audit_logs` exactly.

### 3.1 `AuditRecordInput` (what a producer supplies)

| Field | Type | Notes |
|---|---|---|
| `action` | `string` | `"<domain>.<entity>.<verb>"`, dot-separated lowercase tokens (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`). Open vocabulary except on the sync path (§4.1). |
| `actorId` | `string \| null` | Acting user id; `null` = system actor. |
| `orgId` | `string` | Required, non-empty. |
| `result` | `"success" \| "failure" \| "denied" \| "intent"` | Outcome. `"intent"` = write-ahead record logged before the mutation is attempted. |
| `resourceType` | `string \| null` | e.g. `"event"`, `"deploy"`. |
| `resourceId` | `string \| null` | |
| `details` | `object \| null` | Small JSON, secrets stripped. **≤ 8192 bytes** serialized (`MAX_DETAILS_BYTES`). |
| `requestId` | `string` | Required, non-empty; correlation id from the producer. |
| `occurredAt` | `string` (ISO 8601 UTC) | Producer clock; must parse. |

### 3.2 `AuditRecord` (what reads return)

`AuditRecordInput` plus:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Bare ULID (no prefix — D1 exception), time-sortable. Producer-assigned (idempotency key or queue-envelope id) or minted. |
| `recordedAt` | `string` (ISO 8601 UTC) | audit-log clock (`nowIso()`), stamped at insert. |

---

## 4. Internal endpoints (`x-dub-internal: 1`)

Not exposed through the gateway. Each requires `x-dub-internal: 1`; missing →
`404 NOT_FOUND`. These carry no per-user permission gate — the internal marker is
the authorization (trusted Service Binding caller).

### 4.1 `POST /internal/log`

**Synchronous, fail-close** write for the five actions that must never be lost.
The caller blocks on the D1 insert; a failure propagates back so the caller can
abort its own mutation (write-ahead semantics). Everything else must go through the
Queue (§6) — this route rejects non-sync actions.

Request — `auditLog.AuditRecordInput` (§3.1):

```json
{
  "action": "identity.role.assigned",
  "actorId": "user_01J...",
  "orgId": "org_devhub",
  "result": "intent",
  "resourceType": "user",
  "resourceId": "user_01JTARGET...",
  "details": { "roleId": "role_organizer", "scope": "org" },
  "requestId": "req_01J...",
  "occurredAt": "2026-08-10T00:00:00Z"
}
```

Optional header `x-dub-idempotency-key: <ulid>` — becomes the stored `id`; a retry
with the same key is a no-op (`INSERT OR IGNORE`) and still returns `201` with that
id.

The **closed sync catalog** (`auditLog.SYNC_AUDIT_ACTIONS`), the only `action`
values this route accepts:

| Action | Producer |
|---|---|
| `infra.deploy.executed` | deploy-service |
| `infra.dns.changed` | deploy-service |
| `identity.role.assigned` | identity-roster |
| `identity.role.revoked` | identity-roster |
| `identity.user.provisioned` | identity-roster |

Response `201` — `auditLog.AuditLogWriteResponse`:

```json
{ "id": "01JABCDEF0123456789ABCDEFG" }
```

Errors:

| Condition | Code | HTTP | `details` |
|---|---|---|---|
| Missing `x-dub-internal` | `NOT_FOUND` | 404 | — |
| Body not an object | `VALIDATION_FAILED` | 400 | `[{ field: "(root)", reason: "invalid_type" }]` |
| Bad/absent field(s) | `VALIDATION_FAILED` | 400 | one `FieldError` per bad field (e.g. `{ field: "action", reason: "invalid_format" }`, `{ field: "result", reason: "invalid_enum" }`, `{ field: "occurredAt", reason: "invalid_datetime" }`) |
| `details` > 8192 bytes | `VALIDATION_FAILED` | 400 | `[{ field: "details", reason: "too_large" }]` |
| `action` valid but **not** in sync catalog | `VALIDATION_FAILED` | 400 | `[{ field: "action", reason: "not_in_sync_catalog" }]` |

All field errors are collected and returned together (not first-fail). The
`not_in_sync_catalog` check runs only after the record itself validates.

### 4.2 `GET /internal/health`

Service-binding liveness probe. Requires `x-dub-internal: 1` (it lives under
`/internal/*`). Response `200`:

```json
{ "status": "ok", "service": "audit-log" }
```

---

## 5. External endpoints (`/audit/*`)

Public base path via gateway: `/api/v1/audit` (gateway strips `API_PREFIX`, so the
Worker sees `/audit/*`). Every route requires `x-dub-user-id` **and** the
`audit:read` permission (P0: admins only). Order of gates: `requireAuth` (401 if no
user) → `requirePermission("audit:read")` (403 if denied).

### 5.1 `GET /audit/logs`

Cursor-paginated search over the audit store, **newest first** (`id DESC`, which is
time-sortable because ids are ULIDs). Permission: `audit:read`.

Query parameters (all optional) — `auditLog.AuditLogQuery`:

| Param | Type | Notes |
|---|---|---|
| `actorId` | string | Exact match. |
| `action` | string | Exact match, **or** prefix match when it ends in `.` — e.g. `action=deploy.` matches `deploy.*`, `action=identity.role.` matches all role events. |
| `resourceType` | string | Exact match. |
| `resourceId` | string | Exact match. |
| `result` | `success` \| `failure` \| `denied` \| `intent` | Exact match; other values → `400`. |
| `since` | ISO 8601 | Inclusive lower bound on `occurredAt` (`>= since`). |
| `until` | ISO 8601 | Exclusive upper bound on `occurredAt` (`< until`). |
| `cursor` | string | Opaque; from a prior `nextCursor`. |
| `limit` | number | Default 50, max 200. |

Response `200` — `auditLog.AuditLogPage` (= `common.Paginated<AuditRecord>`):

```json
{
  "items": [
    {
      "id": "01JABCDEF0123456789ABCDEFG",
      "action": "identity.role.assigned",
      "actorId": "user_01J...",
      "orgId": "org_devhub",
      "result": "success",
      "resourceType": "user",
      "resourceId": "user_01JTARGET...",
      "requestId": "req_01J...",
      "occurredAt": "2026-08-10T00:00:00Z",
      "recordedAt": "2026-08-10T00:00:00.123Z",
      "details": { "roleId": "role_organizer", "scope": "org" }
    }
  ],
  "nextCursor": "MDFKQUJ..."
}
```

`nextCursor` is `null` at the end of results. The cursor encodes the last row's
`id` (URL-safe base64); the next page continues from `id < <decoded>`.

Errors:

| Condition | Code | HTTP | `details` |
|---|---|---|---|
| No `x-dub-user-id` | `AUTH_INVALID_TOKEN` | 401 | — |
| Lacks `audit:read` | `FORBIDDEN` | 403 | — |
| `result` not in enum | `VALIDATION_FAILED` | 400 | `[{ field: "result", reason: "invalid_enum" }]` |
| `since`/`until` unparseable | `VALIDATION_FAILED` | 400 | `[{ field: "since", reason: "invalid_datetime" }]` |
| `limit` < 1 or non-integer | `VALIDATION_FAILED` | 400 | `[{ field: "limit", reason: "invalid_range" }]` |
| `limit` > 200 | `VALIDATION_FAILED` | 400 | `[{ field: "limit", reason: "too_large" }]` |
| `cursor` un-decodable | `VALIDATION_FAILED` | 400 | `[{ field: "cursor", reason: "invalid_cursor" }]` |

### 5.2 `GET /audit/logs/:id`

Fetch one record by id. Permission: `audit:read`.

Response `200` — a single `auditLog.AuditRecord` (same shape as an `items[]` entry
in §5.1). Unknown id → `404 NOT_FOUND`
(`{ code: "NOT_FOUND", message: "audit_log not found: <id>" }`, exact message via
`@dub/errors`).

---

## 6. Queue ingest (async writes) — `dub-q-audit-record`

The default audit path. Producers call `@dub/events` `publishAudit(env, input)`,
which sanitizes `details` (strips secret-like keys) and enqueues an
`AuditRecordEnvelopeV1` onto the `dub-q-audit-record` channel. This is a **special
channel** with its own envelope (not a `DubEventEnvelope`):

```json
{
  "type": "audit.record",
  "version": 1,
  "id": "01JQUEUEENVELOPEID...",
  "payload": { /* auditLog.AuditRecordInput, §3.1 */ }
}
```

The consumer validates the envelope (`type === "audit.record"`, `version === 1`,
`id` a string) and its payload (same rules as §4.1 **minus** the sync-catalog
check — any well-formed `action` is accepted here), then does the same idempotent
`INSERT OR IGNORE` keyed on the envelope `id`.

Delivery semantics (frozen in `wrangler.toml`):

- Batch: `max_batch_size = 25`, `max_batch_timeout = 5s`.
- Per-message: success → `ack()`; validation/transient failure → `retry()`. The
  consumer never throws out of the batch, so one poison message cannot fail its
  neighbours.
- `max_retries = 5`, then the message is routed to the DLQ
  `dub-q-audit-record-dlq`.
- Idempotent on re-delivery: the envelope `id` is the row `id`, so a redelivered
  message is a no-op.

Producers should use the sync HTTP write (§4.1) **only** for the five
`SYNC_AUDIT_ACTIONS`; all other audits go through this queue.

---

## 7. Retention, archive & prune (Cron)

- **Retention window:** `RETENTION_MONTHS = 3` (P0b tentative; final value at 9-E).
  This value is kept in lockstep with the `-3 months` guard in the
  `audit_logs_no_delete` trigger.
- **Append-only enforcement (DB-level):** `UPDATE` is fully forbidden
  (`audit_logs_no_update` → `RAISE(ABORT)`). `DELETE` is forbidden for any row whose
  `occurred_at` is still inside the retention window; only out-of-window rows can be
  physically removed. The service never issues `UPDATE`; `repo.ts` is INSERT/SELECT
  plus the archive DELETE only.
- **Monthly Cron** (`crons = ["0 0 1 * *"]`, 00:00 UTC on the 1st): select rows with
  `occurred_at < cutoff` (cutoff = now − 3 months, UTC), group by `YYYY-MM`, write
  one NDJSON object per month to R2 at `audit-archive/{YYYY-MM}.ndjson`
  (`application/x-ndjson`), then `DELETE` that same window from D1. Empty window → no
  R2 write, `archived: 0`.

The Cron is not an HTTP endpoint; its per-run summary
(`{ cutoff, archived, months }`) is emitted to logs, not returned on the wire.

---

## 8. Notes for consumers

- **Reads are admin-only (`audit:read`) and unpaged filters are ANDed.** There is no
  org filter in P0 — `audit:read` sees every org's records. Do not assume tenant
  isolation on this surface yet (P1).
- **Prefix search:** a trailing dot on `action` switches exact → prefix match. This
  is the intended way to pull "all of a domain" (`identity.`, `deploy.`, `infra.`).
- **Idempotency is the contract, not a nicety.** Both write paths key the row on a
  producer-supplied id (idempotency-key header, or the queue envelope id), and use
  `INSERT OR IGNORE`. Retrying a write is always safe and never duplicates.
- **Choosing a path:** the five `SYNC_AUDIT_ACTIONS` → `POST /internal/log`
  (fail-close, write-ahead). Everything else → `publishAudit` (async, DLQ-backed).
  Sending a non-sync action to `/internal/log` is a `400`, not a silent reroute.
- **`details` is capped at 8 KB and pre-sanitized.** Keep it small and never put
  secrets in it; `publishAudit` strips secret-like keys, but the sync path trusts the
  producer to have done so.
- Pagination, opaque cursors (`limit` default 50 / max 200), and the error envelope
  are governed by [`_conventions.md`](./_conventions.md); auth header propagation and
  the internal-marker model by [`auth.md`](./auth.md).
