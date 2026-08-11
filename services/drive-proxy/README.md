# drive-proxy (unit #11)

The single window onto Google Drive/Docs/Sheets/Forms for the DevHub (Dub)
ecosystem. A thin adapter over the Google APIs plus one-place management of the
Google token, rate limit and response cache. Drive **file metadata** stays with
`file-meta-service` (the source of truth); this service's only D1 (`DB`) holds its
**own** Drive-watch channel registry (`drive_watch_channels`) — channel lifecycle
state, not file metadata. Otherwise it holds KV + Queues + Workers Secrets.

Design source of truth: `設計_P0a/services_連携/drive-proxy.md` + P0b frozen summary.

## Endpoints (internal paths — api-gateway strips `API_PREFIX`)

| Method/Path | Perm | Notes |
|---|---|---|
| `GET /drive/files?folderId=&cursor=&limit=&kind=&q=` | `drive:read` | folder listing, cursor paging (limit ≤ 100) |
| `GET /drive/files/:id` | `drive:read` | single-file metadata passthrough |
| `GET /drive/files/:id/embed` | `drive:read` | kind-specific embed URL (folders → 400) |
| `POST /drive/files` | `drive:write` | blank create or template copy (`templateFileId`) |
| `POST /drive/files/:id/move` | `drive:write` | re-parent |
| `POST /drive/files/:id/trash` | `drive:write` | trash (re-trash is idempotent 200) |
| `GET /drive/sheets/:id/values?range=` | `drive:read` | A1 read |
| `POST /drive/sheets/:id/values` | `drive:write` | update / append |
| `GET /drive/health/quota` | internal-only (`x-dub-internal`) | soft-rate self-report |
| `POST /drive/watch` | internal-only (`x-dub-internal`) | open a `files.watch` channel on `{ fileId, ttlSeconds? }`; 201 `{ channel }` (no token) |
| `POST /drive/watch/:channelId/stop` | internal-only (`x-dub-internal`) | close a channel (idempotent) |

## Events (§4)

- Publishes `drive.file.created|moved|trashed` (canonical `DubEventEnvelope`) →
  `file-meta` via queue binding `EVT_FILE_META`. Payloads are the frozen minimal
  `{ driveFileId }` shape.
- Every write op also emits `publishAudit()` (`drive.file.create|move|trash`,
  `drive.sheet.write`) → `AUDIT_QUEUE`. audit-log does **not** subscribe to domain
  events. The retired `drive.sheet.written` domain event is intentionally not
  published (sheet writes are audit-only).
- Watch admin ops are audit-only too (`drive.watch.create|stop` → `AUDIT_QUEUE`,
  keyed to the watched `fileId`).
- `wh-google-drive` **consumer** (processing notifications) is still reserved
  (contract only; enabled with the P1 Drive-watch consumer). The **producer** side —
  issuing the channel token — is implemented (see below).

### Free-tier (no paid Queues) — `@dub/freeq` outbox

Cloudflare Queues are a Workers **paid** feature. For a free-plan deploy the two
producer bindings (`EVT_FILE_META` / `AUDIT_QUEUE`) are absent and
`buildPublisherEnv()` (`src/outbox.ts`) transparently falls back to a
[`@dub/freeq`](../../packages/freeq) **D1 outbox** (`freeq_outbox` on the shared
`dub-core` D1, binding `OUTBOX_DB`) — nothing above the `createEventPublisher` seam
changes, and no event/audit record is dropped (the producer `INSERT` is the durability
guarantee). A daily Cron (`scheduled` handler → `runOutboxDrain`, `src/drain.ts`)
forwards `audit.record` rows to audit-log `POST /internal/audit-async` (over `SVC_AUDIT`,
the exact `AuditRecordEnvelopeV1` verbatim) and **defers** `evt.file-meta` domain events
(they stay durable/`pending` until file-meta's free-tier consumer route lands — never
lost, never mislabeled done). Deploy with `wrangler.free.toml` (apply
`db/0001_freeq_outbox.sql` to `dub-core` once). The paid `wrangler.toml` is unchanged, so
the queue-wiring conformance guard keeps passing.

## Drive-watch (channel-token issuance)

drive-proxy is the **issuing side** of the Google Drive push-channel token that
`webhook-ingest` verifies. `POST /drive/watch` calls Drive `files.watch` with
`token = DRIVE_WEBHOOK_TOKEN` (current rotation slot) and
`address = DRIVE_WATCH_CALLBACK_URL` (the webhook-ingest google-drive ingress).
Google echoes that token back as `X-Goog-Channel-Token` on every notification, and
`webhook-ingest`'s `verifyGoogleDrive`
(`services/webhook-ingest/src/verify/stubs.ts`) checks it against its `driveTokens`
pool (`DRIVE_WEBHOOK_TOKEN[_NEXT]`) — **these values MUST match on both services.**

- The channel is persisted in the `drive_watch_channels` D1 registry (channel id,
  Google `resourceId`, watched `fileId`, `token_version`, `expiration`, status) so it
  can be stopped/renewed and inbound notifications correlated by channel/resource id.
- The **token is a secret**: it is never returned to callers and never written to
  D1 — only which rotation slot minted it (`token_version`) is recorded.
- `POST /drive/watch/:channelId/stop` calls Drive `channels.stop` and flips the row
  to `stopped`; both stop and a Google `404` are idempotent.
- Watch/stop consume the shared soft rate-limit budget (they count against Google
  quota). `src/google/client.ts` owns the raw `files.watch` / `channels.stop` calls;
  `src/watch/{service,repo}.ts` own orchestration and the D1 registry;
  `migrations/drive/0001_init.sql` is the registry DDL (infra #28 owns the physical
  apply; `applyDriveMigrations` self-applies in local/preview/tests).
- Wiring is **conditional**: `buildWatch` (in `src/index.ts`) only constructs the
  watch service when the `DB` D1 **and** `DRIVE_WEBHOOK_TOKEN` **and**
  `DRIVE_WATCH_CALLBACK_URL` are bound; otherwise the watch routes return `500`
  (`DRIVE_WATCH_UNCONFIGURED`) and the rest of the surface is unaffected.

## Layout

- `src/app.ts` — Hono routes, authn (trusted header) + authz middleware. Deps injected.
- `src/service.ts` — orchestration: cache + soft-rate + Google + event/audit.
- `src/google/{client,token,mapper}.ts` — Google Drive v3 / Sheets v4 adapter,
  OAuth refresh-token provider, pure mappers (kind / embed URL / error table §6).
- `src/watch/{service,repo}.ts` — Drive-watch orchestration + `drive_watch_channels`
  D1 registry (thin `D1Database` wrapper; token never persisted).
- `migrations/drive/0001_init.sql` (+ `index.ts`) — watch-registry DDL / self-apply.
- `src/{cache,ratelimit,events,env,permissions,types}.ts` — supporting modules.
- `src/index.ts` — Worker entry wiring real bindings (`buildWatch` gates Drive-watch).

## Deploy readiness / deferrals

- **Real wiring, not stubbed.** The composition root (`src/index.ts`) wires real
  deps — real Google Drive/Sheets client, real OAuth refresh-token provider, real
  KV cache + soft rate-limiter, real file-meta + audit queue publishers, and the
  real identity `/authz/check` checker. The injectable `fetch`/deps seams in the
  `google/*` and `events` modules exist only so unit tests avoid the network.
- **Not yet deployed — apply-time provisioning only.** What is outstanding is not
  code: replace the `REPLACE_AT_APPLY` KV namespace id and `DB` D1 `database_id` in
  `wrangler.toml`, set the `DRIVE_WATCH_CALLBACK_URL` var to the real webhook-ingest
  ingress, and set the `GOOGLE_OAUTH_*` + `DRIVE_WEBHOOK_TOKEN[_NEXT]` secrets.
- Google credentials use an injectable `fetch` in tests; the refresh_token lives
  only in Workers Secrets in production (never in repo/KV/logs).
- **Drive-watch is implemented** (channel-token issuance + `channels.stop` +
  `drive_watch_channels` registry). Only the `wh-google-drive` *consumer* (processing
  the notifications) stays contract-only in v1.

## Known contract discrepancies (documented, not resolved here)

The **frozen `@dub/*` packages are treated as the shared contract** and are used
as-is (never edited by this unit):

1. `@dub/types` `drive` namespace ships a *thinner* `DriveFile` /
   `CreateFileRequest` / `GetEmbedResponse` / `GetSheetValuesResponse` than the
   P0a design's richer types (only partially ported at P0b). This unit honors the
   frozen shapes for the public API and adds non-colliding local types in
   `src/types.ts` (`MoveFileRequest`, `WriteSheetValuesRequest`,
   `QuotaStatusResponse`, `DriveFileKind`, …). Promoting the richer drive types is
   a follow-up `@dub/types` contract change (design §2-2 note).
2. `drive:read` / `drive:write` are **not yet** in the frozen `PERMISSION_CATALOG`
   closed union (design §8-1#2). They live as string constants in
   `src/permissions.ts` and are cast at the identity `/authz/check` wire boundary.
   When the catalog adds the two keys, callers switch to `identity.PermissionKey`
   with zero behavioural change.
3. `@dub/db`'s `NAMESPACES` registry has no `drive` entry (Drive metadata belongs to
   the `file_meta` namespace, not this unit). Rather than edit the frozen shared
   registry, the watch registry uses a **self-contained** thin `D1Database` wrapper
   (`src/watch/repo.ts`) instead of the namespace-scoped `createDbClient`, and a
   self-contained migration (`migrations/drive/index.ts`) instead of a `@dub/db`
   `Migration` (whose `namespace` is a closed union). Promoting `drive` into the
   registry is a follow-up shared-package change if boundary-lint coverage is wanted.

## Test

```
pnpm --filter @dub/drive-proxy test   # 97 unit tests, all green
```

Covers the P0a §7 acceptance basis: list→get→embed across kinds, create (blank +
template) with envelope + audit, sheets read/update/append, the §6 Google-error
conversion table, cache/rate semantics, token refresh, and authn/authz — plus
Drive-watch: `files.watch`/`channels.stop` wire shape + error mapping, watch
create/stop orchestration (token issuance, token-never-leaked, rate budget,
idempotent stop), the `drive_watch_channels` D1 repo SQL/bind/mapping, and the
internal-only watch routes.
