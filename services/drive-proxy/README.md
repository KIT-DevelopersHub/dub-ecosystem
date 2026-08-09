# drive-proxy (unit #11)

The single window onto Google Drive/Docs/Sheets/Forms for the DevHub (Dub)
ecosystem. A thin adapter over the Google APIs plus one-place management of the
Google token, rate limit and response cache. It owns **no D1** (Drive holds file
bodies; `file-meta-service` owns the metadata source of truth) — only KV and
Workers Secrets.

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

## Events (§4)

- Publishes `drive.file.created|moved|trashed` (canonical `DubEventEnvelope`) →
  `file-meta` via queue binding `EVT_FILE_META`. Payloads are the frozen minimal
  `{ driveFileId }` shape.
- Every write op also emits `publishAudit()` (`drive.file.create|move|trash`,
  `drive.sheet.write`) → `AUDIT_QUEUE`. audit-log does **not** subscribe to domain
  events. The retired `drive.sheet.written` domain event is intentionally not
  published (sheet writes are audit-only).
- `wh-google-drive` consumer is reserved (contract only; P1 Drive-watch).

## Layout

- `src/app.ts` — Hono routes, authn (trusted header) + authz middleware. Deps injected.
- `src/service.ts` — orchestration: cache + soft-rate + Google + event/audit.
- `src/google/{client,token,mapper}.ts` — Google Drive v3 / Sheets v4 adapter,
  OAuth refresh-token provider, pure mappers (kind / embed URL / error table §6).
- `src/{cache,ratelimit,events,env,permissions,types}.ts` — supporting modules.
- `src/index.ts` — Worker entry wiring real bindings.

## P0 scope / deferrals

- Not deployed in P0 (mock/stub wave). Real Google 结线 waits on the integration
  wave; `wrangler.toml` is a scaffold with placeholder KV id.
- Google credentials are STUBbed via injectable fetch in tests; the refresh_token
  lives only in Workers Secrets in production (never in repo/KV/logs).

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

## Test

```
pnpm --filter @dub/drive-proxy test   # 71 unit tests, all green
```

Covers the P0a §7 acceptance basis: list→get→embed across kinds, create (blank +
template) with envelope + audit, sheets read/update/append, the §6 Google-error
conversion table, cache/rate semantics, token refresh, and authn/authz.
