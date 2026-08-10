# Dub Notification Contract

Status: Component contract (v1) for the **notification** service — ingest + delivery +
self-scoped inbox / preferences. Read [`_conventions.md`](./_conventions.md) for the shared
envelope, headers, error codes, pagination and IDs, and [`auth.md`](./auth.md) for session /
permission semantics. Everything here inherits those; only notification-specific shapes,
paths, and error codes are stated below.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Wire types (`NotifyRequest`, `InboxItem`, `PreferenceEntry`, …) | `packages/types/src/notification.ts` |
| HTTP routes + guards | `services/notification/src/app.ts` |
| Input validation + `NOTIF_*` validation codes | `services/notification/src/validation.ts` |
| Preference resolution (defaults + overrides) | `services/notification/src/preferences.ts` |
| Ingest core (dedup → persist → resolve → fan-out) | `services/notification/src/ingest.ts` |
| Persistence + cursor codec | `services/notification/src/repo.ts` |
| Constants (limits, retention, channels) | `services/notification/src/config.ts` |
| Gateway route mapping | `services/api-gateway/src/routes.ts` (`segment: "notifications"`) |

If code and this doc disagree, the code wins and this doc must be corrected to match.

---

## 1. Surface in one paragraph

The notification service has **one write entrypoint that is internal-only** (`POST /notify`,
Lane C of a 3-lane ingest) and **five self-scoped read/write endpoints** the browser reaches
through the gateway (inbox list / unread-count / mark-read / mark-all-read, and preferences
get / update). Ingest also runs headlessly from two non-HTTP lanes — the event-queue consumer
(Lane A domain events + Lane B `notification.requested`) and a daily retention-purge cron —
neither of which is a wire contract. Delivery fans out through pluggable channel adapters
(`in_app` is the implemented source of truth; `email` / `chat` / `push` wire to ports that
are stubbed in P0). Every self-scoped endpoint is scoped to the caller's `x-dub-user-id`; a
user can only ever read or mutate **their own** inbox and preferences.

---

## 2. Topology & paths

The FE-facing (external) routes live under the gateway prefix `/api/v1` behind the
`notifications` segment (`ROUTES` in `api-gateway/src/routes.ts`, `binding: "SVC_NOTIFICATION"`,
`auth: "required"`). The gateway authenticates the session, mints the trusted `x-dub-user-id`
header, and forwards. `POST /notify` and `/internal/*` are declared `internalOnlyPaths`, so the
gateway **404s them externally** — they are reachable only over a Service Binding carrying
`x-dub-internal: 1`.

| Method & external path | Auth | Purpose |
|---|---|---|
| `GET /api/v1/notifications/inbox` | session | List the caller's inbox (cursor-paged) |
| `GET /api/v1/notifications/inbox/unread-count` | session | Unread badge count |
| `PATCH /api/v1/notifications/inbox/:id/read` | session | Mark one inbox item read |
| `POST /api/v1/notifications/inbox/read-all` | session | Mark all (optionally by type prefix) read |
| `GET /api/v1/notifications/preferences` | session | Effective per-type channel preferences |
| `PATCH /api/v1/notifications/preferences` | session | Replace per-type channel preferences |
| `POST /notify` | `x-dub-internal` | **Internal-only** ad-hoc ingest (Lane C). 404 externally |
| `GET /internal/health` | none (internal) | Liveness |

**Wiring note (for implementers, not a public-contract clause):** the gateway strips only the
`/api/v1` prefix and forwards the segment-inclusive path (`/notifications/inbox`), whereas the
service today registers its Hono routes at the root (`/inbox`, `/notify`, `/preferences`, …).
The FE-facing contract is the external column above; reconciling the forwarded path with the
service mount is a wiring concern owned outside this doc.

---

## 3. `POST /notify` — internal ingest (Lane C)

Internal-only. Callers are other services over a Service Binding; the request **must** carry
`x-dub-internal: 1` (else `403 FORBIDDEN`). It is not part of the browser API — the FE never
calls it. Behaviour is shared with the queue lanes: business-dedup → persist the canonical
notification → resolve recipients → apply per-user preferences per channel → fan out to
adapters.

Request (`notification.NotifyRequest`):

```json
{
  "type": "task.assigned",
  "recipientIds": ["user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9"],
  "title": "A task was assigned to you",
  "body": "Design the landing page",
  "channels": ["in_app", "email"],
  "dedupKey": "task.assigned:task_01J9Z...",
  "resourceType": "task",
  "resourceId": "task_01J9Z..."
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | Open vocabulary; dot-separated lowercase tokens (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`) |
| `recipientIds` | string[] | yes | Direct user ids. `0..1000` (`MAX_DIRECT_RECIPIENTS`). Empty ⇒ persisted no-op |
| `title` | string | yes | Length `1..200` |
| `body` | string | yes | May be `""` |
| `channels` | `NotificationChannel[]` | no | Desired subset of `in_app,email,chat,push`; preferences still decide the final per-user set. Omitted ⇒ all channels are candidates |
| `dedupKey` | string | no | Business idempotency key (convention `"{eventName}:{resourceId}"`) |
| `resourceType` | string | no | Deep-link resource kind (e.g. `"task"`) |
| `resourceId` | string | no | Deep-link resource id |

Response `202 Accepted` (`{ notificationId, deduplicated }`):

```json
{ "notificationId": "ntfn_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "deduplicated": false }
```

- Always `202` — delivery is asynchronous fan-out, not part of the response.
- A repeat of a previously seen `dedupKey` returns `202` with `"deduplicated": true` and the
  **original** `notificationId`. Dedup is **never** a `409` (§_conventions 2.2 notwithstanding —
  this is a deliberate accept-and-collapse, not a conflict).
- Priority is not a request field: it is `"normal"` for this lane (the `urgent` signal, which
  turns the email default on, is derived only from Lane-A event-mapping rules).

Errors: `NOTIF_VALIDATION_FAILED` (400), `FORBIDDEN` (403, missing `x-dub-internal`),
`NOTIF_RECIPIENT_RESOLUTION_FAILED` (502, retryable — only when a role/event recipient spec
must be expanded via identity/event and that upstream fails; the direct-`recipientIds` path
never hits it).

---

## 4. Inbox (self-scoped)

Every inbox route requires a session and is scoped to the caller's `x-dub-user-id`. There is no
`requirePermission` gate: the catalog keys `notif:inbox:self` / `notif:prefs:self`
(§auth 9.2) describe the capability, but self-access is enforced structurally — every query is
filtered by `userId`, so another user's rows are invisible (a foreign id yields `404`, not
`403`).

### 4.1 `GET /inbox` — list

Cursor-paged (§_conventions 5). Query params:

| Param | Type | Default | Max | Notes |
|---|---|---|---|---|
| `unreadOnly` | boolean (`"true"`/`"false"`) | `false` | — | Filter to unread rows |
| `cursor` | string (opaque) | — | — | Echo `nextCursor`; opaque base64url — never construct it |
| `limit` | integer | 50 | 200 | `< 1` or `> 200` ⇒ `NOTIF_VALIDATION_FAILED` |

```
GET /api/v1/notifications/inbox?unreadOnly=true&limit=20
```

Response `200` (`notification.ListInboxResponse` = `Paginated<InboxItem>`):

```json
{
  "items": [
    {
      "id": "ntfi_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
      "type": "task.assigned",
      "title": "A task was assigned to you",
      "body": "Design the landing page",
      "readAt": null,
      "createdAt": "2026-08-10T05:00:00Z",
      "resourceType": "task",
      "resourceId": "task_01J9Z..."
    }
  ],
  "nextCursor": "bnRmaV8wMUo5Wg"
}
```

`InboxItem` fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string (`ntfi_`-ULID) | The **inbox row** id — the id used for `PATCH /inbox/:id/read` (not the `ntfn_` notification id) |
| `type` | string | The notification type |
| `title` | string | |
| `body` | string | Never null on the wire — a null stored body is projected to `""` |
| `readAt` | `ISODateTime \| null` | `null` = unread; the ISO-8601 UTC instant it was first read otherwise |
| `createdAt` | `ISODateTime` | |
| `resourceType` | `string \| null` | Deep-link kind |
| `resourceId` | `string \| null` | Deep-link id |

`nextCursor` is `null` at the end of the set. Ordering is newest-first (descending inbox id).

### 4.2 `GET /inbox/unread-count`

```json
{ "count": 3 }
```

Response `200` (`notification.UnreadCountResponse`). Counts the caller's unread rows across all
types.

### 4.3 `PATCH /inbox/:id/read` — mark one read

`:id` is the **inbox row id** (`ntfi_...`) from `InboxItem.id`. Idempotent — `read_at` keeps its
first value on repeat.

Response `200`:

```json
{ "ok": true }
```

Errors: `NOTIF_INBOX_ITEM_NOT_FOUND` (404) when the id does not exist **or belongs to another
user** (self-scoping hides foreign rows behind 404, never 403).

### 4.4 `POST /inbox/read-all` — mark all read

Body optional; empty body / `{}` marks every unread row read. An optional `type` narrows the
sweep to a type prefix.

```json
{ "type": "task." }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | no | Type prefix or exact type (`isValidTypePattern`: `"*"`, exact, or trailing-dot prefix). Malformed ⇒ `NOTIF_VALIDATION_FAILED` (400) |

Response `200`:

```json
{ "updated": 3 }
```

`updated` is the number of rows transitioned unread → read.

---

## 5. Preferences (self-scoped)

Per-`(type, channel)` opt-in/out over a **system-default baseline**. Defaults (frozen,
`preferences.ts`):

| Channel | Default | Rule |
|---|---|---|
| `in_app` | on for all types **except** `chat.*` | avoids double-count with the FE chat unread badge |
| `email` | on only for `urgent` notifications | ad-hoc `/notify` + `notification.requested` are `normal` ⇒ off by default |
| `chat` | off | |
| `push` | on | |

Resolution is **longest-prefix-match**: an exact-type override beats a `"task."` prefix override,
which beats the `"*"` wildcard; at equal specificity an override beats the default. Type patterns
are `"*"`, an exact type, or a trailing-dot prefix (`"task."`).

### 5.1 `GET /preferences`

Returns the merged **effective** view — one entry per type pattern the user has touched, plus
the `"*"` baseline — where each entry lists the channels currently **enabled** for that pattern.

```json
{
  "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "entries": [
    { "type": "*", "channels": ["in_app", "push"] },
    { "type": "task.", "channels": ["in_app", "email", "push"] }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `userId` | string | The caller (echoed) |
| `entries` | `PreferenceEntry[]` | Each `{ type, channels }` where `channels` is the set of **enabled** channels for that type pattern (normal-priority resolution) |

> Note: the response is `{ userId, entries }`, **not** a bare `PreferenceEntry[]`. `PreferenceEntry`
> (`{ type, channels }`) is the frozen `@dub/types` shape; the `{ userId, entries }` envelope is
> the notification-service response wrapper for both GET and PATCH.

### 5.2 `PATCH /preferences`

Replaces the caller's overrides from the supplied entries. For each entry, every channel **in**
`channels` is enabled and every channel **absent** is disabled; an override equal to the system
default is dropped (stored as "no override") rather than persisted, so the baseline keeps
tracking future default changes.

Request:

```json
{
  "entries": [
    { "type": "task.", "channels": ["in_app", "email"] },
    { "type": "chat.", "channels": [] }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `entries` | `PreferenceEntry[]` | yes | Missing/!array ⇒ `NOTIF_VALIDATION_FAILED` (400) |
| `entries[].type` | string | yes | Valid type pattern; bad shape ⇒ `NOTIF_UNKNOWN_TYPE_PATTERN` (400) |
| `entries[].channels` | `NotificationChannel[]` | yes | Subset of `in_app,email,chat,push`; anything else ⇒ `NOTIF_VALIDATION_FAILED` |

Response `200` — the same `{ userId, entries }` merged view as `GET /preferences`, reflecting the
applied changes.

---

## 6. Health

`GET /internal/health` → `200 { "status": "ok", "service": "notification" }`. Internal liveness;
not routed through the gateway.

---

## 7. Error codes (notification-specific)

Service codes are `<SERVICE>_<REASON>` with an explicit HTTP status (§_conventions 3.2), carried
in the standard `ErrorResponse` envelope. Common codes (`UNAUTHENTICATED` 401, `FORBIDDEN` 403,
`RATE_LIMITED` 429, `PAYLOAD_TOO_LARGE` 413, …) behave per `_conventions.md`.

| Code | HTTP | `retryable` | When | Endpoints |
|---|---|---|---|---|
| `NOTIF_VALIDATION_FAILED` | 400 | false | Malformed input; `details: FieldError[]` (dotted paths, e.g. `recipientIds`, `entries[2].channels`, `limit`) | all writes + `GET /inbox` query |
| `NOTIF_UNKNOWN_TYPE_PATTERN` | 400 | false | A preference/read-all `type` is not a valid pattern (`details: [{ field, reason: "invalid_pattern" }]`) | `PATCH /preferences`, `POST /inbox/read-all` |
| `NOTIF_INBOX_ITEM_NOT_FOUND` | 404 | false | Inbox row absent, or owned by another user (self-scope hides it) | `PATCH /inbox/:id/read` |
| `NOTIF_RECIPIENT_RESOLUTION_FAILED` | 502 | true | Role/event recipient expansion via identity/event failed | `POST /notify` (internal) + queue lanes |
| `FORBIDDEN` | 403 | false | `POST /notify` without `x-dub-internal` | `POST /notify` |
| `UNAUTHENTICATED` | 401 | false | No session on a self-scoped route | inbox + preferences |

Client guidance: branch on `code` + HTTP status, never message text. A `401` on any self-scoped
call ⇒ attempt one silent `/api/v1/auth/refresh`, else route to login (§auth 11). `NOTIF_VALIDATION_FAILED`
`details` key FE form errors by `field` + `reason`.

---

## 8. Authorization notes

- **Self-scoped, no permission gate.** Inbox and preferences require only a valid session; the
  service scopes every query to `x-dub-user-id`. The `notif:inbox:self` / `notif:prefs:self`
  catalog keys (§auth 9.2) name the capability but are not enforced via `/authz/check` here —
  ownership is structural.
- **Producers.** The catalog also holds `notif:send` and `notif:admin` for services/roles that
  emit notifications; those are enforced at the **producer** (or gateway), not on the internal
  `POST /notify` receiver, which trusts `x-dub-internal`.
- **`system.announcement`** forces the `in_app` channel on regardless of user preference (the sole
  preference-bypass; an admin broadcast). This is an ingest behaviour, not a separate endpoint.

---

## 9. Contract-change discipline

Additive changes stay in `v1` (a new `NOTIF_*` code, a new optional `NotifyRequest`/response
field, a new channel would be a **breaking** change since the 4-channel set is frozen — theme4).
Removing/renaming a field, changing a status, or adding a permission key to the frozen catalog
requires a version bump or a frozen-decision review (§_conventions 9). This doc owns only the
notification endpoint contract; the cross-cutting foundation is `_conventions.md` + `auth.md`.
