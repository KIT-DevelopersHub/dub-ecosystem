# Dub Chat Service API Contract

Status: Component contract (v1). Read [`_conventions.md`](./_conventions.md) first for the
shared envelope, headers, error codes, pagination, IDs, and versioning; and
[`auth.md`](./auth.md) for authn/authz. This doc only adds what is **chat-specific**: the
channel / member / message resource shapes, the fourteen HTTP endpoints, the ws-ticket
handshake, the DO-direct WebSocket protocol, the DM-dedup rule, logical-delete redaction,
and the events / realtime / audit records the service emits.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Wire DTOs + request/response types, wire enums | `services/chat-service/src/types.ts` |
| HTTP routes + guards | `services/chat-service/src/app.ts` |
| Business logic + service error codes | `services/chat-service/src/service.ts` |
| DTO mapping, cursor codec, dm_key, mentions, redaction | `services/chat-service/src/domain.ts` |
| ws-ticket sign / verify (HMAC) | `services/chat-service/src/wsticket.ts` |
| ChatRoom Durable Object (WS pub/sub) | `services/chat-service/src/chat-room-do.ts` |
| Frozen RT event + ws-ticket wire types | `packages/types/src/chat.ts` |
| Emitted domain events | `packages/events/src/payloads.ts` (`chat.*`) |
| Gateway mount (`/api/v1/chat`) | `services/api-gateway/src/routes.ts` |

If code and this doc disagree, the code wins and this doc must be corrected.

---

## 1. Topology

chat-service is an **internal** service (no public hostname) fronted by two callers, plus a
**Durable Object** the browser talks to directly for realtime.

| Caller | External path | Internal path | Auth carried in |
|---|---|---|---|
| `api-gateway` (web, FE6) | `/api/v1/chat/…` | `/…` (prefix `/api/v1/chat` stripped) | `x-dub-user-id` (trusted; gateway verified the session) |
| `mo3-mobile-bff` (native) | `/m/v1/chat/…` | `/…` | `x-dub-user-id` (trusted; BFF verified the bearer) |
| `notification` (service) | — | `/internal/system-messages` | `x-dub-internal: 1` |

The service **trusts** `x-dub-user-id` and does not re-verify tokens (`trustedHeader` mode).
Every user-facing group (`/channels*`, `/messages*`, `/unread`) runs `requireAuth()`; a
request with no trusted user header is rejected `401 UNAUTHENTICATED` before any handler
runs. All paths below are written in their **external** `/api/v1/chat` form; drop the
`/api/v1/chat` prefix for the internal / service-binding form.

**Realtime is gateway-bypassing.** The gateway mount forwards HTTP only; the WebSocket
upgrade never traverses the gateway. Clients open the socket **directly** against the
`doUrl` returned by `GET /channels/:id/ws-ticket` (see §7). The ChatRoom DO — one instance
per channel — is the sole WS gate: it verifies the ticket, enforces Origin, and fans out
`ChatRealtimeEvent`s.

**Internal system-messages.** `POST /internal/system-messages` is reached only over the
`SVC_CHAT` service binding by the notification service. It is not listed in the gateway's
`internalOnlyPaths`, but the handler self-defends: any request missing `x-dub-internal: 1`
gets `404 NOT_FOUND` (the route is hidden, not `403`'d).

---

## 2. Resource shapes

### 2.1 Channel

`Channel` — the exact `200` / `201` body for single-channel reads and creates.

```json
{
  "id": "chan_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "type": "topic",
  "visibility": "public",
  "name": "landing-page",
  "topic": "Everything about the marketing site",
  "eventId": null,
  "createdBy": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "archivedAt": null,
  "version": 1,
  "createdAt": "2026-08-10T05:00:00Z",
  "updatedAt": "2026-08-10T05:00:00Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string (`chan_<ULID>`) | Channel id |
| `type` | `"event" \| "topic" \| "dm"` | Channel kind. `event` binds to an event; `dm` is de-duplicated per participant set |
| `visibility` | `"public" \| "private"` | `private` channels are hidden (`404`) from non-members |
| `name` | string | Display name (non-empty) |
| `topic` | string \| null | Optional description |
| `eventId` | string (`evt_<ULID>`) \| null | Non-null only for `type = "event"` |
| `createdBy` | string (`user_<ULID>`) | Creator |
| `archivedAt` | ISODateTime \| null | Non-null once archived; archived channels reject writes with `409 CHAT_CHANNEL_ARCHIVED` |
| `version` | number | Optimistic-lock version (`Versioned`) — send it on `PATCH` |
| `createdAt` / `updatedAt` | ISODateTime | Timestamps |

`dmKey` (the DM-dedup hash) is **internal** and never crosses the wire.

### 2.2 ChannelMember

`ChannelMember`:

```json
{
  "channelId": "chan_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "role": "admin",
  "joinedAt": "2026-08-10T05:00:00Z"
}
```

`role` is `"admin" | "member"`. The channel creator is seeded as `admin`; added members
default to `member`. Channel-admin (or the `chat:moderate` permission) is required to rename
/ archive a channel, add members, remove other members, or delete another user's message.

### 2.3 Message

`Message` — the `200` / `201` body for single-message reads, posts, and edits.

```json
{
  "id": "msg_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "channelId": "chan_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "threadRootId": null,
  "authorId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YB",
  "kind": "user",
  "body": "Shipping the hero section today <@user_01J9Z...>",
  "attachmentFileIds": ["file_01J9Z8Q0X7M3K2P5R8T1V4W6YC"],
  "reactions": { "👍": ["user_01J9Z...", "user_01J9Z...A"] },
  "version": 1,
  "editedAt": null,
  "deletedAt": null,
  "createdAt": "2026-08-10T05:00:00Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string (`msg_<ULID>`) | Message id |
| `channelId` | string (`chan_<ULID>`) | Owning channel |
| `threadRootId` | string (`msg_<ULID>`) \| null | Non-null = a threaded reply; the root must live in the same channel |
| `authorId` | string (`user_<ULID>`) \| null | `null` only for `kind = "system"` posts |
| `kind` | `"user" \| "system"` | `system` = a notification-delivered post |
| `body` | string (1..16000 chars) | Message text. Mentions use the `<@userId>` form. Once deleted, redacted to `"[deleted]"` |
| `attachmentFileIds` | string[] (`file_<ULID>`) | file-meta ids; returned empty once the message is deleted |
| `reactions` | `Record<emoji, userId[]>` | Emoji -> reactors. Empty object when none |
| `version` | number | Optimistic-lock version — send it on edit |
| `editedAt` | ISODateTime \| null | Non-null once edited |
| `deletedAt` | ISODateTime \| null | Non-null once logically deleted (row is kept; body + attachments redacted) |
| `createdAt` | ISODateTime | Post time |

**Logical delete:** delete is a soft-delete. A deleted message still appears in listings with
`deletedAt` set, `body = "[deleted]"`, and `attachmentFileIds = []`.

---

## 3. Endpoint map

All external paths are under the gateway mount `/api/v1/chat` (native: `/m/v1/chat`).

| Method & path (external) | Auth / permission | Purpose |
|---|---|---|
| `GET /api/v1/chat/channels` | session | List the caller's channels (paginated) |
| `POST /api/v1/chat/channels` | session + `chat:create` | Create a channel (DM is idempotent per member set) |
| `GET /api/v1/chat/channels/:id` | session | Read a channel + the caller's membership |
| `PATCH /api/v1/chat/channels/:id` | session + channel-admin | Rename / retopic / archive (version-checked) |
| `POST /api/v1/chat/channels/:id/members` | session + channel-admin | Add a member (idempotent) |
| `DELETE /api/v1/chat/channels/:id/members/:userId` | session + admin or self | Remove a member (idempotent) |
| `POST /api/v1/chat/channels/:id/read` | session + member | Set the caller's read cursor; returns unread count |
| `GET /api/v1/chat/channels/:id/ws-ticket` | session + member | Mint a short-lived WS ticket + `doUrl` |
| `GET /api/v1/chat/messages?channelId=…` | session + member | List messages (paginated / thread / gap-fill) |
| `POST /api/v1/chat/messages` | session + member | Post a message |
| `PATCH /api/v1/chat/messages/:id` | session + author | Edit own message (version-checked) |
| `DELETE /api/v1/chat/messages/:id` | session + author or admin | Soft-delete a message (idempotent) |
| `POST /api/v1/chat/messages/:id/reactions` | session + member | Toggle the caller's reaction |
| `GET /api/v1/chat/unread` | session | Per-channel unread summary for the caller |
| `POST /internal/system-messages` | `x-dub-internal: 1` (notification only) | Deliver a system post to a channel or a user's DM |
| `GET /health` | none | Liveness (`{ "status": "ok", "service": "chat-service" }`) |

Only `POST /channels` needs a catalog permission (`chat:create`); every other user-facing
endpoint gates on **channel membership / role**, not a global permission. `chat:moderate`
(⚠ dangerous) lets a non-member act as a channel admin (moderation).

---

## 4. Channels

### `GET /channels`

Lists channels the caller is a member of. Archived channels are excluded. Cursor-paginated
(§_conventions 5).

Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `cursor` | string (opaque) | — | Echo the previous `nextCursor` |
| `limit` | integer | 50 | 1..200; out of range -> `VALIDATION_FAILED` |
| `eventId` | string (`evt_<ULID>`) | — | Filter to one event's channels |

Response `200` (`Paginated<Channel>`):

```json
{
  "items": [
    { "id": "chan_01J9Z...", "type": "topic", "visibility": "public", "name": "landing-page", "topic": null, "eventId": null, "createdBy": "user_01J9Z...", "archivedAt": null, "version": 1, "createdAt": "2026-08-10T05:00:00Z", "updatedAt": "2026-08-10T05:00:00Z" }
  ],
  "nextCursor": "eyJpZCI6ImNoYW5fMDFKOVoifQ"
}
```

### `POST /channels`

Requires `chat:create`. Request (`CreateChannelRequest`):

```json
{
  "type": "topic",
  "visibility": "public",
  "name": "landing-page",
  "topic": "Marketing site work",
  "memberIds": ["user_01J9Z...", "user_01J9Z...A"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"event" \| "topic" \| "dm"` | yes | Invalid value -> `VALIDATION_FAILED` (`{ "field": "type", "reason": "invalid" }`) |
| `visibility` | `"public" \| "private"` | yes | Invalid value -> `VALIDATION_FAILED` |
| `name` | string | yes | Non-empty |
| `topic` | string | no | — |
| `eventId` | string (`evt_<ULID>`) | required iff `type = "event"` | Missing -> `VALIDATION_FAILED`; unknown event -> `404 NOT_FOUND` (checked against event-service) |
| `memberIds` | string[] | no | Initial members; the caller is always added as `admin` |

Response `201` — the created `Channel`. The caller becomes an `admin` member; each listed
`memberIds` becomes a `member`.

**DM dedup:** for `type = "dm"`, the member set (caller + `memberIds`, de-duplicated) is
hashed to a stable key. If a DM with the same participant set already exists, the existing
channel is returned (still `201`) — creating a DM is idempotent.

### `GET /channels/:id`

Response `200` (`GetChannelResponse`):

```json
{
  "channel": { "id": "chan_01J9Z...", "type": "topic", "visibility": "public", "name": "landing-page", "topic": null, "eventId": null, "createdBy": "user_01J9Z...", "archivedAt": null, "version": 1, "createdAt": "2026-08-10T05:00:00Z", "updatedAt": "2026-08-10T05:00:00Z" },
  "membership": { "channelId": "chan_01J9Z...", "userId": "user_01J9Z...", "role": "member", "joinedAt": "2026-08-10T05:00:00Z" }
}
```

- `membership` is `null` when the caller is a **non-member viewing a public channel**.
- A **private** channel the caller is not a member of returns `404 NOT_FOUND` (hidden, not
  `403`). A missing channel is also `404`.

### `PATCH /channels/:id`

Requires channel-admin (or `chat:moderate`). Request (`UpdateChannelRequest`, `Versioned`):

```json
{ "version": 1, "name": "landing-page-v2", "topic": "Rework", "archived": false }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | number | yes | The version last read; missing -> `VALIDATION_FAILED` (`{ "field": "version", "reason": "required" }`) |
| `name` | string | no | Non-empty when present |
| `topic` | string \| null | no | `null` clears the topic |
| `archived` | boolean | no | `true` archives, `false` un-archives (idempotent per state) |

Response `200` — the updated `Channel` (its `version` incremented). A no-op body (nothing
actually changed) returns the channel unchanged. Stale `version` -> `409 CHAT_VERSION_CONFLICT`.

### `POST /channels/:id/members`

Requires channel-admin (or `chat:moderate`). Request (`AddMemberRequest`):

```json
{ "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YA", "role": "member" }
```

`role` defaults to `"member"`. Response `204 No Content`. Idempotent — re-adding an existing
member is a no-op `204`. Adding to an archived channel -> `409 CHAT_CHANNEL_ARCHIVED`.
Emits `chat.member.added` (domain) + a `member.added` realtime event.

### `DELETE /channels/:id/members/:userId`

The caller may remove **themselves** (leave) or, as channel-admin / `chat:moderate`, remove
another member. Response `204`. Idempotent — removing a non-member is a no-op `204`. Neither
self nor admin -> `403 FORBIDDEN`. Emits `chat.member.removed` + a `member.removed` realtime
event.

### `POST /channels/:id/read`

Caller must be a member. Sets the caller's read cursor for the channel; the path `:id` is the
authoritative channel scope. Request (`ReadStateUpdateRequest`):

```json
{ "channelId": "chan_01J9Z...", "lastReadMessageId": "msg_01J9Z8Q0X7M3K2P5R8T1V4W6Y9" }
```

Response `200` (`UnreadSummary`) — the recomputed unread count:

```json
{ "channelId": "chan_01J9Z...", "unreadCount": 0, "lastReadMessageId": "msg_01J9Z..." }
```

---

## 5. Messages

### `GET /messages`

Lists messages in one channel; the caller must be a member. Query params:

| Param | Type | Required | Notes |
|---|---|---|---|
| `channelId` | string (`chan_<ULID>`) | yes | Missing -> `VALIDATION_FAILED` (`{ "field": "channelId", "reason": "required" }`) |
| `cursor` | string (opaque) | no | Newest-first keyset page; mutually exclusive with `afterMessageId` |
| `limit` | integer | no (default 50) | 1..200 |
| `threadRootId` | string (`msg_<ULID>`) | no | Restrict to one thread |
| `afterMessageId` | string (`msg_<ULID>`) | no | Ascending gap-fill (catch-up after reconnect); exclusive with `cursor` |

`cursor` + `afterMessageId` together -> `VALIDATION_FAILED`
(`{ "field": "cursor", "reason": "exclusive_with_afterMessageId" }`). A malformed `cursor`
-> `VALIDATION_FAILED` (`{ "field": "cursor", "reason": "invalid" }`), never a silent full
scan.

Response `200` (`Paginated<Message>`). The default (cursor) mode is **newest-first** and
carries a `nextCursor`; the `afterMessageId` gap-fill mode is **ascending** and always
returns `nextCursor: null` (the client advances `afterMessageId` itself).

```json
{
  "items": [
    { "id": "msg_01J9Z...", "channelId": "chan_01J9Z...", "threadRootId": null, "authorId": "user_01J9Z...", "kind": "user", "body": "hi", "attachmentFileIds": [], "reactions": {}, "version": 1, "editedAt": null, "deletedAt": null, "createdAt": "2026-08-10T05:00:00Z" }
  ],
  "nextCursor": "eyJpZCI6Im1zZ18wMUo5WiJ9"
}
```

### `POST /messages`

Caller must be a member; the channel must not be archived. Request (`PostMessageRequest`):

```json
{
  "channelId": "chan_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "body": "Shipping the hero <@user_01J9Z...>",
  "threadRootId": "msg_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "attachmentFileIds": ["file_01J9Z8Q0X7M3K2P5R8T1V4W6YC"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `channelId` | string | yes | Non-member -> `403`; private + non-member -> `404`; archived -> `409 CHAT_CHANNEL_ARCHIVED` |
| `body` | string | yes | 1..16000 chars. Empty -> `VALIDATION_FAILED` (`required`); over cap -> (`too_long`) |
| `threadRootId` | string | no | Must be a message in the **same** channel, else `VALIDATION_FAILED` (`{ "field": "threadRootId", "reason": "not_in_channel" }`) |
| `attachmentFileIds` | string[] | no | Registered as message links in file-meta (best-effort) |

Response `201` — the created `Message`. Post-commit, emits `chat.message.created` (domain)
and a `message.created` realtime event fanned out to the channel's WS subscribers. Mentions
(`<@userId>`) are extracted server-side for notification fan-out.

### `PATCH /messages/:id`

Only the **author** may edit; the channel must not be archived. Request:

```json
{ "version": 1, "body": "Shipping the hero section today" }
```

- `version` required (missing -> `VALIDATION_FAILED`); stale -> `409 CHAT_VERSION_CONFLICT`.
- `body` re-validated (1..16000).
- Editing a non-author message -> `403 FORBIDDEN`; a missing or already-deleted message -> `404`.

Response `200` — the updated `Message` (`editedAt` set, `version` incremented). No domain /
realtime event is emitted for edits (not in the frozen catalog) — audit only.

### `DELETE /messages/:id`

The **author** or a channel-admin / `chat:moderate` may delete. Soft-delete. Response `204`.
Idempotent — deleting an already-deleted message is a no-op `204`. Neither author nor admin
-> `403`. Emits `chat.message.deleted` + a `message.deleted` realtime event. The redacted
body / empty attachments become visible on the next read (§2.3).

### `POST /messages/:id/reactions`

Toggle the caller's reaction (add if absent, remove if present). Caller must be a member.
Request (`ReactionToggleRequest`):

```json
{ "emoji": "👍" }
```

Empty emoji -> `VALIDATION_FAILED` (`required`). A missing / deleted message -> `404`.
Response `200` (`ReactionToggleResponse`) — the message's full reaction map after the toggle:

```json
{ "messageId": "msg_01J9Z...", "reactions": { "👍": ["user_01J9Z...", "user_01J9Z...A"] } }
```

---

## 6. Unread

### `GET /unread`

Caller-scoped — there is no `userId` param; the summary is always for the authenticated
caller across every channel they are a member of. Response `200` (`UnreadResponse`):

```json
{
  "items": [
    { "channelId": "chan_01J9Z...", "unreadCount": 3, "lastReadMessageId": "msg_01J9Z..." },
    { "channelId": "chan_01J9Z...A", "unreadCount": 0, "lastReadMessageId": null }
  ]
}
```

`lastReadMessageId` is `null` when the caller has never read the channel (all messages count
as unread).

---

## 7. Realtime — ws-ticket + DO-direct WebSocket

Realtime is a **two-step** flow: mint a ticket over HTTP (through the gateway), then open the
WebSocket **directly** against the Durable Object (bypassing the gateway).

### 7.1 `GET /channels/:id/ws-ticket`

Caller must be a member. Response `200` (`chat.WsTicketResponse`):

```json
{
  "ticket": "eyJjaGFubmVsSWQiOiJjaGFuXzAxSjlaIn0.QmFzZTY0dXJsSG1hY1NpZw",
  "doUrl": "https://chat-rt.developershub.jp/ws/chan_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "expiresAt": "2026-08-10T05:01:00Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `ticket` | string | Short-lived (**60 s TTL**) HMAC-signed token: `base64url(claims).base64url(hmac)`. Opaque to the client — do not parse |
| `doUrl` | string (absolute) | The ChatRoom DO WebSocket URL for this channel (`.../ws/:channelId`) |
| `expiresAt` | ISODateTime | Ticket expiry (issue time + 60 s) |

### 7.2 Opening the socket

Connect a WebSocket to `doUrl` with the ticket as a query param:

```
wss://chat-rt.developershub.jp/ws/chan_01J9Z8Q0X7M3K2P5R8T1V4W6Y9?ticket=<ticket>
```

The DO is the sole gate and enforces, in order:

| Failure | Status | Code (JSON body `{ "error": { "code } }`) |
|---|---|---|
| Path has no channel id | 400 | `CHAT_WS_MISSING_CHANNEL` |
| `Upgrade: websocket` header absent | 426 | `CHAT_WS_UPGRADE_REQUIRED` |
| Browser `Origin` not allow-listed | 403 | `CHAT_WS_ORIGIN_FORBIDDEN` |
| `ticket` query param absent | 401 | `CHAT_WS_TICKET_MISSING` |
| Ticket signature invalid / expired | 401 | `CHAT_WS_TICKET_INVALID` |
| Ticket's channel != path channel | 403 | `CHAT_WS_TICKET_CHANNEL_MISMATCH` |

Native / mobile clients send **no** `Origin` and skip the Origin check; browser clients must
match the server allow-list (default `https://app.developershub.jp`). On success the DO
returns `101 Switching Protocols`.

### 7.3 WS message protocol

The socket is **read-mostly**: clients receive events, they do **not** post over WS (posting /
editing goes through the HTTP endpoints above).

- **Server -> client:** each frame is a JSON `chat.ChatRealtimeEvent` (§8.2).
- **Client -> server:** the only accepted frame is the literal string `"ping"`, answered with
  `"pong"` (liveness / stale-link detection). Any other frame is ignored.

The connection uses the Hibernation API server-side; clients should reconnect on close and
gap-fill missed messages via `GET /messages?afterMessageId=<last-seen>`.

---

## 8. Events, realtime, audit

### 8.1 Domain events (`@dub/events`, post-commit)

Published **after** the DB write (a failed write never emits). `actorId` is the caller's
`userId` (or `null` for system posts).

| Event | Payload | Emitted by |
|---|---|---|
| `chat.channel.created` | `{ channelId, name }` | `POST /channels` |
| `chat.member.added` | `{ channelId, userId, change: "added" }` | `POST /channels` (per added member), `POST /channels/:id/members` |
| `chat.member.removed` | `{ channelId, userId, change: "removed" }` | `DELETE /channels/:id/members/:userId` |
| `chat.message.created` | `{ channelId, messageId, authorId }` | `POST /messages` |
| `chat.message.deleted` | `{ channelId, messageId }` | `DELETE /messages/:id` |

Edits and reactions emit **no** domain event (not in the frozen catalog). System posts
(§9) emit **no** `chat.message.created` (the payload requires a non-null `authorId`, and the
notification caller already knows).

### 8.2 Realtime events (`chat.ChatRealtimeEvent`, DO fan-out)

The frozen WS wire contract. One of four variants, fanned out to every socket in the channel:

```json
{ "kind": "message.created", "channelId": "chan_01J9Z...", "messageId": "msg_01J9Z...", "authorId": "user_01J9Z...", "body": "hi", "at": "2026-08-10T05:00:00Z" }
```

| `kind` | Extra fields | Trigger |
|---|---|---|
| `message.created` | `messageId`, `authorId`, `body`, `at` | `POST /messages` |
| `message.deleted` | `messageId`, `at` | `DELETE /messages/:id` |
| `member.added` | `userId`, `at` | member added |
| `member.removed` | `userId`, `at` | member removed |

There is no realtime variant for edits, reactions, or system posts.

### 8.3 Audit records

Recorded via the audit sink: `chat.channel.created`, `chat.channel.archive`,
`chat.member.add`, `chat.member.remove`, `chat.message.update`, `chat.message.delete`,
`chat.system.post`. `actorId` is the `userId` (or `null` for system posts).

---

## 9. Internal — system messages

### `POST /internal/system-messages` (notification only)

Reached over the `SVC_CHAT` service binding by the notification service; requires
`x-dub-internal: 1` (else `404`). Delivers a `kind = "system"` post (author `null`).
Request (`PostSystemMessageRequest`) — supply **exactly one** of `channelId` / `targetUserId`:

```json
{ "targetUserId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6YA", "body": "Your deploy finished", "meta": { "deployId": "dep_01J9Z..." } }
```

| Field | Type | Notes |
|---|---|---|
| `channelId` | string (`chan_<ULID>`) | Post into an existing channel; archived -> `409 CHAT_CHANNEL_ARCHIVED`; missing -> `404` |
| `targetUserId` | string (`user_<ULID>`) | Resolve (or create) the user's system DM channel by `dm_key` (idempotent) |
| `body` | string | Required, 1..16000 |
| `meta` | object | Optional; recorded on the audit record |

Supplying both or neither of `channelId` / `targetUserId` -> `VALIDATION_FAILED`
(`{ "field": "channelId|targetUserId", "reason": "exactly_one_required" }`).

Response `201` — the created system `Message` (`authorId: null`, `kind: "system"`). No domain
or realtime event is emitted (§8.1); an audit record `chat.system.post` is written.

---

## 10. Chat error codes (quick reference)

Common codes (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`RATE_LIMITED`, …) behave per [`_conventions.md`](./_conventions.md) §3. Chat adds:

| Code | HTTP | Meaning / when |
|---|---|---|
| `CHAT_VERSION_CONFLICT` | 409 | Optimistic-lock mismatch on `PATCH /channels/:id` or `PATCH /messages/:id` (stale `version`) |
| `CHAT_CHANNEL_ARCHIVED` | 409 | Write attempted against an archived channel (post, add member, system post) |
| `CHAT_WS_MISSING_CHANNEL` | 400 | WS upgrade URL carried no channel id (DO) |
| `CHAT_WS_UPGRADE_REQUIRED` | 426 | WS endpoint hit without the `Upgrade: websocket` header (DO) |
| `CHAT_WS_ORIGIN_FORBIDDEN` | 403 | Browser `Origin` not on the DO allow-list |
| `CHAT_WS_TICKET_MISSING` | 401 | No `ticket` query param on the WS connect |
| `CHAT_WS_TICKET_INVALID` | 401 | Ticket signature invalid or expired |
| `CHAT_WS_TICKET_CHANNEL_MISMATCH` | 403 | Ticket's channel does not match the connect path |

Client guidance:
- **`404` on a channel read** may mean "hidden private channel", not just "missing" — do not
  distinguish the two on the client.
- **`409 CHAT_VERSION_CONFLICT`** -> re-read the resource, re-apply the edit on the fresh
  `version`, retry.
- **WS `4xx`** (except an expired ticket) is non-retryable as-is; on `CHAT_WS_TICKET_INVALID`
  from expiry, mint a fresh ticket via `GET /channels/:id/ws-ticket` and reconnect.
- Never branch on error `message` text (5xx is redacted); branch on `code` + HTTP status.
