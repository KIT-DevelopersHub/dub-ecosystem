# Dub File-Meta Service API Contract

Status: Component contract (v1). Read [`_conventions.md`](../_conventions.md) first for the
shared envelope, headers, error codes, pagination, IDs, and versioning; and
[`auth.md`](../auth.md) for authn/authz. This doc only adds what is **file-meta-specific**:
the `FileMeta` resource shape, the ten HTTP endpoints, the `org`/`private` visibility read
rule, the drive-vs-R2 body-source split, the entity link registry, the events it emits, and
the `drive.file.*` / `*.archived` queue it consumes.

`@dub/svc-file-meta` is the **file metadata store**: a metadata + entity-link registry (the
source of truth for "which file is attached to which task/event/action/message"), a search
surface over that metadata, an R2 blob store for uploaded attachments, and a queue consumer
that ingests `drive.file.*` events from drive-proxy to keep Drive files reflected in the
registry.

**Source of truth (code):**

| Concern | Code |
|---|---|
| `FileMeta` / request / response types, visibility & link-target enums | `packages/types/src/file-meta.ts` |
| HTTP routes + guards | `services/file-meta/src/app.ts` |
| Input validation | `services/file-meta/src/validate.ts` |
| Injected ports (repo / blobs / authz / drive / emit / audit) | `services/file-meta/src/deps.ts` |
| Worker entry, bindings, real deps | `services/file-meta/src/index.ts` |
| Queue consumer (`drive.file.*`, `*.archived`) | `services/file-meta/src/consumer.ts` |
| Emitted / consumed event payloads | `packages/events/src/payloads.ts`, `packages/events/src/catalog.ts` |
| Gateway mount + body cap | `services/api-gateway/src/routes.ts`, `services/api-gateway/src/gateway-route.ts` |

If code and this doc disagree, the code wins and this doc must be corrected.

---

## 1. Topology

file-meta is an **internal** service (no public hostname). It is mounted by `api-gateway`
under the `files` segment (`SVC_FILE_META`, auth `required`), with only the API prefix
stripped — so the gateway's `/api/v1/files/*` maps 1:1 to the service's internal `/files/*`.

| Caller | External path | Internal path | Auth carried in |
|---|---|---|---|
| `api-gateway` (web, file surfaces) | `/api/v1/files…` | `/files…` (prefix stripped) | `x-dub-user-id` (trusted; gateway verified the session) |
| `drive-proxy` (service, via queue) | — | queue `EVT_FILE_META` | event envelope (no user; system actor) |

The service **trusts** `x-dub-user-id` and does not re-verify tokens (`trustedHeader` mode
via `@dub/auth-client`). Every `/files/*` route runs `requireAuth()`; a request with no
trusted user context is rejected `401 AUTH_INVALID_TOKEN` before any handler runs. All paths
below are written in their **external** `/api/v1` form; drop the prefix for the internal
service-binding form.

`GET /internal/health` is **binding-direct only** — the gateway does not expose `/internal/*`,
so it is not reachable from the web. It returns `{ status, service, contractVersion }` plus an
`x-dub-contract-version` header and is out of scope for web/mobile clients.

**Body cap:** uploads are capped at **25 MiB** (`26214400` bytes) both at the service
(`maxUploadBytes`) and at the gateway (`FILES_MAX_BODY_BYTES`, default `26214400`).

---

## 2. Resource shape

`fileMeta.FileMeta` — the exact `200`/`201` read body for every single-file endpoint. The
service keeps two extra columns (`createdBy`, `archivedAt`) that never cross the wire;
`toPublic()` strips them.

```json
{
  "id": "file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "name": "landing-hero.png",
  "mimeType": "image/png",
  "sizeBytes": 184320,
  "ownerId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YB",
  "visibility": "org",
  "driveFileId": null,
  "r2Key": "org_devhub/file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "createdAt": "2026-08-10T05:00:00Z",
  "updatedAt": "2026-08-10T05:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`file_` ULID) | Opaque. |
| `name` | string | Display filename. Non-empty. |
| `mimeType` | string | MIME type. Non-empty. |
| `sizeBytes` | number | Byte size; `>= 0`. `0` for a Drive-reflected file whose bytes live in Drive. |
| `ownerId` | string (`user_` ULID) | Owner. Queue-ingested Drive files carry the literal `"system"` owner. |
| `visibility` | `FileVisibility` | `org` \| `private` (closed set). See §4. |
| `driveFileId` | string \| null | Drive file id when the body lives in Google Drive; else null. |
| `r2Key` | string \| null | R2 object key when the body is an uploaded attachment; else null. `driveFileId` and `r2Key` are **mutually exclusive** — at most one is non-null. |
| `createdAt` / `updatedAt` | ISODateTime | Server-set ISO-8601 UTC. |

`fileMeta.FileMetaLink` — an entity link (the wire shape returned by the link endpoints and
`?include=links`):

```json
{
  "fileId": "file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "targetType": "task",
  "targetId": "task_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "linkedAt": "2026-08-10T05:00:00Z"
}
```

`targetType` is the closed set `task | event | action | message`; `targetId` is the opaque
id of that entity.

---

## 3. Endpoint map

| Method & path (external) | Permission | Success | Purpose |
|---|---|---|---|
| `POST /api/v1/files/meta` | `file:write` | `201` `FileMeta` | Register metadata for a Drive file or a pre-uploaded R2 key. |
| `GET /api/v1/files/search` | `file:read` | `200` `FileSearchResponse` | Search file metadata (paginated). |
| `GET /api/v1/files/meta/{id}` | `file:read` | `200` `{ file }` (+`links`) | Read one file's metadata, optionally with its links. |
| `PATCH /api/v1/files/meta/{id}` | `file:write` | `200` `FileMeta` | Update `name` / `visibility` / `ownerId`. |
| `DELETE /api/v1/files/meta/{id}` | `file:write` | `204` | Soft-delete (archive) the file. |
| `POST /api/v1/files/meta/{id}/links` | `file:write` | `201` `FileMetaLink` | Attach the file to an entity. |
| `DELETE /api/v1/files/meta/{id}/links` | `file:write` | `204` | Detach the file from an entity. |
| `POST /api/v1/files` | `file:write` | `201` `FileMeta` | Upload an R2 attachment (auto-registers metadata). |
| `GET /api/v1/files/{id}/download` | `file:read` | `200` (binary) | Download an R2 attachment body. |
| `GET /internal/health` | — (binding-direct) | `200` `{ status, service, contractVersion }` | Liveness; not gateway-exposed. |

Permission is resolved via identity-roster `/authz/check` (see [`auth.md`](../auth.md) §10);
a denied key surfaces as `403 FORBIDDEN`. This service has **no optimistic-lock version** —
`FileMeta` is not `Versioned`; updates are last-write-wins and carry no `version`.

There is **no hard-delete endpoint**: delete is always a soft archive (§4.4). Emitted
`file.*` events currently have **no subscribers** (contract-only in P0; see §7).

---

## 4. Endpoints in detail

### 4.1 `POST /api/v1/files/meta` — register metadata

Registers a file whose body already exists elsewhere: a Google **Drive** file (`driveFileId`)
or a **pre-uploaded R2** object (`r2Key`). The two body sources are mutually exclusive.

Request (`fileMeta.RegisterMetaRequest`):

```json
{
  "name": "Q3 roadmap.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 220160,
  "visibility": "org",
  "driveFileId": "1AbCdEf_gHiJkLmNoPqRsTuVwXyZ"
}
```

| Field | Required | Rule |
|---|---|---|
| `name` | yes | Non-empty string. Empty/whitespace → `VALIDATION_FAILED` (`{ field: "name", reason: "required" }`). |
| `mimeType` | yes | Non-empty string. Empty → `{ field: "mimeType", reason: "required" }`. |
| `sizeBytes` | yes | Finite number `>= 0`. Otherwise `{ field: "sizeBytes", reason: "invalid" }`. |
| `visibility` | no | `org` (default) or `private`. Other → `{ field: "visibility", reason: "invalid" }`. |
| `driveFileId` | no | Drive file id. |
| `r2Key` | no | R2 object key. |

Providing **both** `driveFileId` and `r2Key` → `400 VALIDATION_FAILED`
(`{ field: "driveFileId", reason: "mutually_exclusive" }`).

When `source=drive` and drive-proxy is reachable, the service completes missing `name` /
`mimeType` from Drive (best-effort; a drive-proxy failure silently falls back to the caller's
values). Registering a `driveFileId` already in the registry → `409 FILE_DUPLICATE_EXTERNAL`.

The caller becomes `ownerId` and `createdBy`. Response `201` is the full `FileMeta` (§2).
Emits `file.registered`; writes audit `file.meta.registered`.

### 4.2 `GET /api/v1/files/search` — search

Cursor-paged ([`_conventions.md`](../_conventions.md) §5). Query params (`fileMeta.FileSearchQuery`):

| Param | Type | Notes |
|---|---|---|
| `q` | string | Free-text match over file name (implementation-defined). |
| `mimeType` | string | Exact MIME filter. |
| `ownerId` | string | Filter by owner user id. |
| `limit` | integer | Default 50, max 200. `>200` → `400 VALIDATION_FAILED` (`{ field: "limit", reason: "too_large" }`); `0`/negative/non-integer → `{ field: "limit", reason: "invalid" }`. |
| `cursor` | string (opaque) | Echo the previous `nextCursor`. |

**Visibility filtering:** `private` files the caller cannot read are dropped from results
**before** paging is returned — a caller sees a `private` file only if they are its owner or
hold `file:admin`. (Archived files are already excluded from search.)

Response `200` (`fileMeta.FileSearchResponse = Paginated<FileMeta>`):

```json
{
  "items": [
    {
      "id": "file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
      "name": "landing-hero.png",
      "mimeType": "image/png",
      "sizeBytes": 184320,
      "ownerId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YB",
      "visibility": "org",
      "driveFileId": null,
      "r2Key": "org_devhub/file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
      "createdAt": "2026-08-10T05:00:00Z",
      "updatedAt": "2026-08-10T05:00:00Z"
    }
  ],
  "nextCursor": "eyJvIjoyMH0"
}
```

`nextCursor === null` means the end of the result set.

### 4.3 `GET /api/v1/files/meta/{id}` — read one

Query `?include=links` (comma-separated include list) to embed the file's active links.
Response `200` without include:

```json
{
  "file": {
    "id": "file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "name": "landing-hero.png",
    "mimeType": "image/png",
    "sizeBytes": 184320,
    "ownerId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YB",
    "visibility": "org",
    "driveFileId": null,
    "r2Key": "org_devhub/file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "createdAt": "2026-08-10T05:00:00Z",
    "updatedAt": "2026-08-10T05:00:00Z"
  }
}
```

With `?include=links`, an additional `links` array of `FileMetaLink` (§2) is present:

```json
{
  "file": { "id": "file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "name": "landing-hero.png", "...": "..." },
  "links": [
    { "fileId": "file_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "targetType": "task", "targetId": "task_01J9Z...", "linkedAt": "2026-08-10T05:00:00Z" }
  ]
}
```

An unknown id, a malformed id (not `file_`-prefixed ULID), or an archived file →
`404 NOT_FOUND`. A `private` file the caller neither owns nor can `file:admin` →
`403 FORBIDDEN` (`file:read` alone is not enough for another user's private file).

### 4.4 `PATCH /api/v1/files/meta/{id}` — update

Partial update; only the keys you send are touched. All fields optional (`fileMeta`-level
`UpdateFilePatch`):

```json
{
  "name": "landing-hero-v2.png",
  "visibility": "private"
}
```

| Field | Rule |
|---|---|
| `name` | Non-empty string. Empty → `VALIDATION_FAILED` (`{ field: "name", reason: "invalid" }`). |
| `visibility` | `org` \| `private`. Other → `{ field: "visibility", reason: "invalid" }`. |
| `ownerId` | Reassign owner. Changing it to a different user requires `file:admin` (else `403 FORBIDDEN`). |

Content fields such as `mimeType`, `sizeBytes`, `driveFileId`, `r2Key` are **immutable** via
PATCH (not accepted). Response `200` is the updated `FileMeta`. Emits `file.updated`; writes
audit `file.meta.updated` with `details.changed` = the patched keys.

Errors, in check order:

| Situation | Code | HTTP |
|---|---|---|
| Malformed / unknown id | `NOT_FOUND` | 404 |
| File already soft-deleted | `FILE_DELETED_IMMUTABLE` | 409 |
| Bad field value | `VALIDATION_FAILED` | 400 |
| `ownerId` change without `file:admin` | `FORBIDDEN` | 403 |

### 4.5 `DELETE /api/v1/files/meta/{id}` — soft delete

Archives the file (`archivedAt` set); the row and its links are kept (audit value). The R2
body, if any, is **not** removed by this call. **Idempotent:** deleting an already-archived
file returns `204` with no event. A malformed / unknown id → `404 NOT_FOUND`. On the first
delete: response `204`, emits `file.deleted`, writes audit `file.meta.deleted`.

### 4.6 `POST /api/v1/files/meta/{id}/links` — attach

Adds one entity link. Request:

```json
{ "targetType": "task", "targetId": "task_01J9Z8Q0X7M3K2P5R8T1V4W6YA" }
```

| Field | Rule |
|---|---|
| `targetType` | One of `task` \| `event` \| `action` \| `message`. Other → `VALIDATION_FAILED` (`{ field: "targetType", reason: "invalid" }`). |
| `targetId` | Non-empty string. Empty → `{ field: "targetId", reason: "required" }`. |

The `targetId` is **not** cross-checked against the target service — the link registry records
the edge as given. A malformed / unknown file id → `404 NOT_FOUND`; an archived file →
`409 FILE_DELETED_IMMUTABLE`; a `(fileId, targetType, targetId)` that already exists →
`409 FILE_DUPLICATE_LINK`. Response `201` is the `FileMetaLink`. Emits `file.linked`; writes
audit `file.link.added`.

### 4.7 `DELETE /api/v1/files/meta/{id}/links` — detach

Removes an entity link. The `(targetType, targetId)` to remove is carried **in the request
body** (same shape as attach), not the query string:

```json
{ "targetType": "task", "targetId": "task_01J9Z8Q0X7M3K2P5R8T1V4W6YA" }
```

A malformed body → `400 VALIDATION_FAILED`; a link that does not exist → `404 NOT_FOUND`.
Response `204`. Emits `file.unlinked`; writes audit `file.link.removed`.

### 4.8 `POST /api/v1/files` — upload an R2 attachment

Uploads bytes into R2 and auto-registers the resulting metadata. Two body encodings:

- **`multipart/form-data`** with a `file` part — filename and content-type come from the part.
  A missing `file` part → `400 VALIDATION_FAILED` (`{ field: "file", reason: "required" }`).
- **raw body** — the whole request body is the bytes; `Content-Type` is the MIME type and the
  optional `x-dub-filename` header is the display name (default `upload.bin`, content-type
  default `application/octet-stream`).

A body larger than **25 MiB** → `413 PAYLOAD_TOO_LARGE`. On success the object is stored at
R2 key `org_devhub/<fileId>`, `visibility` is `org`, `driveFileId` is null. Response `201`
is the full `FileMeta`. Emits `file.registered`; writes audit `file.attachment.uploaded`
with `details.sizeBytes`.

```
POST /api/v1/files
Content-Type: image/png
x-dub-filename: landing-hero.png

<raw image bytes>
```

### 4.9 `GET /api/v1/files/{id}/download` — download an R2 attachment

Streams the R2 attachment body. **R2-backed files only** — a Drive file (`driveFileId` set,
no `r2Key`) → `409 FILE_NOT_DOWNLOADABLE` (Drive files are served via the drive-proxy embed,
not this endpoint). A malformed / unknown / archived id → `404 NOT_FOUND`; an R2 object that
is registered but whose body is missing → `404 NOT_FOUND`. `private` files enforce the §4.3
read rule.

Response `200` returns the raw bytes (not JSON):

```
HTTP/1.1 200 OK
Content-Type: image/png
Content-Length: 184320
Content-Disposition: attachment; filename="landing-hero.png"

<raw bytes>
```

---

## 5. Visibility & read authorization

`visibility` is a closed enum, `org | private`:

- **`org`** — any caller with `file:read` may read the metadata, download the body, and see
  it in search.
- **`private`** — readable **only** by the file's `ownerId` or a caller holding `file:admin`.
  `file:read` alone is insufficient. This rule is enforced uniformly on `GET meta/{id}`,
  `GET {id}/download`, and by filtering `private` non-owned rows out of `GET search`.

Owner reassignment (`PATCH … ownerId`) is likewise `file:admin`-gated. All three keys
(`file:read`, `file:write`, `file:admin` ⚠) come from the frozen catalog in
[`auth.md`](../auth.md) §9; `file:admin` is a **dangerous** key (always re-checked fresh).

---

## 6. File-meta-specific error codes

Service codes ([`_conventions.md`](../_conventions.md) §3.2). Common codes
(`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, …)
behave per the foundation doc.

| Code | HTTP | `retryable` | When |
|---|---|---|---|
| `FILE_DUPLICATE_EXTERNAL` | 409 | false | Registering a `driveFileId` already in the registry. |
| `FILE_DELETED_IMMUTABLE` | 409 | false | Mutating (PATCH / add-link) a soft-deleted file. |
| `FILE_DUPLICATE_LINK` | 409 | false | Adding a `(fileId, targetType, targetId)` link that already exists. |
| `FILE_NOT_DOWNLOADABLE` | 409 | false | `GET {id}/download` on a Drive-backed (non-R2) file. |

Always branch on `code` + HTTP status, never on `message` text (5xx messages are redacted at
the boundary).

---

## 7. Events emitted

The service publishes canonical event envelopes (`@dub/events` `createEvent`: ULID id,
`requestId`, `actorId`). **P0 has no subscribers** for these — the catalog fan-out is empty,
so they are a forward-looking contract only. `actorId` is the acting `userId` for HTTP-driven
emits and `null` for queue-driven emits (system origin).

| Event | Emitted when | Payload |
|---|---|---|
| `file.registered` | `POST /files/meta`, `POST /files`, or `drive.file.created` ingest | `{ fileId }` |
| `file.updated` | `PATCH /files/meta/{id}` or `drive.file.moved` reflection | `{ fileId }` |
| `file.deleted` | `DELETE /files/meta/{id}` (first delete) or `drive.file.trashed` ingest | `{ fileId }` |
| `file.linked` | `POST /files/meta/{id}/links` | `{ fileId, targetType, targetId }` |
| `file.unlinked` | `DELETE /files/meta/{id}/links` | `{ fileId, targetType, targetId }` |

**Audit records** (`auditLog.AuditRecordInput`, `resourceType: "file"`, `orgId: org_devhub`)
are written for: `file.meta.registered`, `file.meta.updated` (`details.changed`),
`file.meta.deleted`, `file.link.added` / `file.link.removed` (`details: { targetType,
targetId }`), and `file.attachment.uploaded` (`details.sizeBytes`).

---

## 8. Events consumed

file-meta runs a queue consumer on its lane (`EVT_FILE_META`). Every handler is idempotent:
Drive files are deduped by `unique(driveFileId)`; all events pass the shared `IdempotencyStore`
keyed on the envelope id. Unknown event names are **acked** (no-op).

| Event | Payload | Action |
|---|---|---|
| `drive.file.created` | `{ driveFileId }` | Register a reflected `org` file (owner `"system"`, `sizeBytes: 0`), completing `name` / `mimeType` from drive-proxy when available. Skips if the `driveFileId` is already registered. Emits `file.registered`. |
| `drive.file.moved` | `{ driveFileId }` | If the file is known, live, and drive-proxy is reachable, reflect a changed `name`. No-op if unknown / deleted / name unchanged. Emits `file.updated` on change. |
| `drive.file.trashed` | `{ driveFileId }` | Soft-delete the reflected file. No-op if unknown / already deleted. Emits `file.deleted`. |
| `event.archived` | `{ eventId }` | Suppress (archive) links pointing at that event from search; **rows are kept**. |
| `action.archived` | `{ actionId }` | Suppress links pointing at that action. |
| `task.archived` | `{ taskId }` | Suppress links pointing at that task. |

`*.archived` suppresses only the **link** exposure (so a search no longer surfaces the file
through a dead entity); the file rows and link rows are retained for audit.

---

## 9. Contract-change discipline

Additive changes (a new optional response field, a new endpoint, a new `FILE_*` code, a new
`targetType` value) stay in `v1`. Breaking changes — removing / renaming a field, changing a
type, making an optional field required, altering a code's HTTP status, changing the
visibility read rule or the 25 MiB body cap semantics — require a version bump or a
frozen-decision review ([`_conventions.md`](../_conventions.md) §9). This file is the
file-meta component contract; [`_conventions.md`](../_conventions.md) + [`auth.md`](../auth.md)
are the cross-cutting foundation it builds on.
