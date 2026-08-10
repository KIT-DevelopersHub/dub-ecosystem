# Dub API Contract — @dub/drive-proxy

Status: Component contract (v1). drive-proxy is the **sole gateway to Google Drive v3 and
Sheets v4** for the whole ecosystem. It is a thin read/write adapter over the Google APIs
plus one-place management of the Google OAuth token (KV), a KV response cache, and a KV
soft rate-limiter. It **owns no D1** — Drive holds file bodies; `file-meta-service` owns the
metadata source of truth. Every write publishes the frozen minimal `drive.file.*` fan-out to
`file-meta` and an audit record; sheet writes are **audit-only**.

Read [`../_conventions.md`](../_conventions.md) first (envelope, headers, codes, pagination)
and [`../auth.md`](../auth.md) (session + permission model). This doc only adds what is
drive-proxy–specific.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Frozen wire entity / request / response types | `packages/types/src/drive.ts` (`drive` namespace) |
| Service-local complement types | `services/drive-proxy/src/types.ts` |
| HTTP routing + authn/authz wiring | `services/drive-proxy/src/app.ts` |
| Orchestration (cache + soft-rate + Google + events) | `services/drive-proxy/src/service.ts` |
| Google adapter, kind/embed URL, error table | `services/drive-proxy/src/google/{client,mapper,token}.ts` |
| Permission keys (string constants, §6) | `services/drive-proxy/src/permissions.ts` |
| Fan-out + audit publishing | `services/drive-proxy/src/events.ts` |
| Gateway route entry | `services/api-gateway/src/routes.ts` (`{ segment: "drive", binding: "SVC_DRIVE_PROXY" }`) |

If code and this doc disagree, the code wins and this doc must be corrected.

---

## 1. Surface & boundaries

drive-proxy is an **internal** Worker. Browsers reach it **only through `api-gateway`** under
the `/api/v1` prefix; the gateway authenticates the session, mints the trusted
`x-dub-user-id`, and strips **only** `API_PREFIX` before proxying. The `drive` gateway segment
targets this Worker's `SVC_DRIVE_PROXY` binding:

| Gateway segment | External prefix | Service-local path |
|---|---|---|
| `drive` | `/api/v1/drive…` | `/drive…` |

Native apps reach the same data through `mo3-mobile-bff` (`/m/v1`), which fans out to this
service; the entity shapes below are identical on that path. Other backend services call the
service-local `/drive…` paths directly over their `SVC_DRIVE_PROXY` service binding.

All paths below are written at the **external** (gateway) prefix. Every endpoint except the
internal quota probe requires an authenticated session; an absent `x-dub-user-id` at the
service yields `401 UNAUTHENTICATED` (`errors.unauthenticated`, checked before authz).

**Content type** is `application/json` for every request and response body here — drive-proxy
brokers **metadata and cell values only**, never file bytes (no upload/download; embed/preview
is delivered as a URL for the client to open, §3.3).

**Caching & freshness (client-visible behaviour).** Reads (`GET /drive/files`,
`/drive/files/:id`, `/drive/files/:id/embed`, `/drive/sheets/:id/values`) may be served from a
short-TTL KV response cache, so a read can lag a just-committed external Drive edit by up to the
cache TTL. Every write op in this service purges the affected file/list/sheet cache keys before
returning, so read-after-own-write **through this service** is consistent. Cache hits never
consume the soft rate budget (§7).

---

## 2. Entities

### 2.1 `DriveFile` (`drive.DriveFile`) — frozen shape

The single file projection returned by every file endpoint. It is deliberately **thin** —
the Google resource is projected down to four fields (`services/drive-proxy/src/google/mapper.ts`
`toDriveFile`); richer Drive metadata is intentionally not on the wire in v1.

```json
{
  "id": "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456",
  "name": "Hokuriku IT Conference — Budget",
  "mimeType": "application/vnd.google-apps.spreadsheet",
  "modifiedAt": "2026-08-10T05:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`drive.DriveFileId`) | **Raw Google Drive file id** — *not* a Dub prefix-ULID and *not* a `file-meta` `FileId`. Opaque; treat as a bare Google id. |
| `name` | string | File / folder name. |
| `mimeType` | string | Google MIME (`application/vnd.google-apps.*`, `application/pdf`, `image/*`, …). Drives the coarse `kind` and the embed URL. |
| `modifiedAt` | ISODateTime | Drive `modifiedTime`; falls back to the epoch (`1970-01-01T00:00:00Z`) if Drive omits it. |

> **Id note.** Both the raw Drive id and the `file-meta` ULID exist in the ecosystem; they are
> different strings. drive-proxy speaks **only** raw Drive ids on the wire (path params and
> `DriveFile.id`). Mapping a Drive id to a `file-meta` `FileId` is `file-meta`'s job, driven by
> the `drive.file.*` events this service emits (§8).

### 2.2 Coarse kind (internal projection)

`mimeType` is mapped to a coarse `DriveFileKind`
(`doc | sheet | slide | form | folder | pdf | image | other`) to derive embed URLs and validate
the `kind` list filter. The kind is **not** a field on `DriveFile`; it only surfaces indirectly
through the `?kind=` filter (§3.1) and the embed URL (§3.3).

---

## 3. Endpoints

### 3.1 `GET /api/v1/drive/files` — list a folder

Permission: `drive:read`. Cursor-paginated (`drive.ListFilesResponse = Paginated<DriveFile>`).

Query params:

| Param | Type | Required | Notes |
|---|---|---|---|
| `folderId` | string (raw Drive id) | **yes** | The parent folder to list. **Missing/blank ⇒ `400 VALIDATION_FAILED`** (`{ field: "folderId", reason: "required" }`). There is no unscoped "list everything". |
| `cursor` | string (opaque) | no | Echo a prior `nextCursor`. Opaque Drive `pageToken`; never construct it. |
| `limit` | integer | no | Default 50, **max 100** (Drive API constraint — *not* the conventions' 200). Out of `1..100` ⇒ `400 VALIDATION_FAILED` (`{ field: "limit", reason: "out_of_range", message: "1..100" }`). |
| `kind` | `DriveFileKind` | no | Server-side type filter (`doc \| sheet \| slide \| form \| folder \| pdf \| image \| other`). Unknown value ⇒ `400 VALIDATION_FAILED` (`{ field: "kind", reason: "invalid" }`). |
| `q` | string | no | Extra Drive query fragment (name/full-text), ANDed with the folder + kind constraints. |

> **Query-param name (documented deviation).** The frozen `drive.ListFilesQuery` type names the
> parent `parentId`, but the **live wire query param is `folderId`** (`src/app.ts` /
> `src/service.ts`). Clients send `folderId`. Reconciling the frozen type to `folderId` is a
> pending additive `@dub/types` correction (service README, discrepancy #1).

Response `200` (`Paginated<DriveFile>`):

```json
{
  "items": [
    { "id": "1AbC…", "name": "Budget", "mimeType": "application/vnd.google-apps.spreadsheet", "modifiedAt": "2026-08-10T05:00:00Z" },
    { "id": "1XyZ…", "name": "Assets", "mimeType": "application/vnd.google-apps.folder", "modifiedAt": "2026-08-09T11:20:00Z" }
  ],
  "nextCursor": "eyJwYWdlIjoyfQ"
}
```

`nextCursor === null` ⇒ last page.

### 3.2 `GET /api/v1/drive/files/:id` — get one file's metadata

Permission: `drive:read`. `:id` is the raw Drive id. Response `200`: a bare `DriveFile` (§2.1).
Unknown / inaccessible id ⇒ `404 NOT_FOUND` (Google 404 mapped, §6).

### 3.3 `GET /api/v1/drive/files/:id/embed` — kind-specific preview URL

Permission: `drive:read`. Resolves the file's kind and returns the preview/embed URL the client
should open in an iframe or new tab. Response `200` (`drive.GetEmbedResponse`):

```json
{ "embedUrl": "https://docs.google.com/spreadsheets/d/1AbC…/preview" }
```

URL family by kind: Docs `/document/d/:id/preview`, Sheets `/spreadsheets/d/:id/preview`,
Slides `/presentation/d/:id/embed`, Forms `/forms/d/:id/viewform?embedded=true`, everything
else (`pdf`/`image`/`other`) `https://drive.google.com/file/d/:id/preview`.

**Folders are not embeddable** ⇒ `400 VALIDATION_FAILED`
(`{ field: "fileId", reason: "not_embeddable", message: "folders cannot be embedded" }`).

### 3.4 `POST /api/v1/drive/files` — create (blank or from template)

Permission: `drive:write`. Two modes on one route, chosen by whether `templateFileId` is present.

Request (service-local, superset of frozen `drive.CreateFileRequest`):

```json
{
  "name": "2026 Sponsor Deck",
  "mimeType": "application/vnd.google-apps.presentation",
  "parentId": "1XyZ…",
  "templateFileId": "1Tmpl…"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **yes** | Non-empty. Missing ⇒ `400 VALIDATION_FAILED` (`{ field: "name", reason: "required" }`). |
| `mimeType` | string | **yes** | Missing ⇒ `400 VALIDATION_FAILED` (`{ field: "mimeType", reason: "required" }`). On a template copy the copy inherits the source type; `mimeType` is still required for request validation. |
| `parentId` | string (raw Drive id) | no | Destination folder. Omitted ⇒ created in the service account's default location. Purges the parent's list cache. |
| `templateFileId` | string (raw Drive id) | no | If present, **copy** that file (`files.copy`) instead of creating blank (`files.create`). Additive over the frozen `CreateFileRequest`. |

Response `201` — the created file **wrapped in an object** (see §5): `{ "file": DriveFile }`.

```json
{ "file": { "id": "1New…", "name": "2026 Sponsor Deck", "mimeType": "application/vnd.google-apps.presentation", "modifiedAt": "2026-08-10T06:00:00Z" } }
```

Emits `drive.file.created` → `file-meta` and audit `drive.file.create` (§8).

### 3.5 `POST /api/v1/drive/files/:id/move` — re-parent

Permission: `drive:write`. Moves the file from its current parent(s) to a new one.

Request (`MoveFileRequest`): `{ "newParentId": "1Dest…" }`

- `newParentId` (required, raw Drive id). Missing ⇒ `400 VALIDATION_FAILED`
  (`{ field: "newParentId", reason: "required" }`).
- A **trashed** source file ⇒ `404 NOT_FOUND` (you cannot move a trashed file).

Response `200`: `{ "file": DriveFile }` (the moved file). Purges the file cache and both the old
and new parents' list caches. Emits `drive.file.moved` → `file-meta` and audit `drive.file.move`.

### 3.6 `POST /api/v1/drive/files/:id/trash` — trash (soft)

Permission: `drive:write`. Sets Drive `trashed = true` (soft delete; recoverable from Drive
Trash). **Not** a hard delete.

Request: no body.

Response `200`: `{ "file": DriveFile, "trashed": true }` (`TrashFileResponse`).

**Idempotent:** trashing an already-trashed file still returns `200` with the same shape, but
**does not re-emit** the event or audit record (it is a no-op re-trash). A first-time trash emits
`drive.file.trashed` → `file-meta` and audit `drive.file.trash`.

### 3.7 `GET /api/v1/drive/sheets/:id/values` — read a range

Permission: `drive:read`. `:id` is the spreadsheet's raw Drive id. Reads an A1 range via
Sheets v4 (`FORMATTED_VALUE`).

Query param:

| Param | Type | Required | Notes |
|---|---|---|---|
| `range` | string (A1 notation) | **yes** | e.g. `Sheet1!A1:D20`, `A1:B`, `'Q3 Budget'!A1`. Empty or non-A1 ⇒ `400 VALIDATION_FAILED` (`{ field: "range", reason: "invalid_a1_notation" }`). |

Response `200` (`drive.GetSheetValuesResponse`) — a rectangular grid of **strings** (cells
coerced to string; empty cells `""`):

```json
{ "values": [ ["Item", "Cost"], ["Venue", "120000"], ["Catering", "80000"] ] }
```

### 3.8 `POST /api/v1/drive/sheets/:id/values` — update or append

Permission: `drive:write`. One route, two modes via `mode`.

Request (`WriteSheetValuesRequest`):

```json
{
  "mode": "update",
  "range": "Sheet1!A2:B2",
  "values": [ ["Venue", 120000] ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `mode` | `"update" \| "append"` | **yes** | `update` overwrites the range (`values.update`); `append` adds rows after the table (`values.append`). Other value ⇒ `400 VALIDATION_FAILED` (`{ field: "mode", reason: "invalid" }`). |
| `range` | string (A1) | **yes** | Same A1 validation as §3.7 (`{ field: "range", reason: "invalid_a1_notation" }`). |
| `values` | `(string \| number \| boolean \| null)[][]` | **yes** | Row-major grid. Non-array ⇒ `400 VALIDATION_FAILED` (`{ field: "values", reason: "required" }`). |

A **trashed** spreadsheet ⇒ `404 NOT_FOUND` (§6). Purges the sheet + file caches.

Response `200` (`WriteSheetValuesResponse`):

```json
{ "spreadsheetId": "1AbC…", "updatedRange": "Sheet1!A2:B2", "updatedRows": 1 }
```

**Audit-only:** a sheet write records audit `drive.sheet.write` but emits **no** domain event —
the retired `drive.sheet.written` domain event is intentionally not published (§8).

### 3.9 `GET /api/v1/drive/health/quota` — soft-rate self-report (internal-only)

**Internal-only.** Requires the `x-dub-internal: 1` marker; without it ⇒ `403 FORBIDDEN`
(`errors.forbidden("internal-only endpoint")`). Because the gateway strips only `API_PREFIX` and
never adds `x-dub-internal`, an external caller hitting `/api/v1/drive/health/quota` reaches the
service and is rejected `403` — it is not publicly usable. Meant for peer services / monitoring
over the service binding.

Response `200` (`QuotaStatusResponse`):

```json
{ "windowSeconds": 100, "usedRequests": 42, "softLimit": 500, "throttling": false }
```

| Field | Type | Meaning |
|---|---|---|
| `windowSeconds` | number | Length of the current soft-rate window. |
| `usedRequests` | number | Google-bound requests counted in the current window (cache hits excluded). |
| `softLimit` | number | Requests permitted per window before throttling. |
| `throttling` | boolean | `true` once `usedRequests ≥ softLimit` (further Google calls fail `429`, §6/§7). |

---

## 4. Endpoint & permission summary

All paths at the external (`/api/v1`) prefix. Permissions are the frozen catalog's `drive`
domain (`auth.md` §9.2): `drive:read`, `drive:write` (both org-scoped; no resource-scoped
Drive checks in v1).

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /api/v1/drive/files` | `drive:read` | List a folder (cursor paging, `folderId` required) |
| `GET /api/v1/drive/files/:id` | `drive:read` | One file's metadata |
| `GET /api/v1/drive/files/:id/embed` | `drive:read` | Kind-specific preview URL (folders ⇒ 400) |
| `POST /api/v1/drive/files` | `drive:write` | Create blank, or copy `templateFileId` |
| `POST /api/v1/drive/files/:id/move` | `drive:write` | Re-parent |
| `POST /api/v1/drive/files/:id/trash` | `drive:write` | Soft-trash (idempotent) |
| `GET /api/v1/drive/sheets/:id/values` | `drive:read` | Read an A1 range |
| `POST /api/v1/drive/sheets/:id/values` | `drive:write` | Update / append cells |
| `GET /api/v1/drive/health/quota` | internal-only (`x-dub-internal`) | Soft-rate self-report |

A missing permission ⇒ `403 FORBIDDEN`. Authz is resolved via identity `/authz/check`
(`auth.md` §10); reads and writes each check exactly one org-scoped key before running.

> **Permission-catalog note (documented deviation).** `drive:read` / `drive:write` are present in
> the **catalog doc** (`auth.md` §9.2) but are **not yet** in the frozen `PERMISSION_CATALOG`
> closed TypeScript union. drive-proxy holds them as string constants
> (`src/permissions.ts`) and casts at the `/authz/check` wire boundary; the wire string is
> identical, so when the union adds the two keys callers switch to `identity.PermissionKey` with
> zero behavioural change (service README, discrepancy #2).

---

## 5. Response-shape note — write ops wrap the file

Per `_conventions.md` §2.1 a success body is normally the payload itself. drive-proxy's **write**
endpoints deviate deliberately: they wrap the resource in a small object so the response can carry
an operation flag without changing the entity shape.

| Endpoint | Body shape |
|---|---|
| `GET /drive/files/:id` (read) | bare `DriveFile` |
| list / read-sheet | bare `Paginated<DriveFile>` / `{ values }` |
| `POST /drive/files` (create) | `{ "file": DriveFile }` (201) |
| `POST /drive/files/:id/move` | `{ "file": DriveFile }` |
| `POST /drive/files/:id/trash` | `{ "file": DriveFile, "trashed": true }` |
| `POST /drive/sheets/:id/values` | `{ spreadsheetId, updatedRange, updatedRows }` |

Clients read `body.file` (not `body`) on create/move/trash. This is frozen for v1.

---

## 6. Errors — Google-error conversion table

drive-proxy defines **no** `DRIVE_*` service-specific codes. Instead every non-2xx from Google is
converted to a **common** code from `_conventions.md` §3.1, and its own input validation uses
`VALIDATION_FAILED`. All responses use the standard error envelope (`_conventions.md` §2.2); the
raw Google error body is **never** leaked (5xx / credential messages are kept generic).
Conversion (`src/google/mapper.ts` `mapGoogleError`):

| Google status | Dub code | HTTP | `retryable` | Notes |
|---|---|---|---|---|
| 400 | `VALIDATION_FAILED` | 400 | false | `details: [{ field: "request", reason: "google_bad_request" }]`. |
| 401 | `UPSTREAM_UNAVAILABLE` | 502 | true | Credential/token fault **after** refresh+retry. Surfaced as an upstream fault (`google:auth`) — the token secret never leaks; no `401` is reflected to the client. |
| 403 | `FORBIDDEN` | 403 | false | Google denied access to the resource (distinct from Dub authz `403`). |
| 404 | `NOT_FOUND` | 404 | false | File/spreadsheet absent or not visible to the service account. |
| 409 | `CONFLICT` | 409 | false | Google reported a state conflict. |
| 429 | `RATE_LIMITED` | 429 | true | Carries `Retry-After` + `details.retryAfterSec` (§7). Google's own quota **or** this service's soft limit both surface here. |
| 500 / 502 / 503 | `UPSTREAM_UNAVAILABLE` | 502 | true | Generic Google outage (`google`). |
| 504 | `UPSTREAM_TIMEOUT` | 504 | true | Google timed out. |
| other ≥ 500 | `UPSTREAM_UNAVAILABLE` | 502 | true | Fallback. |

drive-proxy's **own** validation codes (before any Google call): `VALIDATION_FAILED` (400) for
the field errors listed per-endpoint in §3, `UNAUTHENTICATED` (401, no `x-dub-user-id`),
`FORBIDDEN` (403, missing `drive:*` permission **or** the internal-only quota route without
`x-dub-internal`).

Client guidance: branch on `code` + HTTP status, never on `message` (5xx is redacted). Retryable
codes (`429/502/504`) follow the standard retry/backoff and `Retry-After` rules in
`_conventions.md` §7 — honour `retryAfterSec` before retrying a `429`.

---

## 7. Rate-limiting, caching, idempotency

- **Soft rate-limiter (KV).** Google-bound requests are counted per fixed window
  (`windowSeconds`); at `softLimit` the next Google call fails `429 RATE_LIMITED` with
  `details.retryAfterSec` and a `Retry-After` header. Observable via `GET /drive/health/quota`
  (§3.9). **Cache hits do not consume the budget.**
- **Response cache (KV).** `GET` reads are cached with short per-kind TTLs (file / list / sheet).
  Writes purge the affected keys before returning (read-after-own-write is consistent through this
  service; see §1).
- **Token cache (KV).** The Google OAuth access token is refreshed from a refresh-token held only
  in Workers Secrets and cached in KV — never in the repo, response bodies, or logs.
- **Idempotency / retries** follow `_conventions.md` §7. `GET` is retried by default. The writes
  here (`POST …/files`, `…/move`, `…/trash`, `…/values`) are retried by the shared client **only**
  with an `x-dub-idempotency-key`. Note their natural semantics: **`trash` is naturally
  idempotent** (re-trash ⇒ `200`, no re-emit, §3.6); **`create` is not** (a retry without an
  idempotency key can create a second file) — callers that need exactly-once create should send
  an idempotency key.

---

## 8. Fan-out events & audit

Every successful **file** write publishes one canonical `DubEventEnvelope` to `file-meta` via the
`EVT_FILE_META` queue binding (`packages/events` routing `drive.file.* → "file-meta"`). Payloads
are the **frozen minimal `{ driveFileId }`** shape — `file-meta` owns enrichment.

| Event | Emitted by | Payload | Subscriber |
|---|---|---|---|
| `drive.file.created` | `POST /drive/files` (create or copy) | `{ driveFileId }` | file-meta |
| `drive.file.moved` | `POST /drive/files/:id/move` | `{ driveFileId }` | file-meta |
| `drive.file.trashed` | `POST /drive/files/:id/trash` (first-time only) | `{ driveFileId }` | file-meta |

Publish is a best-effort side effect after the Google call succeeds; consumers dedupe on the
envelope `id`. A no-op re-trash (§3.6) emits nothing.

Every write also records an audit entry to `AUDIT_QUEUE` (`auditLog.AuditRecordInput`,
`resourceType: "drive_file"`, `actorId` = caller's `x-dub-user-id`, `requestId` propagated,
`occurredAt` = server ISO time). audit-log does **not** subscribe to domain events — audit is a
separate emission.

| Endpoint | Audit `action` | `details` |
|---|---|---|
| create | `drive.file.create` | `{ name, kind }` |
| move | `drive.file.move` | `{ newParentId }` |
| trash (first-time) | `drive.file.trash` | — |
| sheet write | `drive.sheet.write` | `{ mode, range }` |

**Sheet writes are audit-only** — no `drive.file.*` (they don't create/move/trash a file) and no
`drive.sheet.written` domain event (that event is retired). The `wh-google-drive` webhook consumer
is reserved for P1 (Drive-watch) and is contract-only in v1.

---

## 9. Contract-change discipline

Additive-safe within `v1`: a new optional list filter, a new `DriveFileKind`, a new subscriber
for an existing `drive.file.*` event, promoting the frozen `drive` types to their richer form
**as long as the wire stays identical** (e.g. renaming the list param's *type* field to `folderId`
to match the wire). **Breaking** (needs a version bump or frozen-decision review): changing the
write-op wrapper shapes (§5), changing the Google-error → Dub-code mapping (§6), changing a
`drive.file.*` payload, adding a resource-scope requirement to the `drive:*` checks, or changing
the `limit` cap. Adding `drive:read`/`drive:write` to the frozen `PERMISSION_CATALOG` union is the
one expected catalog change (theme2) — a pure tightening of §4's documented deviation. See
[`../_conventions.md`](../_conventions.md) §9.
