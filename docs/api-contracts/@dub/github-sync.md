# Dub API Contract — @dub/github-sync

Status: Component contract (v1). github-sync keeps **GitHub Issues and `task-service` tasks in
two-way sync**. It is the sole owner of the GitHub App REST v3 client, of the D1 link/mapping
store (`github_*` namespace), and of the conflict-resolution + echo-suppression rules. It runs
three surfaces off one Worker: a small **admin/ops HTTP API** (repos, manual links, on-demand
sync runs), two **Queue consumers** (`wh-github` raw webhooks, `evt-github-sync` task/event domain
events), and a **reconcile cron** (`scheduled`). This doc specifies the **HTTP API** — the queue
and cron surfaces are described only where they explain a field a client sees.

Read [`../_conventions.md`](../_conventions.md) first (envelope, headers, error codes, cursor
pagination, retry rules) and [`../auth.md`](../auth.md) (session + permission model). This doc
only adds what is github-sync–specific.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Frozen wire types (minimal) | `packages/types/src/github-sync.ts` (`githubSync` namespace) |
| Service-local domain / request types | `services/github-sync/src/domain/types.ts` |
| HTTP routing + authn/authz wiring | `services/github-sync/src/app.ts` |
| Route-facing operations + validation | `services/github-sync/src/service.ts` |
| Permission keys (§8-N5 note) | `services/github-sync/src/auth.ts` |
| GitHub App client + error table | `services/github-sync/src/clients/github.ts` |
| Sync engine (conflict/echo/reconcile) | `services/github-sync/src/engine/sync.ts` |
| Queue consumers (webhook + domain) | `services/github-sync/src/queue.ts`, `src/index.ts` |
| D1 schema | `services/github-sync/src/store/schema.sql` |
| Fan-out + audit publishing | `services/github-sync/src/events/publisher.ts` |

If code and this doc disagree, the code wins and this doc must be corrected.

---

## 1. Surface & boundaries

github-sync is an **internal** Worker. Browsers reach the HTTP API **only through `api-gateway`**
under the `/api/v1` prefix; the gateway authenticates the session, mints the trusted
`x-dub-user-id`, and strips **only** `API_PREFIX` before proxying. Routes are mounted service-local
at `/github/*`:

| Gateway segment | External prefix | Service-local path |
|---|---|---|
| `github` | `/api/v1/github…` | `/github…` |

All paths below are written at the **external** (gateway) prefix. Every endpoint requires an
authenticated session; an absent `x-dub-user-id` at the service yields `401 UNAUTHENTICATED`
(checked before authz by `@dub/auth-client` `requireAuth()`).

**Content type** is `application/json` for every request and response body here. github-sync never
brokers file bytes.

**This is an admin / ops surface, not the main product loop.** The high-volume sync work happens on
the queue consumers and the cron — a user creating a task in the app does **not** call this API;
`task.*` domain events drive the GitHub write asynchronously. The HTTP API exists to **configure**
repos, **inspect/repair** links, and **kick** an on-demand reconcile. Because of that split, reads
here can lag the live GitHub/task state by up to one sync cycle; `syncState` on a link and the
`stats` on a run are the freshness signals (§2, §3.3).

---

## 2. Entities

### 2.1 `GithubLink` (`githubSync.GithubLink`) — frozen public projection

The link is the mapping between one task and one GitHub issue. The **stored** row
(`LinkRecord`, `domain/types.ts`) is a rich superset (`syncState`, `lastSyncedAt`,
`issueNodeId`, `lastTaskVersion`, `lastError`, …); every list/create endpoint projects it down to
the **frozen minimal** `githubSync.GithubLink` on the wire (`service.ts` `toPublicLink`):

```json
{
  "taskId": "task_01J9Z8M4C2Q7XR",
  "repo": "KIT-DevelopersHub/dub-ecosystem",
  "issueNumber": 142,
  "url": "https://github.com/KIT-DevelopersHub/dub-ecosystem/issues/142",
  "linkedAt": "2026-08-10T05:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `taskId` | string (`common.TaskId`) | The linked task. One task links to **at most one** issue (DB `UNIQUE(task_id)`). |
| `repo` | string | `"owner/name"` (joined from the stored `owner` + `repo` columns). |
| `issueNumber` | integer | GitHub issue number within `repo`. Unique per repo (`UNIQUE(repo_id, issue_number)`). |
| `url` | string | Derived `https://github.com/{owner}/{name}/issues/{number}` — convenience, never stored. |
| `linkedAt` | ISODateTime | The row's `createdAt`. |

> **Hidden state (not on the wire in v1).** `syncState` (`in_sync \| pending \| conflict \|
> error`), `lastError`, `lastSyncedAt`, `lastGithubUpdatedAt`, `lastTaskVersion`, `issueNodeId`,
> `projectItemId` are stored and drive the engine but are **not** projected onto `GithubLink`.
> Surfacing them is a pending additive enrichment (§9, discrepancy #2).

### 2.2 `GithubRepoConfig` (service-local) — registered repo

A repo must be **registered** before any issue in it will sync or before a manual link can point
at it. This entity has **no frozen `@dub/types` shape yet** — it is returned as-is from
`domain/types.ts` `GithubRepoConfig`:

```json
{
  "id": "ghr_01J9Z8M4C2ABCDEF",
  "owner": "KIT-DevelopersHub",
  "repo": "dub-ecosystem",
  "eventId": "evt_01J9Z0000CONF25",
  "defaultActionId": null,
  "origin": "github",
  "direction": "bidirectional",
  "enabled": true,
  "installationId": "48210394",
  "projectNumber": 11,
  "labelFilter": ["task"],
  "createdBy": "usr_01J9Z8M4C2XYZ",
  "createdAt": "2026-08-10T04:00:00Z",
  "updatedAt": "2026-08-10T04:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`ghr_<ULID>`) | Prefix-ULID. Path param for PATCH/DELETE. |
| `owner` / `repo` | string | GitHub `owner` + repository name. Validated (`owner` `/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/`, `repo` `/^[A-Za-z0-9._-]{1,100}$/`). Unique pair (`UNIQUE(owner, repo)`). |
| `eventId` | string (`common.EventId`) | The DevHub event this repo's issues belong to. **Verified to exist** against `event-service` at register/patch time. |
| `defaultActionId` | string \| null | Optional action bucket for imported tasks. |
| `origin` | `"internal" \| "github"` | **Conflict tie-breaker** (§5): which side wins when both moved. Default `"github"` (overridable by `GITHUB_ORIGIN_DEFAULT`). |
| `direction` | `"bidirectional" \| "internal_to_github" \| "github_to_internal"` | Which way writes flow. Default `"bidirectional"`. |
| `enabled` | boolean | Disabled repos are skipped by every path (webhook/event/reconcile/cron). `event.archived` sets this `false`. |
| `installationId` | string \| null | GitHub App installation id (the client can also resolve it lazily). |
| `projectNumber` | number \| null | Optional GitHub Projects (v2) number. Reserved; Projects sync is contract-only in v1. |
| `labelFilter` | string[] | If non-empty, an issue is imported as a task **only** if it carries at least one of these labels. Empty ⇒ import all. |
| `createdBy` | string (`common.UserId`) | The admin who registered it (`x-dub-user-id`). |
| `createdAt` / `updatedAt` | ISODateTime | Row timestamps. |

### 2.3 `SyncRunRecord` (service-local) — one sync execution

A run is a single reconcile pass (manual `POST /github/sync`, or a system-origin `webhook` / `cron`
run). Returned as-is (`domain/types.ts` `SyncRunRecord`):

```json
{
  "id": "ghs_01J9Z8M4C2RUN01",
  "scope": "event",
  "repoId": null,
  "status": "succeeded",
  "stats": { "created": 3, "updated": 5, "skipped": 40, "conflicts": 1, "failed": 0 },
  "triggeredBy": "usr_01J9Z8M4C2XYZ",
  "startedAt": "2026-08-10T06:00:00Z",
  "finishedAt": "2026-08-10T06:00:12Z",
  "error": null,
  "createdAt": "2026-08-10T06:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (`ghs_<ULID>`) | Prefix-ULID. Cron runs use a `ghs_cron_<ms>` id. |
| `scope` | `"task" \| "event" \| "all" \| "repo" \| "webhook" \| "cron"` | The first three are caller-triggerable (§3.3); `repo`/`webhook`/`cron` are system-origin. |
| `repoId` | string \| null | Set when the run targets a single repo; null for multi-repo passes. |
| `status` | `"queued" \| "running" \| "succeeded" \| "partial_failed" \| "failed"` | A run with any `stats.failed > 0` finishes `partial_failed`. |
| `stats` | `{ created, updated, skipped, conflicts, failed }` | Per-issue outcome counters (all integers). |
| `triggeredBy` | string \| null | `x-dub-user-id` for manual runs; `null` for cron. |
| `startedAt` / `finishedAt` | ISODateTime \| null | `finishedAt` null while running. |
| `error` | string \| null | Set when the whole run threw (e.g. rate-limit abort). Redaction rules of §6 apply. |
| `createdAt` | ISODateTime | Row creation. |

---

## 3. Endpoints

### 3.1 Links

#### `GET /api/v1/github/links` — list links

Permission: `github:read`. Cursor-paginated (`githubSync.ListLinksResponse = Paginated<GithubLink>`).

Query params:

| Param | Type | Required | Notes |
|---|---|---|---|
| `taskId` | string | no | Exact task filter. |
| `repo` | string | no | `"owner/name"` (split on `/`) or a bare repository name — server matches accordingly. |
| `cursor` | string (opaque) | no | Echo a prior `nextCursor`. |
| `limit` | integer | no | Default **50**, **max 200** (conventions cap). Non-positive / non-finite ⇒ coerced to 50; larger ⇒ clamped to 200 (no `400`). |
| `syncState` | repeated | no | Accepted on the wire (repeatable) but **not applied** in v1 — the frozen `ListLinksQuery` has no `syncState`, so the service ignores it. Documented no-op. |

Response `200` (`Paginated<GithubLink>`):

```json
{
  "items": [
    { "taskId": "task_01J9…", "repo": "KIT-DevelopersHub/dub-ecosystem", "issueNumber": 142, "url": "https://github.com/KIT-DevelopersHub/dub-ecosystem/issues/142", "linkedAt": "2026-08-10T05:00:00Z" }
  ],
  "nextCursor": null
}
```

`nextCursor === null` ⇒ last page.

#### `POST /api/v1/github/links` — manually link a task to an existing issue

Permission: `github:write`. Creates a link between an **existing** task and an **existing** issue in
a **registered, enabled** repo. Does not create the issue.

Request (`CreateLinkRequest`):

```json
{ "taskId": "task_01J9Z8M4C2Q7XR", "owner": "KIT-DevelopersHub", "repo": "dub-ecosystem", "issueNumber": 142 }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `taskId` | string | **yes** | Missing/blank ⇒ `400 GITHUB_VALIDATION_FAILED` (`{ field: "taskId", reason: "required" }`). |
| `owner` | string | **yes** | Fails `owner` regex ⇒ `400` (`{ field: "owner", reason: "invalid" }`). |
| `repo` | string | **yes** | Repository name (not `owner/name`). Fails regex ⇒ `400` (`{ field: "repo", reason: "invalid" }`). |
| `issueNumber` | integer > 0 | **yes** | Non-integer or ≤ 0 ⇒ `400` (`{ field: "issueNumber", reason: "invalid" }`). |

Ordered failure modes (after validation):

| Condition | Error |
|---|---|
| `owner/repo` not registered | `404 GITHUB_REPO_NOT_FOUND` |
| repo registered but `enabled=false` | `422 GITHUB_REPO_DISABLED` |
| task already linked | `409 GITHUB_LINK_ALREADY_EXISTS` |
| that issue already linked | `409 GITHUB_LINK_ALREADY_EXISTS` |
| issue absent on GitHub | `404 GITHUB_REPO_NOT_FOUND` |

Response `201`: a bare `GithubLink` (§2.1). New links start with hidden `syncState = "pending"`.
Emits `github.link_created` (§7).

#### `DELETE /api/v1/github/links/:id` — unlink

Permission: `github:write`. `:id` is the stored link id (`ghl_<ULID>`). Unknown id ⇒
`404 GITHUB_LINK_NOT_FOUND`. Deletes the mapping only — **the task and the issue are left intact**.

Response `204` (no body). Emits `github.link_removed` (§7).

### 3.2 Repos

#### `GET /api/v1/github/repos` — list registered repos

Permission: `github:read`. Cursor-paginated.

| Param | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string | no | Filter to one event. |
| `cursor` | string | no | Opaque. |
| `limit` | integer | no | Default 50, max 200 (same clamp as §3.1). |

Response `200`: `{ "items": GithubRepoConfig[], "nextCursor": string | null }` (full configs, §2.2).

#### `POST /api/v1/github/repos` — register a repo

Permission: `github:admin`. Enrolls an `owner/repo` for syncing under one event.

Request (`RegisterRepoRequest`):

```json
{
  "owner": "KIT-DevelopersHub",
  "repo": "dub-ecosystem",
  "eventId": "evt_01J9Z0000CONF25",
  "origin": "github",
  "direction": "bidirectional",
  "installationId": "48210394",
  "projectNumber": 11,
  "labelFilter": ["task"],
  "defaultActionId": null
}
```

| Field | Type | Required | Default / notes |
|---|---|---|---|
| `owner` | string | **yes** | `owner` regex; else `400` (`{ field: "owner", reason: "invalid" }`). |
| `repo` | string | **yes** | `repo` regex; else `400` (`{ field: "repo", reason: "invalid" }`). |
| `eventId` | string | **yes** | Missing ⇒ `400` (`{ field: "eventId", reason: "required" }`). **Verified against event-service**; unknown ⇒ `400 GITHUB_VALIDATION_FAILED` (`unknown eventId`). |
| `origin` | `"internal" \| "github"` | no | Default `GITHUB_ORIGIN_DEFAULT` (falls back to `"github"`). Conflict winner (§5). |
| `direction` | enum | no | Default `"bidirectional"`. |
| `installationId` | string | no | Default null. |
| `projectNumber` | number | no | Default null. |
| `labelFilter` | string[] | no | Default `[]` (import all). |
| `defaultActionId` | string | no | Default null. |

Already-registered `owner/repo` ⇒ `409 GITHUB_REPO_ALREADY_REGISTERED`. New repos are created
`enabled: true`.

Response `201`: the created `GithubRepoConfig`. Writes audit `github.repo.registered` (§7).

#### `PATCH /api/v1/github/repos/:id` — update a repo config

Permission: `github:admin`. Partial update; only present keys change. `:id` unknown ⇒
`404 GITHUB_REPO_NOT_FOUND`.

Request (`UpdateRepoRequest`, all optional): `enabled`, `eventId`, `defaultActionId`, `origin`,
`direction`, `installationId`, `projectNumber`, `labelFilter`. A supplied `eventId` is
**re-verified** against event-service (unknown ⇒ `400 GITHUB_VALIDATION_FAILED`).

```json
{ "enabled": false, "labelFilter": ["task", "bug"] }
```

Response `200`: the updated `GithubRepoConfig`. Writes audit `github.repo.updated`
(`details.changed` = the patched key names).

#### `DELETE /api/v1/github/repos/:id` — deregister a repo

Permission: `github:admin`. Unknown id ⇒ `404 GITHUB_REPO_NOT_FOUND`.

Response `204` (no body). Writes audit `github.repo.deregistered`.

> **Caution (documented behaviour).** Deregister removes the repo row; existing `github_links` rows
> reference it via `repo_id`. v1 does not cascade-delete links here — deregister a repo only after
> its links are cleared, or they become orphaned (engine treats a missing repo as `skipped`).

### 3.3 Sync runs

#### `POST /api/v1/github/sync` — trigger an on-demand reconcile (synchronous)

Permission: `github:sync`. Runs a reconcile pass **inline** and returns when it finishes. Despite
the `202` status it is **not** a fire-and-forget enqueue — the response carries the terminal
`status`.

Request (`githubSync.TriggerSyncRequest`):

```json
{ "scope": "event", "targetId": "evt_01J9Z0000CONF25" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `scope` | `"task" \| "event" \| "all"` | **yes** | Other value ⇒ `400 GITHUB_VALIDATION_FAILED` (`{ field: "scope", reason: "invalid" }`). |
| `targetId` | string | conditional | **Required** when `scope` is `"event"` (an `eventId`) or `"task"` (a `taskId`); ignored for `"all"`. Missing ⇒ `400` (`{ field: "targetId", reason: "required" }`). |
| `runScope` | `"incremental" \| "full"` | no | Accepted by the frozen type; v1 always reconciles full and does not branch on it (documented no-op). |

A same-scope run already in progress ⇒ `409 GITHUB_SYNC_IN_PROGRESS` (single-flight per scope).
`scope: "task"` with an unlinked `targetId` ⇒ `404 GITHUB_LINK_NOT_FOUND`.

Response `202` (`{ runId, status }`) — the run is already terminal at return:

```json
{ "runId": "ghs_01J9Z8M4C2RUN01", "status": "succeeded" }
```

`status` is `"succeeded"` (no per-issue failures) or `"partial_failed"` (≥1 issue failed, or the
pass threw — e.g. GitHub rate-limit abort). Fetch the full counters via §3.3-GET. Writes audit
`github.sync.triggered` (`details.scope`). Emits `github.sync_completed` on success or
`github.sync_failed` on a thrown pass (§7).

#### `GET /api/v1/github/sync/runs` — list runs

Permission: `github:read`. Cursor-paginated, newest first.

| Param | Type | Notes |
|---|---|---|
| `cursor` | string | Opaque. |
| `limit` | integer | Default 50, max 200. |

Response `200`: `{ "items": SyncRunRecord[], "nextCursor": string | null }` (§2.3). Includes
system-origin `webhook`/`cron` runs.

#### `GET /api/v1/github/sync/runs/:id` — get one run

Permission: `github:read`. Unknown id ⇒ `404 NOT_FOUND` (the **common** code here, not a
`GITHUB_*` one — see §6). Response `200`: a bare `SyncRunRecord`.

---

## 4. Endpoint & permission summary

All paths at the external (`/api/v1`) prefix. Permissions are github-sync's own domain keys
(`github:read \| write \| sync \| admin`, `src/auth.ts`).

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /api/v1/github/links` | `github:read` | List links (cursor paging) |
| `POST /api/v1/github/links` | `github:write` | Manually link a task ↔ existing issue |
| `DELETE /api/v1/github/links/:id` | `github:write` | Unlink (task + issue kept) |
| `GET /api/v1/github/repos` | `github:read` | List registered repos |
| `POST /api/v1/github/repos` | `github:admin` | Register a repo |
| `PATCH /api/v1/github/repos/:id` | `github:admin` | Update a repo config |
| `DELETE /api/v1/github/repos/:id` | `github:admin` | Deregister a repo |
| `POST /api/v1/github/sync` | `github:sync` | Trigger a reconcile (inline) |
| `GET /api/v1/github/sync/runs` | `github:read` | List sync runs |
| `GET /api/v1/github/sync/runs/:id` | `github:read` | Get one run |

A missing permission ⇒ `403 FORBIDDEN`. Authz is resolved via identity `/authz/check`
(`auth.md` §10); each route checks exactly one org-scoped key before running.

> **Permission-catalog note — KNOWN GAP 8-N5 (documented deviation).** `github:read`,
> `github:write`, `github:sync`, `github:admin` are **not yet** in the frozen 23-key
> `PERMISSION_CATALOG` closed union. github-sync holds them as string constants (`src/auth.ts`)
> and casts to `identity.PermissionKey` at the `/authz/check` wire boundary (`asPermissionKey`).
> Until the catalog change lands, identity **default-denies** unknown keys, so **every endpoint here
> returns `403` in a real deployment**. The wire string is identical, so adding the four keys to the
> union is a pure tightening with zero caller change (§9).

---

## 5. Sync direction, conflict resolution & echo suppression (client-visible model)

These rules run on the queue/cron paths, not on the HTTP API, but they explain the `status`,
`stats.conflicts`, and hidden `syncState` a client observes.

- **Direction gate (`repo.direction`).** `internal_to_github` ignores inbound GitHub webhooks;
  `github_to_internal` ignores inbound task events. `bidirectional` accepts both.
- **Change detection.** A side is "moved" if GitHub's `updated_at` advanced past the link's
  `lastGithubUpdatedAt`, or the task's `version` advanced past `lastTaskVersion`.
- **Conflict (both moved) → `repo.origin` wins.** `origin: "github"` ⇒ the issue overwrites the
  task; `origin: "internal"` ⇒ the task overwrites the issue. Either way the run counts a
  `conflict` (not a `failed`) and emits `github.conflict_detected` (→ notification, §7). No data is
  dropped silently; the losing side is overwritten by design.
- **Echo suppression.** Writes github-sync itself makes are tagged (task writes carry a system/no
  actor context; GitHub writes come from the App's own login, listed in `GITHUB_SELF_LOGINS`). An
  inbound event/webhook recognized as self-caused is `skipped`, so a sync write never ping-pongs.
- **Label mapping.** task status ↔ GitHub `state` + `status:*` labels; free-form GitHub labels are
  preserved. `labelFilter` gates which *new* issues get imported as tasks (existing links always
  reconcile). task-service has no free-form label field, so labels are a GitHub-side status
  representation only.
- **task origin read-only.** A task whose own origin is GitHub-managed can reject an internal→GitHub
  push with `422 TASK_GITHUB_ORIGIN_READONLY` (from task-service); the engine marks that link
  `syncState: "error"` **permanently** (not retried) and counts it `failed`.

---

## 6. Errors

github-sync uses the standard error envelope (`_conventions.md` §2.2) and defines its own
`GITHUB_*` codes for domain conditions, alongside the shared `VALIDATION_FAILED`/`NOT_FOUND` family.
GitHub's own upstream error body is **never** leaked verbatim to the client (only a short,
credential-free message; the App key/token never appear).

**Service codes surfaced by the HTTP API:**

| Code | HTTP | `retryable` | When |
|---|---|---|---|
| `GITHUB_VALIDATION_FAILED` | 400 | false | Field validation (carries `details: [{ field, reason }]`); also invalid JSON body and unknown `eventId`. |
| `GITHUB_REPO_NOT_FOUND` | 404 | false | Link target repo not registered, or the issue is absent on GitHub. |
| `GITHUB_LINK_NOT_FOUND` | 404 | false | `DELETE /links/:id` / `sync scope=task` on an unknown link. |
| `GITHUB_REPO_DISABLED` | 422 | false | Manual link into an `enabled=false` repo. |
| `GITHUB_LINK_ALREADY_EXISTS` | 409 | false | Task already linked, or issue already linked. |
| `GITHUB_REPO_ALREADY_REGISTERED` | 409 | false | `POST /repos` on an existing `owner/repo`. |
| `GITHUB_SYNC_IN_PROGRESS` | 409 | false | Same-scope reconcile already running (single-flight). |
| `NOT_FOUND` (common) | 404 | false | `GET /sync/runs/:id` unknown id (uses the **common** code, not `GITHUB_*`). |
| `UNAUTHENTICATED` (common) | 401 | false | No `x-dub-user-id` (before authz). |
| `FORBIDDEN` (common) | 403 | false | Missing `github:*` permission (see §4 / 8-N5 — currently all keys). |

**Upstream GitHub → Dub conversion (client.mapError, mostly internal to the sync paths).** These can
appear on a run's `error` field or a `POST /sync` `partial_failed`, and `GITHUB_NOT_FOUND` also
surfaces as the manual-link 404:

| GitHub status | Dub code | HTTP | `retryable` | Notes |
|---|---|---|---|---|
| 429, or 403 with `x-ratelimit-remaining: 0` | `GITHUB_RATE_LIMITED` | 429 | true | Carries `details.retryAfterSec` when `Retry-After` present. Aborts a reconcile pass. |
| 401 | `GITHUB_UNAUTHORIZED` | 502 | false | App credential fault, surfaced as an upstream fault (no `401` reflected). |
| 403 (not rate limit) | `GITHUB_FORBIDDEN` | 502 | false | GitHub denied the App. |
| 404 | `GITHUB_NOT_FOUND` | 404 | false | Issue/repo not visible to the App. |
| 410 | `GITHUB_GONE` | 404 | false | Resource gone. |
| 422 | `GITHUB_UNPROCESSABLE` | 422 | false | GitHub rejected the payload. |
| ≥ 500 | `GITHUB_UNAVAILABLE` | 502 | true | GitHub outage; also network failure to reach GitHub. |
| other non-2xx | `GITHUB_REQUEST_FAILED` | 502 | false | Fallback. |
| App not configured | `GITHUB_NOT_CONFIGURED` | 502 | false | `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` unset (fail-closed stub). |
| App key unimportable | `GITHUB_APP_KEY_INVALID` | 500 | false | PEM import failed; key never leaked. |
| Malformed GitHub body | `GITHUB_UNEXPECTED_RESPONSE` | 502 | true | Non-JSON / missing id. |

Client guidance: branch on `code` + HTTP status, never on `message` (upstream detail is truncated /
redacted). Retryable codes follow the standard retry/backoff + `Retry-After` rules
(`_conventions.md` §7); honour `retryAfterSec` before retrying a `GITHUB_RATE_LIMITED`.

---

## 7. Fan-out events & audit

**Domain events** (via `@dub/events`, frozen minimal payloads — `packages/events/src/payloads.ts`):

| Event | Emitted by | Payload | Subscribers |
|---|---|---|---|
| `github.link_created` | `POST /links`, and issue-import on the sync paths | `{ taskId, repo }` | (none in v1) |
| `github.link_removed` | `DELETE /links/:id` | `{ taskId, repo }` | (none in v1) |
| `github.sync_completed` | `POST /sync` success | `{ scope }` | (none in v1) |
| `github.sync_failed` | `POST /sync` thrown pass | `{ scope, error }` | notification |
| `github.conflict_detected` | conflict on any sync path | `{ taskId }` | notification |

Publish is a best-effort side effect after the DB write; consumers dedupe on the envelope `id`.

**Audit** (to `AUDIT_QUEUE`, `auditLog.AuditRecordInput`, `resourceType: "github_repo"`,
`orgId: DUB_DEFAULT_ORG_ID`, `actorId` = `x-dub-user-id`, `requestId` propagated, `occurredAt` =
server ISO time):

| Endpoint | Audit `action` | `details` |
|---|---|---|
| `POST /repos` | `github.repo.registered` | `{ owner, repo }` |
| `PATCH /repos/:id` | `github.repo.updated` | `{ changed: [keys] }` |
| `DELETE /repos/:id` | `github.repo.deregistered` | `null` |
| `POST /sync` | `github.sync.triggered` | `{ scope }` |

Link create/delete emit **domain events only** (no audit row) in v1. audit-log does not subscribe to
domain events — audit is a separate emission.

**Inbound queue consumers** (not HTTP; listed for completeness): `wh-github`
(`dub-q-wh-github`, raw GitHub webhooks, >96 KB payloads read from R2) and `evt-github-sync`
(`dub-q-evt-github-sync`, `task.created|updated|assigned|status_changed|archived`,
`event.archived`). Both dedupe on `envelope.id`; unknown kinds are acked. The reconcile **cron**
(`scheduled`) reconciles every enabled repo and purges processed-event rows older than 14 days.

---

## 8. Idempotency, rate-limiting, single-flight

- **Single-flight per scope.** `POST /sync` refuses a second same-scope run with
  `409 GITHUB_SYNC_IN_PROGRESS` (`runs.hasActive`), so overlapping reconciles cannot double-write.
- **Queue idempotency.** Every webhook/domain-event handler dedupes on `envelope.id` via the
  `github_processed_events` store (the frozen "every handler idempotent on envelope.id" rule);
  processed rows are purged after 14 days by the cron.
- **HTTP idempotency.** `POST /links` and `POST /repos` are naturally guarded by the DB uniqueness
  (second attempt ⇒ `409`), so a retry is safe. `POST /sync` is guarded by single-flight. `DELETE`
  is idempotent in effect (second call ⇒ `404`). Standard `x-dub-idempotency-key` handling follows
  `_conventions.md` §7.
- **GitHub rate limits.** Surface as `GITHUB_RATE_LIMITED` (429, `retryAfterSec`); a reconcile pass
  aborts and finishes `partial_failed` rather than hammering GitHub.

---

## 9. Contract-change discipline

Additive-safe within `v1`: a new optional repo-config field, a new `labelFilter` semantic, a new
subscriber for an existing `github.*` event, adding read-only fields to `GithubLink` (surfacing
`syncState`/`lastError`), promoting `GithubRepoConfig`/`SyncRunRecord` into `@dub/types` **as long
as the wire stays identical**. **Breaking** (needs a version bump or frozen-decision review):
changing an existing endpoint's shape or status, changing a `github.*` event payload, changing the
GitHub-error → Dub-code table (§6), or changing the conflict-resolution rule (§5).

**Two reconciliation asks flagged to the parent (frozen-decision review):**

1. **8-N5 — permission catalog.** Add `github:read/write/sync/admin` to the frozen
   `PERMISSION_CATALOG` union. Until then every endpoint here `403`s in a real deployment (§4).
2. **`@dub/types.githubSync` enrichment.** The frozen namespace is minimal (`GithubLink` = 5
   fields; `TriggerScope` = `task|event|all`). The live service returns a richer surface
   (`GithubRepoConfig`, `SyncRunRecord`, hidden link `syncState`). Decide whether to freeze these
   shapes into `@dub/types` or keep them service-local. This doc documents the live wire either way.

See [`../_conventions.md`](../_conventions.md) §9 for the shared change policy.
