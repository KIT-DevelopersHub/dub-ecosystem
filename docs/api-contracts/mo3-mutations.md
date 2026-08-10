# API Contract — mo3 mutations.ts (offline write replay)

The **offline write-replay** surface of the MO3 mobile-bff Worker: the single endpoint
`POST /m/v1/mutations`. A mobile client (MO1/MO2) that took write actions while offline
queues them locally and, on reconnect, replays the queue here as **one batch**. MO3 adds
**no business logic** — it fans each queued write out to the owning master service using
the *very same* downstream routes the transparent proxy exposes (`mutations.ts`
`dispatch`), and reports a **per-mutation** outcome for each.

Three properties define this surface and are the reason it exists as its own endpoint
rather than N separate proxied calls:

| Property | Behavior |
|---|---|
| **Idempotent** | Each mutation carries a client-minted `idempotencyKey`. It is deduped **within the batch** (a replayed key never double-applies) and forwarded downstream as `x-dub-idempotency-key` so the owning service can dedupe/retry **across** requests. |
| **Batch, isolated** | One malformed / conflicting / failing mutation never aborts the batch. Only a structurally broken **envelope** rejects the whole request. |
| **Conflict-tolerant** | An optimistic-lock `409` from a service becomes that mutation's `status: "conflict"` and the batch continues. The client reconciles conflicts against the fresh snapshot it fetches from `GET /m/v1/sync`. |

This document is the wire contract for that one endpoint only. It is bound by the
ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and
[`auth.md`](./auth.md); anything those files state (success/error envelope, `x-dub-*`
header propagation, request-id minting, ID formats, time format) applies here and is not
restated. The rest of the MO3 HTTP surface (auth entry, devices, BFF aggregation, the
logic-free transparent proxy, `GET /sync`, `/internal/push/dispatch`) is out of scope; see
their own contracts.

- App package: `@dub/mobile-bff` (Cloudflare Worker + Hono), public prefix `/m/v1`
- Source of truth read while writing this contract: `apps/mo3-mobile-bff/src/{mutations,app,errors,authn}.ts`, `packages/http/src/client.ts`, `packages/observability/src/index.ts`, `packages/errors/src/{index,wire}.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0 freeze)

---

## 1. Preconditions

**MO3 is the only entrypoint mobile clients know** — MO1/MO2 never reach the api-gateway
directly. This endpoint therefore runs the entry cross-cutting chain before any replay:

1. **Fresh request id** — a new id is minted per request (`app.ts` entry middleware) and
   echoed on the response `x-dub-request-id`. Any inbound `x-dub-*` header is **ignored**
   (never trusted); the `@dub/http` client re-adds the trusted set on each downstream hop.
2. **Auth: required.** The caller must present `Authorization: Bearer <token>`. The token
   is verified **once** against auth-service (`requireAuth`, `app.ts`); `userId` is taken
   only from the verify result and is what scopes every downstream write. A missing or
   unverifiable token is `401 UNAUTHENTICATED` (see [`auth.md`](./auth.md) for the verify
   reasons).

### 1.1 Request headers

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <token>` | yes | Session credential; verified once at entry. |
| `Content-Type: application/json` | yes | Body is a JSON object; a non-JSON body is `400` (§4). |
| `Accept: application/json` | recommended | The endpoint only ever emits JSON. |

Clients send **no** `x-dub-*` headers — they are stripped/ignored at entry. In particular
the caller does **not** send `x-dub-idempotency-key`; per-mutation keys travel in the body
and MO3 sets the header on each downstream hop itself.

---

## 2. `POST /m/v1/mutations`

Replay a batch of offline writes. Auth: **required**. The endpoint returns **`200`** as
long as the envelope is well-formed and auth passes — even when every individual mutation
failed. Success/failure of each write is carried inside `results[]`, never in the HTTP
status. (The only non-2xx outcomes are auth `401` and envelope `400`; see §4.)

### 2.1 Request body — `MutationsRequest`

```json
{
  "mutations": [
    { "idempotencyKey": "k1", "op": "task.update",   "id": "tsk_01J9Z9...", "patch": { "version": 3, "status": "done" } },
    { "idempotencyKey": "k2", "op": "action.update", "id": "act_01J9ZA...", "patch": { "version": 1, "state": "checked" } },
    { "idempotencyKey": "k3", "op": "inbox.read",    "id": "ntf_01J9ZB..." },
    { "idempotencyKey": "k4", "op": "inbox.readAll" }
  ]
}
```

`mutations` is an ordered array; results are returned **in the same order** (a `duplicate`
still occupies its slot). Order matters only for the within-batch dedup rule (§2.4) — the
first occurrence of a key wins, later ones are `duplicate`.

#### Per-mutation fields — `MutationInput`

| Field | In | Type | Required | Notes |
|---|---|---|---|---|
| `idempotencyKey` | body | `string` (non-empty) | yes | Client-minted, stable across replays of the same queued write. Forwarded downstream as `x-dub-idempotency-key`. A blank/missing key makes the entry a per-mutation `error` (§4), not a batch failure. |
| `op` | body | `MutationOp` enum | yes | One of the supported ops below. An op outside the set is a per-mutation `error` with code `MOBILE_MUTATION_UNSUPPORTED_TYPE`. |
| `id` | body | `string` | conditional | Target resource id. **Required** for `task.update`, `action.update`, `inbox.read`; **ignored** for `inbox.readAll`. Missing/blank on an op that needs it → per-mutation `VALIDATION_FAILED`. |
| `patch` | body | `object` | optional | Update body forwarded verbatim to the owning service; carries the optimistic-lock `version` the service checks. Omitted → forwarded as `{}`. MO3 does not inspect or validate its contents. |

#### `op` registry — routing (`mutations.ts` `dispatch`)

Each op maps 1:1 to a downstream route on the owning service — **the identical route the
transparent proxy exposes**, so an offline replay and an online write are indistinguishable
to the master service:

| `op` | Owning service | Downstream call | `id` |
|---|---|---|---|
| `task.update` | task-service | `PATCH /tasks/{id}` (body = `patch`) | required |
| `action.update` | event-service | `PATCH /actions/{id}` (body = `patch`) | required |
| `inbox.read` | notification-service | `PATCH /inbox/{id}/read` (body = `{}`) | required |
| `inbox.readAll` | notification-service | `POST /inbox/read-all` (body = `{}`) | not used |

The registry is intentionally an **open half** — new ops are added here as offline coverage
grows; an unknown op is a *soft* per-mutation failure (`MOBILE_MUTATION_UNSUPPORTED_TYPE`),
never a hard `400` on the batch. The write authority stays with the owning service: MO3
forwards the verified `userId` and the `patch`, and the service applies its own
per-resource authz and version check.

### 2.2 Idempotency (defining behavior)

Two layers, deliberately independent:

- **Within-batch** — MO3 keeps a `Map<idempotencyKey, result>` for the batch. A second
  mutation with a key already seen in *this* batch is **not** dispatched again; it reuses
  the first mutation's outcome and is reported with `status: "duplicate"` (carrying the
  same `resource`/`error`). A replayed batch therefore never double-applies.
- **Cross-request** — the key is forwarded to the owning service as the
  `x-dub-idempotency-key` header (`@dub/http` `CallOptions.idempotencyKey`,
  `packages/observability` canonical name). Durable cross-request dedup on the service side
  (and MO3's own `mobile_mutations` ledger) lands with the offline wave; the **header
  contract is wired now** so it is transparent once that storage exists. Today, replaying
  the same key in two *separate* requests re-hits the service — the client must rely on the
  service's own idempotency for cross-request safety.

### 2.3 Conflict tolerance (defining behavior)

A `409` from any owning service (optimistic-lock version mismatch, e.g.
`TASK_VERSION_CONFLICT`) is caught and recorded as that mutation's `status: "conflict"`
with the downstream `error.code`/`error.message` preserved. **The batch continues** — one
stale write never blocks the rest. The client is expected to drop its stale queued value
and re-derive it from the next `GET /m/v1/sync` snapshot, then (optionally) re-issue the
write with the fresh `version`.

### 2.4 Response `200` — `MutationsResponse`

```json
{
  "results": [
    {
      "idempotencyKey": "k1",
      "status": "applied",
      "resource": { "id": "tsk_01J9Z9...", "version": 4, "status": "done" }
    },
    {
      "idempotencyKey": "k2",
      "status": "conflict",
      "error": { "code": "ACTION_VERSION_CONFLICT", "message": "version mismatch" }
    },
    {
      "idempotencyKey": "k3",
      "status": "applied",
      "resource": { "ok": true }
    },
    {
      "idempotencyKey": "k4",
      "status": "duplicate",
      "resource": { "updated": 3 }
    }
  ]
}
```

#### `results[]` — `MutationResult`

| Field | Type | When present |
|---|---|---|
| `idempotencyKey` | `string` | Always. Echoes the input key so the client can match a result to its queued write. Empty string `""` only when the input entry was malformed and carried no usable key. |
| `status` | `MutationStatus` | Always. One of `applied \| conflict \| duplicate \| error`. |
| `resource` | `unknown` (service DTO) | On `applied`, and on `duplicate` **iff** the first occurrence applied. The raw response body of the downstream write, forwarded as-is (MO3 re-shapes nothing). |
| `error` | `{ code: string; message: string }` | On `conflict` and `error`. On `duplicate` **iff** the first occurrence had failed. `code` is the downstream `error.code` (or `VALIDATION_FAILED` / `MOBILE_MUTATION_UNSUPPORTED_TYPE` for MO3-originated per-mutation faults). |

#### `status` semantics

| `status` | Meaning | `resource` | `error` |
|---|---|---|---|
| `applied` | The owning service accepted the write; its `2xx` body is returned. | yes | — |
| `conflict` | Downstream returned `409` (optimistic-lock version mismatch). Reconcile via `/sync`. | — | yes |
| `duplicate` | This `idempotencyKey` already appeared earlier in the same batch; the earlier outcome is mirrored (service not re-hit). | mirrors first | mirrors first |
| `error` | Any other per-mutation failure — bad entry (`VALIDATION_FAILED`), unsupported op (`MOBILE_MUTATION_UNSUPPORTED_TYPE`), or a non-409 upstream failure (e.g. `UPSTREAM_UNAVAILABLE`, `INTERNAL`), with the downstream code preserved. | — | yes |

Every `mutations[i]` produces exactly one `results[i]` at the same index — the arrays are
**length- and order-aligned**. There is no partial-body omission.

---

## 3. Authorization

| Aspect | Rule |
|---|---|
| Entry auth | `Authorization: Bearer <token>` **required**; verified once at entry. Missing/invalid → `401 UNAUTHENTICATED`. |
| Per-write authz | **Not** performed at MO3. Each mutation carries the verified `userId` downstream; the owning service (task / event / notification) re-enforces its own per-resource authz. A write the caller may not perform surfaces as that mutation's `error` (e.g. `403 FORBIDDEN` from the service), isolated to that entry — never a batch-wide failure. |

MO3 is a forwarder here: passing entry auth is necessary to call the endpoint, but it is
**not** a guarantee any individual write will be authorized. The authoritative decision
stays with each owning service, exactly as on the online proxy path.

---

## 4. Errors

Two error planes — the **request** plane (whole-request non-2xx) and the **per-mutation**
plane (a `results[]` entry with `status: "error" | "conflict"`).

### 4.1 Request-plane errors (whole request fails)

Serialized as the standard `@dub/errors` `ErrorResponse` (`_conventions.md`), carrying the
minted `requestId` and `service: "mobile-bff"`:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "validation failed",
    "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "service": "mobile-bff",
    "retryable": false,
    "details": { "fields": [{ "field": "mutations", "reason": "required" }] }
  }
}
```

| HTTP | code | Origin | When |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | mobile-bff (entry) | Missing or unverifiable bearer token. |
| 400 | `VALIDATION_FAILED` | mobile-bff | Body is not valid JSON (`field: "body"`, `reason: "invalid_json"`), **or** the envelope's `mutations` is absent / not an array (`field: "mutations"`, `reason: "required"`). |

These are the **only** ways the request returns non-2xx. A body with a well-formed
`mutations` array always returns `200`, however bad the individual entries are.

### 4.2 Per-mutation errors (request still `200`)

Carried inside `results[i].error`; they do **not** change the HTTP status.

| `results[i].status` | `error.code` | Origin | When |
|---|---|---|---|
| `error` | `VALIDATION_FAILED` | mobile-bff | Entry missing `idempotencyKey`/`op`, or an update op missing `id`. |
| `error` | `MOBILE_MUTATION_UNSUPPORTED_TYPE` | mobile-bff | `op` is outside the supported registry (§2.1). |
| `conflict` | downstream code (e.g. `TASK_VERSION_CONFLICT`) | owning service (passthrough) | Service returned `409` optimistic-lock mismatch. |
| `error` | downstream code (e.g. `FORBIDDEN`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`) | owning service (passthrough) | Any non-409 failure of the downstream write. The code/message are preserved; the failure is isolated to this entry. |

> Contract note (for reviewers): the per-mutation `error` object is intentionally the
> **narrow** `{ code, message }` pair, **not** the full `ErrorResponse` — it omits
> `requestId`/`service`/`retryable`/`details`. A client that needs the full downstream
> envelope (e.g. `retryable` to decide whether to re-queue) cannot get it from a batch
> result today and must fall back to the code. Flagging rather than silently freezing; if
> re-queue decisions need `retryable`, lift it into `MutationResult.error` in a follow-up.

---

## 5. Client replay contract (informative)

1. Queue writes locally while offline, each with a stable `idempotencyKey`.
2. On reconnect, `POST /m/v1/mutations` with the whole queue in one batch.
3. Walk `results[]` by `idempotencyKey`:
   - `applied` / `duplicate` → dequeue; adopt `resource` as the new local truth.
   - `conflict` → dequeue the stale write, then `GET /m/v1/sync` and reconcile; re-issue
     with the fresh `version` if the user's intent still holds.
   - `error` with `retryable`-looking codes (`UPSTREAM_UNAVAILABLE`, `UPSTREAM_TIMEOUT`,
     `INTERNAL`) → keep queued and retry the batch later; the same `idempotencyKey`
     makes the retry safe against downstream double-apply.
   - `error` with `VALIDATION_FAILED` / `MOBILE_MUTATION_UNSUPPORTED_TYPE` → drop; the
     write is malformed and will never succeed as-is.
