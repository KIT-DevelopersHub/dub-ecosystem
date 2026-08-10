# API Contract — @dub/webhook-ingest

Single verified ingress for every external webhook the Dub ecosystem accepts
(`github`, `google-drive`, `gmail`, `stripe`). Each request is **authenticated by
its source signature** (signature = authorization), its exact bytes are deduped and —
when large — offloaded to R2, and a normalized envelope is published to a **per-source
Queue** for downstream consumers. The service also exposes a small `webhook:read`-gated
**delivery-audit** read API (reached through api-gateway) and runs a daily **retention
Cron** that prunes the dedup/record window and its R2 objects.

This document is the wire contract for the service's HTTP surface. It is bound by the
ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and [`auth.md`](./auth.md);
anything those files state (success/error envelope shapes, `x-dub-*` header propagation,
cursor pagination, error wire form, retry/idempotency) applies here and is **not**
restated. Types referenced below live in `@dub/types` (`webhook`, `common`) and
`@dub/errors` (`ErrorResponse`).

- Service package: `@dub/webhook-ingest` (Cloudflare Worker + Hono; also a per-source Queue **producer** and a retention **Cron**)
- Source of truth read while writing this contract: `services/webhook-ingest/src/{app,ingest,repo,env,cleanup,index}.ts`, `services/webhook-ingest/src/verify/{index,types,github,stubs}.ts`, `services/webhook-ingest/migrations/webhook/0001_init.sql`, `services/webhook-ingest/wrangler.toml`, `packages/types/src/webhook.ts`, `services/api-gateway/src/routes.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0 freeze)

---

## 1. Surface model

There are **three HTTP surfaces** plus two non-HTTP paths. The external/internal split
is a security boundary, not just naming.

| Surface | Route(s) | Reachable via | Auth gate | Callers |
|---|---|---|---|---|
| External ingress | `POST /hooks/:source`, `GET /hooks/:source` | Dedicated public route `hooks.developershub.jp/*` (**not** api-gateway) | Per-source **signature** verification (§3) | GitHub, Google Drive push, Stripe (Gmail Pub/Sub gated) |
| Admin read | `GET /api/v1/webhooks/deliveries`, `GET /api/v1/webhooks/deliveries/:id` | api-gateway (`/api/v1/webhooks/*`, `API_PREFIX` stripped) | `x-dub-user-id` present **and** `webhook:read` | FE7 admin (delivery audit viewer), MO3 BFF |
| Internal health | `GET /internal/health` | Service Binding only | none (probe) | infra / platform probes |
| Queue producer | channels `dub-q-wh-<source>` | Cloudflare Queue (not HTTP) | producer trust | github-sync, drive-proxy, mail-automation, … (per-source consumers) |
| Cron | daily retention sweep (`17 3 * * *`) | scheduled trigger (not HTTP) | platform | (self) |

**Ingress isolation.** External ingress is served on a **dedicated hostname**
(`hooks.developershub.jp`), deliberately **not** proxied through api-gateway (spike
isolation — a webhook storm from GitHub/Stripe must not consume gateway capacity). The
admin read surface is the *only* part reached through the gateway (segment `webhooks`,
`auth: "required"`).

**Signature = authorization.** External senders are third parties with no Dub session.
Each request authenticates itself with a source-native signature/token that the matching
verifier checks against the configured secret(s). A request that fails verification is
**never written to D1** (attacker fill-up prevention) and its failure reason is **never
returned** to the caller.

**Enabled sources (P0).** `github`, `google-drive`, `stripe` accept live traffic. `gmail`
has a complete OIDC verifier but its endpoint stays **gated** — a `POST /hooks/gmail`
currently returns `404` (see §2.1). Enablement is a config flip (`ENABLED_SOURCES`), an
additive change, not a contract break.

### 1.1 Request context headers

| Header | Surface | Meaning |
|---|---|---|
| `x-dub-request-id` | (minted here) | Ingress is an **entrypoint**: it mints a fresh ULID request id per accepted webhook and stamps it into the published envelope (`requestId`) and any `ErrorResponse.error.requestId`. |
| `x-dub-user-id` | admin read | Trusted subject id, verified once at api-gateway. The actor authorized for `webhook:read`. Absent on the ingress surface (senders are anonymous third parties). |
| source-native signature headers | ingress | e.g. `X-Hub-Signature-256` (github), `X-Goog-Channel-Token` (google-drive), `Stripe-Signature` (stripe), `Authorization: Bearer <jwt>` (gmail). Consumed by the verifier; **never** copied into the envelope. |

Only an **allow-listed** subset of source headers is copied into the published envelope
(`HEADER_ALLOWLIST`, e.g. `x-github-event` / `x-github-delivery`, `x-goog-channel-id` /
`x-goog-resource-state`, `stripe-signature`). Auth secrets are never forwarded.

### 1.2 Authentication / authorization failures

| Condition | Code | HTTP |
|---|---|---|
| Ingress: unknown / disabled source | `NOT_FOUND` | 404 |
| Ingress: signature verification fails (any reason) | `UNAUTHENTICATED` | 401 |
| Admin read without `x-dub-user-id` | `AUTH_INVALID_TOKEN` | 401 |
| Admin read, user lacks `webhook:read` | `FORBIDDEN` | 403 |

`webhook:read` is the delivery-audit permission (`webhook` domain, `auth.md` §9.2). The
service resolves it centrally via `@dub/auth-client` → identity-roster `/authz/check`; it
never trusts caller-supplied roles.

> Registration note: `webhook:read` is the sole `webhook`-domain key. The code currently
> casts it (`"webhook:read" as identity.PermissionKey`) pending its registration in the
> frozen `PERMISSION_CATALOG` union by identity-roster; the wire behaviour (403 when
> absent) is stable and unaffected by that housekeeping.

---

## 2. External ingress

### 2.1 `POST /hooks/:source` — accept a webhook

`:source` ∈ `github | google-drive | gmail | stripe`. Content type is source-defined
(usually `application/json`); the body is read as **raw bytes** because the signature is
computed over the exact bytes.

Processing order (each step's failure is terminal):

1. **Source gate** — unknown source or a source not in `ENABLED_SOURCES` → `404 NOT_FOUND`. (Indistinguishable to an outside caller: a gated `gmail` looks the same as a typo.)
2. **Size cap** — body > **1 MiB** (`MAX_BODY_BYTES`) → `413 PAYLOAD_TOO_LARGE`.
3. **Verify** — the source verifier checks the signature/token against configured secrets (current + `_NEXT` for rotation). Failure → `401 UNAUTHENTICATED` (reason logged, never returned; no D1 write).
4. **JSON well-formedness** — for small bodies (≤ 96 KiB, `OFFLOAD_THRESHOLD_BYTES`) the body must parse as JSON → else `400 VALIDATION_FAILED` (`field: "body", reason: "invalid_json"`). **Exception:** a Google Drive channel notification (notably the mandatory `sync` handshake) arrives with an **empty body** carrying state in `X-Goog-*` headers — an empty `google-drive` body is accepted as `payload: null`.
5. **Dedup + publish** — insert-if-new keyed by `(source, externalId)`; on a fresh row, offload (if > 96 KiB) to R2 then publish the envelope to the source's Queue.

**Success `200`** — body is `webhook.WebhookIngestAck`:

```json
{
  "deliveryId": "wh_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "accepted": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `deliveryId` | `string` (prefix-ULID `wh_…`) | The `webhook_deliveries.id` = the envelope id = the consumer's idempotency key. |
| `accepted` | `boolean` | `true` = new delivery, published to the Queue. `false` = **duplicate** `(source, externalId)`; not republished. In the duplicate case `deliveryId` is the **existing** row's id. |

A duplicate is still `200` (not an error): webhook senders retry aggressively and expect a
`2xx` ack. Idempotency is intentional and observable via `accepted: false`.

**Per-source dedup key & event kind** (`externalId` / `eventKind` extracted by the verifier
from headers or body — never interpreted beyond this):

| Source | `externalId` (dedup key) | `eventKind` | Signature material |
|---|---|---|---|
| `github` | `X-GitHub-Delivery` | `X-GitHub-Event` (e.g. `push`) | `X-Hub-Signature-256: sha256=<hmac>` over raw body |
| `google-drive` | `<X-Goog-Channel-Id>:<X-Goog-Message-Number>` | `X-Goog-Resource-State` (e.g. `sync`, `change`) | `X-Goog-Channel-Token` matches issued token |
| `stripe` | event `id` from the body | event `type` from the body | `Stripe-Signature` (`t=`,`v1=` HMAC + 300 s replay window) |
| `gmail` *(gated)* | Pub/Sub `message.messageId` | `gmail.push` | `Authorization: Bearer <Google OIDC JWT>` (RS256 + issuer/aud/exp + pinned SA email) |

**Errors:**

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "signature verification failed",
    "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "service": "webhook-ingest",
    "retryable": false
  }
}
```

| Situation | Code | HTTP | `retryable` |
|---|---|---|---|
| Unknown / disabled source | `NOT_FOUND` | 404 | false |
| Body over 1 MiB | `PAYLOAD_TOO_LARGE` | 413 | false |
| Signature/token invalid or missing | `UNAUTHENTICATED` | 401 | false |
| Small body not valid JSON (non-empty; non-drive-handshake) | `VALIDATION_FAILED` | 400 | false |
| Publish to Queue failed after insert | `INTERNAL` | 500 | false* |

\* On a publish failure the dedup row (and any R2 object) is **compensated** (deleted) so a
resend by the sender can succeed. The `500` message is redacted at any boundary; senders
retry per their own policy. There are **no** `WEBHOOK_*` service-specific error codes.

### 2.2 `GET /hooks/:source` — reachability handshake

Some providers (e.g. Google Drive channel-watch registration) probe the callback URL with
a `GET` before delivering events. For an **enabled** source this returns `200`; unknown or
gated sources return `404` (identical to the POST gate).

Response `200`:

```json
{ "status": "ok", "source": "google-drive" }
```

---

## 3. Verification model (per source)

The verifier is the entire authentication layer; it returns only `{ externalId, eventKind }`
on success and an internal-only `reason` on failure. It **never interprets payload**.

- **Secret rotation** — every source consults a `[current, next]` secret pool and accepts a
  match against either, so keys can be rotated with zero downtime (`GITHUB_WEBHOOK_SECRET`
  + `GITHUB_WEBHOOK_SECRET_NEXT`, etc.).
- **github** — HMAC-SHA256 of the raw body vs `X-Hub-Signature-256` (`sha256=` prefix),
  constant-time compared.
- **google-drive** — `X-Goog-Channel-Token` timing-safe-compared to the drive-proxy-issued
  token; requires `X-Goog-Channel-Id` + `X-Goog-Message-Number`.
- **stripe** — parses `Stripe-Signature` (`t`, `v1`), rejects timestamps outside a **300 s**
  tolerance (replay guard), then HMAC-verifies `"<t>.<rawBody>"`.
- **gmail** *(gated)* — validates the Google-signed OIDC JWT: RS256 signature against Google
  JWKS, `iss` ∈ Google issuers, `aud` == configured audience, `exp`/`iat` within 60 s skew,
  and — because the push `aud` is attacker-controllable — the token's `email` must equal the
  pinned push service-account and `email_verified === true`.

A failed verification is logged with its reason (`source` + `reason` fields) and surfaces to
the caller as an opaque `401` — the reason string is **not** part of the wire contract.

---

## 4. Admin delivery-audit read API

Reached through api-gateway under `/api/v1/webhooks/*` (`API_PREFIX` stripped to
`/webhooks/*`), `auth: "required"`. Every request needs a valid session (`x-dub-user-id`)
**and** the `webhook:read` permission. These are **audit metadata** reads — the raw payload
(D1 columns `queue`, `r2_key`, `body_size`, `external_id`, `request_id`) is **not** exposed
on the wire; only the projected `WebhookDelivery` shape is returned.

### 4.1 `GET /api/v1/webhooks/deliveries` — search deliveries

Cursor-paginated (`common` cursor rules; newest-first, keyset on the ULID id).

Query params:

| Param | Type | Notes |
|---|---|---|
| `source` | `github \| google-drive \| gmail \| stripe` | Optional filter. An unknown value → `400 VALIDATION_FAILED` (`field: "source", reason: "invalid"`). |
| `status` | `received \| processed \| failed` | Optional filter. |
| `cursor` | string (opaque) | Echo the previous `nextCursor`; opaque base64url of the last id. |
| `limit` | integer | Default 50, max 200. `< 1` or non-numeric → `400 VALIDATION_FAILED` (`field: "limit", reason: "invalid"`). |

Response `200` — `webhook.WebhookDeliveryPage` (= `Paginated<WebhookDelivery>`):

```json
{
  "items": [
    {
      "id": "wh_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
      "source": "github",
      "eventKind": "push",
      "status": "received",
      "receivedAt": "2026-08-10T05:00:00Z",
      "processedAt": null
    },
    {
      "id": "wh_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
      "source": "stripe",
      "eventKind": "checkout.session.completed",
      "status": "processed",
      "receivedAt": "2026-08-10T04:59:12Z",
      "processedAt": "2026-08-10T04:59:13Z"
    }
  ],
  "nextCursor": "d2hfMDFKOVo4UTBYN00zSzJQNVI4VDFWNFc2WTk"
}
```

`nextCursor === null` marks the end of the result set.

### 4.2 `GET /api/v1/webhooks/deliveries/:id` — one delivery

`:id` is a `wh_`-prefixed ULID.

Response `200` — `webhook.WebhookDelivery`:

```json
{
  "id": "wh_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "source": "github",
  "eventKind": "push",
  "status": "received",
  "receivedAt": "2026-08-10T05:00:00Z",
  "processedAt": null
}
```

Unknown id → `404 NOT_FOUND`.

`WebhookDelivery` fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` (`wh_…` ULID) | Delivery id = envelope id = consumer idempotency key. |
| `source` | `WebhookSource` | Origin (`github` / `google-drive` / `gmail` / `stripe`). |
| `eventKind` | `string` | Source-native kind (§2.1 table). |
| `status` | `received \| processed \| failed` | Lifecycle. Ingest always writes `received`; a consumer/back-channel flips it to `processed`/`failed`. |
| `receivedAt` | `string` (ISO-8601 UTC) | When ingest accepted the delivery. |
| `processedAt` | `string \| null` (ISO-8601 UTC) | When a consumer finished it, else `null`. |

---

## 5. Fan-out envelope (Queue producer contract)

On acceptance the service publishes **one** message per delivery to the source's Queue
(`dub-q-wh-<source>`; 1 Queue = 1 consumer). This is not an HTTP body but it is the payload
consumers depend on — `webhook.WebhookEventEnvelopeV1`:

```json
{
  "type": "webhook.received",
  "version": 1,
  "id": "wh_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "source": "github",
  "externalId": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  "eventKind": "push",
  "receivedAt": "2026-08-10T05:00:00Z",
  "requestId": "01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "headers": { "x-github-event": "push", "x-github-delivery": "72d3162e-...", "content-type": "application/json" },
  "payload": { "ref": "refs/heads/main" },
  "r2Key": null
}
```

| Field | Type | Meaning |
|---|---|---|
| `type` / `version` | `"webhook.received"` / `1` | Envelope discriminant + version. |
| `id` | `string` (`wh_…`) | Delivery id = idempotency key; consumers **must** dedup on it (delivery is at-least-once). |
| `source` / `externalId` / `eventKind` | strings | As in §2.1. |
| `receivedAt` / `requestId` | ISO-8601 / ULID | Ingest clock + minted correlation id. |
| `headers` | `Record<string,string>` | Allow-listed source headers only (§1.1); never secrets. |
| `payload` | `unknown \| null` | Parsed JSON body. **`null`** when the body was empty (drive `sync` handshake) **or** offloaded to R2 (body > 96 KiB) — in the latter case read `r2Key`. |
| `r2Key` | `string \| null` | R2 object key (`webhook-raw/<source>/<id>`) when the body was offloaded; else `null`. The R2 bucket is read-only on consumers. |

**At-least-once + idempotency:** a publish failure rolls back the dedup row so the sender's
resend re-enters cleanly; a successful publish that is redelivered by the Queue is absorbed
by consumer-side dedup on `id`. Exactly-once is **not** promised on the wire.

---

## 6. Retention Cron

A daily scheduled sweep (`17 3 * * *` UTC) deletes `webhook_deliveries` rows older than the
retention window (`RETENTION_DAYS`, default **30**) and best-effort deletes their R2 objects.
The dedup window, the record-retention window, and the R2-object lifetime are the **same**
30-day window (a re-delivery of an event older than 30 days is treated as new). No HTTP
surface; observability only via the `webhook retention sweep` log line
(`{ deletedRows, deletedObjects, retentionDays }`).

---

## 7. Error code summary

| Code | HTTP | Where |
|---|---|---|
| `VALIDATION_FAILED` | 400 | ingress body not JSON; admin bad `source`/`limit` |
| `UNAUTHENTICATED` | 401 | ingress signature/token invalid |
| `AUTH_INVALID_TOKEN` | 401 | admin read without a session |
| `FORBIDDEN` | 403 | admin read lacking `webhook:read` |
| `NOT_FOUND` | 404 | unknown/disabled source; unknown delivery id |
| `PAYLOAD_TOO_LARGE` | 413 | ingress body > 1 MiB |
| `INTERNAL` | 500 | publish failure after dedup insert (row compensated) |

Every error is the standard `@dub/errors` `ErrorResponse` envelope; this service defines
**no** `WEBHOOK_*` service-specific codes and has no optimistic-lock conflicts (webhook
writes are insert-or-ignore, never version-conflicting).

---

## 8. Contract-change discipline

Additive within `v1` (safe): enabling a currently-gated source (`gmail`), a new
`WebhookSource`, a new allow-listed header, a new optional envelope field. Breaking (needs
review / version bump): changing `WebhookIngestAck` / `WebhookDelivery` shapes, the envelope
`version`, the dedup key derivation, the `(source, externalId)` uniqueness semantics, or the
`webhook:read` gate. This doc owns the `@dub/webhook-ingest` endpoint contract; the
cross-cutting rules in `_conventions.md` and `auth.md` are assumed, not restated.
