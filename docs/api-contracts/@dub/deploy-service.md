# Dub Deploy Service API Contract

Status: Component contract (v1). Read [`_conventions.md`](../_conventions.md) first for the
shared envelope, headers, error codes, pagination, IDs, and versioning; and
[`auth.md`](../auth.md) for authn/authz. This doc only adds what is **deploy-specific**: the
`Site` / `Deployment` / `Domain` / DNS-record resource shapes, the eight HTTP endpoints, the
**async** deployment model (`202` + private job queue + status events), the write-ahead
`intent → result` audit split, the allowed-zone gate, the split-privilege CF tokens, and the
two `deploy.*` events it emits.

`@dub/deploy-service` is the **deployment orchestrator** for Cloudflare: it owns the site
registry, drives Cloudflare **Pages** deployments (async, through a private job queue that
polls the CF control plane), applies **DNS** record changes synchronously, and exposes the
zone/domain allow-list. Every privileged Cloudflare call goes through a single privileged
`cf-client` split across three minimal-scope tokens (Pages-edit / DNS-edit / Zones-read).

**Source of truth (code):**

| Concern | Code |
|---|---|
| `Site` / `Deployment` / `Domain` / request / query types | `packages/types/src/deploy.ts` |
| App assembly, middleware order, `/health` | `services/deploy-service/src/app.ts` |
| Site routes (create / list) | `services/deploy-service/src/routes/sites.ts` |
| Deployment routes (create `202` / list / get) | `services/deploy-service/src/routes/deployments.ts` |
| DNS route (create) | `services/deploy-service/src/routes/dns.ts` |
| Domain route (list) | `services/deploy-service/src/routes/domains.ts` |
| Row → wire mappers (internal columns stripped) | `services/deploy-service/src/mappers.ts` |
| Async deploy-job consumer + state machine | `services/deploy-service/src/queue.ts`, `src/jobs.ts` |
| Write-ahead audit (intent fail-close / result) | `services/deploy-service/src/audit.ts` |
| Emitted event payloads | `services/deploy-service/src/events.ts`, `packages/events/src/{payloads,catalog}.ts` |
| Injected ports (repo / cf / auth / audit / events / enqueue) | `services/deploy-service/src/deps.ts` |
| Worker entry, bindings, CF token split | `services/deploy-service/src/{index,env}.ts` |
| `infra:*` permission catalog | `packages/types/src/identity.ts` |
| Gateway mount (`deploy` segment) | `services/api-gateway/src/routes.ts` |

If code and this doc disagree, the code wins and this doc must be corrected.

---

## 1. Topology

deploy-service is an **internal** service (no public hostname). It is mounted by
`api-gateway` under the `deploy` segment (`SVC_DEPLOY`, auth `required`), with only the API
prefix stripped — so the gateway's `/api/v1/deploy/*` maps 1:1 to the service's internal
`/deploy/*`.

| Caller | External path | Internal path | Auth carried in |
|---|---|---|---|
| `api-gateway` (web/admin infra surface) | `/api/v1/deploy…` | `/deploy…` (prefix stripped) | `x-dub-user-id` (trusted; gateway verified the session) |

The service **trusts** `x-dub-user-id` and does not re-verify tokens (`trustedHeader` mode via
`@dub/auth-client`). It is **never an entry point**: `dubContext({ allowGenerate: false })`
requires an inbound `x-dub-request-id`. Every `/deploy/*` route runs `requireAuth`; a request
with no trusted user context is rejected `401 AUTH_INVALID_TOKEN` before any handler runs. All
paths below are written in their **external** `/api/v1` form; drop the prefix for the internal
service-binding form.

`GET /health` is **binding-direct only** — it lives at the root (`/health`, *not*
`/deploy/health`), so the gateway (which forwards `/deploy/*`) never reaches it. It returns
`{ ok: true, service: "deploy-service" }` and is out of scope for web/mobile clients.

**No public body-cap surface:** all write endpoints take small JSON bodies; there is no
upload path.

---

## 2. Resource shapes

The wire shapes are deliberately **narrower** than the stored rows — internal columns
(`cfProjectName`, `zoneId`, `defaultBranch`, `cfDeploymentId`, `url`, `errorMessage`,
`requestedBy`, `finishedAt`) are never exposed. Mapping lives in `mappers.ts`.

### `deploy.Site`

```json
{
  "id": "site_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "name": "devhub-landing",
  "domain": "devhub.jp",
  "createdAt": "2026-08-10T05:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`site_` ULID) | Opaque. |
| `name` | string | Logical site name; **unique**. Also seeds the CF Pages project name internally. |
| `domain` | string \| null | Primary display domain, or null. |
| `createdAt` | ISODateTime | Server-set ISO-8601 UTC. |

### `deploy.Deployment`

```json
{
  "id": "dep_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "siteId": "site_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "status": "queued",
  "commitSha": "9f1c2ab",
  "createdAt": "2026-08-10T05:00:00Z",
  "updatedAt": "2026-08-10T05:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`dep_` ULID) | Opaque. |
| `siteId` | string (`site_` ULID) | Owning site. |
| `status` | `DeploymentStatus` | `queued` \| `building` \| `live` \| `failed` (closed set). State machine §5. |
| `commitSha` | string \| null | Commit requested, or null (deploy the branch head). |
| `createdAt` / `updatedAt` | ISODateTime | `updatedAt` advances on each status transition. |

The CF-side deployment id, the live `url`, and any `errorMessage` are **internal** and do not
cross the wire; observers learn the terminal outcome via `status` and the
`deploy.deployment.status_changed` event (§7).

### `deploy.Domain`

```json
{ "name": "devhub.jp", "siteId": "", "verified": true }
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | Zone (domain) name. |
| `siteId` | string | **Always `""`** in P0 — zones are not 1:1 with sites yet (divergence tracked in code). |
| `verified` | boolean | `true` ⟺ the zone is in the local **allowed-zone** table (whether or not CF returned it). |

### DNS record (inline response of `POST /deploy/dns/records`)

There is no frozen `DnsRecord` type; the create route echoes the applied record inline:

```json
{
  "id": "3f8b0e1a2c4d5e6f7a8b9c0d1e2f3a4b",
  "zone": "devhub.jp",
  "type": "CNAME",
  "name": "www",
  "content": "devhub-landing.pages.dev"
}
```

`id` is the **Cloudflare** record id (opaque, not a `dub` ULID).

---

## 3. Endpoint map

| Method & path (external) | Permission (fresh?) | Success | Sync/async | Purpose |
|---|---|---|---|---|
| `POST /api/v1/deploy/sites` | `infra:admin` (fresh) | `201` `Site` | sync | Register a site. |
| `GET /api/v1/deploy/sites` | `infra:read` | `200` `{ items: Site[] }` | sync | List sites (no paging). |
| `POST /api/v1/deploy/deployments` | `infra:deploy` (fresh) | `202` `Deployment` | **async** | Queue a Pages deployment. |
| `GET /api/v1/deploy/deployments` | `infra:read` | `200` `ListDeploymentsResponse` | sync | List deployments (cursor-paged). |
| `GET /api/v1/deploy/deployments/{id}` | `infra:read` | `200` `Deployment` | sync | Read one deployment (poll status). |
| `POST /api/v1/deploy/dns/records` | `infra:dns` (fresh) | `201` DnsRecord | sync | Create a DNS record (allowed zones only). |
| `GET /api/v1/deploy/domains` | `infra:read` | `200` `{ items: Domain[] }` | sync | List zones with allow-list flag. |
| `GET /health` | — (binding-direct) | `200` `{ ok, service }` | sync | Liveness; not gateway-exposed. |

Permission is resolved via identity-roster `/authz/check` (see [`auth.md`](../auth.md)); a
denied key surfaces as `403 FORBIDDEN`. The three write keys (`infra:deploy`, `infra:dns`,
`infra:admin`) are **dangerous** in the frozen catalog and are checked **fresh**
(cache-bypassing) on every call; `infra:read` uses the normal cached check. There is **no
optimistic-lock version** on any resource; there is **no update/delete endpoint** for sites or
deployments (P0 is append/execute only).

---

## 4. Endpoints in detail

### 4.1 `POST /api/v1/deploy/sites` — register a site

Request (`deploy.CreateSiteRequest`):

```json
{ "name": "devhub-landing", "domain": "devhub.jp" }
```

| Field | Required | Rule |
|---|---|---|
| `name` | yes | Non-empty string. Empty/missing → `VALIDATION_FAILED` (`{ field: "name", reason: "required" }`). |
| `domain` | no | String or omit. Non-string → `{ field: "domain", reason: "invalid" }`. |

The site's CF Pages project name defaults to `name`, the zone binding is resolved later from
the allowed-zone list, and `defaultBranch` defaults to `"main"` (all internal). A `name`
already in the registry → `409 CONFLICT`. Response `201` is the full `Site` (§2). The caller
becomes the internal `createdBy`. **No audit / no event** — site creation is not in the
write-ahead audit action set.

### 4.2 `GET /api/v1/deploy/sites` — list sites

No query params, no pagination. Response `200`:

```json
{ "items": [ { "id": "site_01J9Z…", "name": "devhub-landing", "domain": "devhub.jp", "createdAt": "2026-08-10T05:00:00Z" } ] }
```

Ordered newest-first (`createdAt DESC`).

### 4.3 `POST /api/v1/deploy/deployments` — queue a deployment (async)

Kicks off a Cloudflare Pages deployment **asynchronously** and returns immediately. Request
(`deploy.CreateDeploymentRequest`):

```json
{ "siteId": "site_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "commitSha": "9f1c2ab" }
```

| Field | Required | Rule |
|---|---|---|
| `siteId` | yes | Non-empty string. Empty/missing → `VALIDATION_FAILED` (`{ field: "siteId", reason: "required" }`). |
| `commitSha` | no | Commit to deploy; omit to deploy the site's `defaultBranch` head. Non-string → `{ field: "commitSha", reason: "invalid" }`. |

Ordered checks:

| Situation | Code | HTTP |
|---|---|---|
| Validation failure | `VALIDATION_FAILED` | 400 |
| `siteId` not found | `NOT_FOUND` | 404 |
| A deployment is already `queued`/`building` for that site (single-flight guard) | `CONFLICT` | 409 |
| Write-ahead **intent** audit failed (fail-close) | `UPSTREAM_UNAVAILABLE` | 502 |

On success the service (1) writes a **write-ahead intent** audit record synchronously
(`infra.deploy.executed`, fail-close: a `502` here means the CF call never happens), (2)
persists a `queued` deployment row, (3) enqueues a private `deploy-job/v1` message, and (4)
returns **`202`** with the `queued` `Deployment`. The actual CF Pages call, status
transitions, result audit, and status event all happen later in the job consumer (§5). Poll
`GET /deploy/deployments/{id}` (§4.5) or subscribe to `deploy.deployment.status_changed` (§7)
for the outcome.

```
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "id": "dep_01J9Z…", "siteId": "site_01J9Z…", "status": "queued", "commitSha": "9f1c2ab",
  "createdAt": "2026-08-10T05:00:00Z", "updatedAt": "2026-08-10T05:00:00Z" }
```

### 4.4 `GET /api/v1/deploy/deployments` — list deployments

Cursor-paged ([`_conventions.md`](../_conventions.md)). Query (`deploy.ListDeploymentsQuery`):

| Param | Type | Notes |
|---|---|---|
| `siteId` | string | Filter to one site. |
| `status` | `DeploymentStatus` | `queued`\|`building`\|`live`\|`failed`. Any other value → `400 VALIDATION_FAILED` (`{ field: "status", reason: "invalid" }`). |
| `limit` | integer | Default `50`, max `200`. Non-positive / non-numeric silently falls back to `50`; larger values are clamped to `200` (no error). |
| `cursor` | string (opaque) | Echo the previous `nextCursor`. A malformed cursor is ignored (treated as no cursor). |

Response `200` (`deploy.ListDeploymentsResponse = Paginated<Deployment>`), newest-first:

```json
{
  "items": [
    { "id": "dep_01J9Z…", "siteId": "site_01J9Z…", "status": "live", "commitSha": "9f1c2ab",
      "createdAt": "2026-08-10T05:00:00Z", "updatedAt": "2026-08-10T05:03:10Z" }
  ],
  "nextCursor": "MjAyNi0wOC0xMFQwNTowMDowMFp8ZGVwXzAxSjla"
}
```

`nextCursor === null` means the end of the result set.

### 4.5 `GET /api/v1/deploy/deployments/{id}` — read one

Response `200` is the `Deployment` (§2). A malformed or unknown id → `404 NOT_FOUND`. This is
the polling surface for a `202`-queued deployment; watch `status` move `queued → building →
live | failed`.

### 4.6 `POST /api/v1/deploy/dns/records` — create a DNS record (sync)

Applies a DNS record **synchronously** against the Cloudflare zone. Request
(`deploy.CreateDnsRecordRequest`):

```json
{ "zone": "devhub.jp", "type": "CNAME", "name": "www", "content": "devhub-landing.pages.dev" }
```

| Field | Required | Rule |
|---|---|---|
| `zone` | yes | Zone id or zone name. Empty/missing → `VALIDATION_FAILED` (`{ field: "zone", reason: "required" }`). |
| `type` | yes | One of `A` \| `AAAA` \| `CNAME` \| `TXT`. Other → `{ field: "type", reason: "invalid" }`. |
| `name` | yes | Record name. Empty/missing → `{ field: "name", reason: "required" }`. |
| `content` | yes | Record value. Empty/missing → `{ field: "content", reason: "required" }`. |

Order is load-bearing:

| Step | On failure |
|---|---|
| 1. `infra:dns` (fresh) authz | `403 FORBIDDEN` |
| 2. Validation | `400 VALIDATION_FAILED` |
| 3. **Allowed-zone gate** — the zone must be in the local allow-list | `403 FORBIDDEN` (`details.zone`), **before any audit or CF call** |
| 4. Write-ahead **intent** audit (`infra.dns.changed`, fail-close) | `502 UPSTREAM_UNAVAILABLE` |
| 5. CF `createDnsRecord` | `502 UPSTREAM_UNAVAILABLE` (a local `failed` history row + failure result-audit are written first) |

On success: a local `applied` history row is written, `deploy.dns.record_changed` is emitted
(§7), a success result-audit is recorded, and the applied record is returned inline as `201`
(§2, DNS record shape). The allowed-zone gate is a **physical barrier**: a disallowed zone
never reaches the audit log or Cloudflare.

### 4.7 `GET /api/v1/deploy/domains` — list zones + allow-list flag

No params. Merges the live CF zone list with the local allowed-zone table and returns each as
a `Domain` (§2); zones present only in the local allow-list (e.g. not returned under a
read-token's scope) are appended with `verified: true` so the allow-list is always fully
observable. Response `200`:

```json
{
  "items": [
    { "name": "devhub.jp", "siteId": "", "verified": true },
    { "name": "example.com", "siteId": "", "verified": false }
  ]
}
```

---

## 5. Async deployment model & state machine

A deployment is `202`-accepted, then driven by a **private** `DEPLOY_JOBS` queue
(`deploy-job/v1`, *not* a contract event — no envelope, versioned by a literal `tag`). Status
is a closed enum with terminal `live` / `failed`:

```
queued ──▶ building ──▶ live
                   └───▶ failed
```

| Job stage | What happens |
|---|---|
| `execute` | If still `queued`, transition to `building` (emit status), then call CF `createPagesDeployment`. A CF **business** error → terminal `failed`. If CF returns terminal, finalize; if still building, schedule a `poll`. |
| `poll` | Re-read CF deployment. Terminal → finalize (`live`/`failed`). Otherwise re-enqueue with `delaySeconds`, up to a bounded poll budget; exceeding it finalizes as `failed` ("did not settle within poll budget"). |

Guarantees:

- **Idempotent** — a job whose row is already terminal (or gone) is a no-op; redelivery is
  safe.
- **Single-flight** — `POST /deploy/deployments` rejects (`409 CONFLICT`) while a `queued` /
  `building` deployment exists for the site, so at most one is in flight per site.
- **Failure isolation** — CF *business* failures are recorded as `failed` and **acked** (no
  redelivery). Only unexpected/transient infra errors `retry()` (DLQ on exhaustion).
- Each transition writes `updatedAt` and (on terminal) an internal `finishedAt`, `url`, and
  `errorMessage`; the terminal `result` audit is linked to the write-ahead intent id.

---

## 6. Error codes

deploy-service uses **only common** codes ([`_conventions.md`](../_conventions.md) §3) — it
defines **no service-specific `DEPLOY_*` codes**. Branch on `code` + HTTP status, never on
`message` text (5xx messages are redacted at the boundary).

| Code | HTTP | `retryable` | When |
|---|---|---|---|
| `AUTH_INVALID_TOKEN` | 401 | false | No trusted `x-dub-user-id` (before any handler). |
| `FORBIDDEN` | 403 | false | Missing `infra:*` permission, **or** DNS create against a zone not in the allow-list. |
| `NOT_FOUND` | 404 | false | Unknown `siteId` (deploy create) or unknown deployment id. |
| `VALIDATION_FAILED` | 400 | false | Bad/absent body field or invalid `status`/`type` value (details carry `FieldError[]`). |
| `CONFLICT` | 409 | false | Duplicate site `name`, **or** a deployment already in flight for the site. |
| `UPSTREAM_UNAVAILABLE` | 502 | (envelope) | Write-ahead intent audit failed (fail-close), or the Cloudflare control-plane call failed. |

Note `CONFLICT` is overloaded (name-duplicate vs in-flight deployment); disambiguate by
endpoint + `message`, but treat both as non-retryable client conflicts.

---

## 7. Events emitted

The service publishes canonical event envelopes (`@dub/events` `createEvent`: ULID id,
`requestId`, `actorId`), fanned out to **notification** (`EVT_NOTIFICATION`). `actorId` is the
acting `userId`, or `null` for system-origin emits (queue-driven deployment transitions where
no user is attached).

| Event | Emitted when | Payload | Subscribers |
|---|---|---|---|
| `deploy.deployment.status_changed` | Each deployment transition in the job consumer (`building`, `live`, `failed`) | `{ deploymentId, status }` | `notification` |
| `deploy.dns.record_changed` | Successful `POST /deploy/dns/records` | `{ zone, name }` | `notification` |

**Audit records** (`auditLog.AuditRecordInput`, `orgId` = the default org) use the frozen
`SYNC_AUDIT_ACTIONS` vocabulary and a two-stage write-ahead pattern:

| Action | `intent` (sync, fail-close, `502` on failure) | `result` (queue, best-effort) |
|---|---|---|
| `infra.deploy.executed` | Before enqueuing the job (`resourceType: site`) | On terminal finalize (`success` if `live`, else `failure`; `resourceType: deployment`, `details.intent_id`) |
| `infra.dns.changed` | Before the CF DNS call (`resourceType: dns_record`) | After the CF call (`success`/`failure`, linked to the intent id) |

The intent stage is **fail-close**: if the synchronous audit write fails, the privileged
Cloudflare operation is never attempted. The result stage is best-effort (a queue publish) and
never rolls back a completed CF change.

---

## 8. Cloudflare privilege model

All CF calls funnel through one `cf-client` backed by **three minimal-scope tokens** (secrets,
local only):

| Token | Scope | Used by |
|---|---|---|
| `CF_DEPLOY_TOKEN_PAGES` | Pages **edit** | Create / read Pages deployments (deploy jobs). |
| `CF_DEPLOY_TOKEN_DNS` | DNS **edit** | `POST /deploy/dns/records`. |
| `CF_DEPLOY_TOKEN_READ` | Zones / Registrar **read** | `GET /deploy/domains` (zone listing). |

No token can do more than its lane, so a compromised read path cannot mutate DNS or trigger
deployments. Tokens never cross the wire and are never logged.

---

## 9. Contract-change discipline

Additive changes (a new optional response field, a new endpoint, a new `DeploymentStatus`
value, a new DNS record `type`) stay in `v1`. Breaking changes — removing / renaming a field,
changing a type, making an optional field required, altering a code's HTTP status, changing
the async `202` model, the single-flight guard, the allowed-zone gate, or the fail-close audit
semantics — require a version bump or a frozen-decision review
([`_conventions.md`](../_conventions.md) §9). This file is the deploy-service component
contract; [`_conventions.md`](../_conventions.md) + [`auth.md`](../auth.md) are the
cross-cutting foundation it builds on.
