# ADR-0002: Realtime foundation — Durable Objects (ChatRoom), not a third-party realtime service

- Status: Accepted
- Date: 2026-08-10
- Deciders: DevHub (Dub) core
- Related: P0b theme 9-C ("RT=DO 本決定"), design 4-8 / theme11

## Context

Chat and presence need a realtime fan-out layer: many WebSocket clients per channel must
receive new messages, reactions/read-state, and presence updates with low latency. The
rest of the ecosystem runs on Cloudflare Workers with a single D1 (`dub-core`), Queues,
and Service Bindings. Two families of options exist:

- **Cloudflare Durable Objects (DO):** a per-key single-threaded stateful actor that can
  hold WebSocket connections and coordinate fan-out inside the same platform.
- **A managed realtime SaaS (e.g. Ably / Pusher):** an external pub/sub with client SDKs,
  billed per message/connection, and an extra vendor + secret to manage.

The chat service is split into a **conversation master** (HTTP: channels/threads/messages,
`chat_*` D1 tables, `chat.*` Queue publish) and a **realtime side**. The question is what
powers the realtime side.

## Decision

Adopt **Cloudflare Durable Objects** as the realtime foundation, implemented as a
**`ChatRoom` DO** owned by the chat service.

Confirmed by the current implementation (`services/chat-service/`):

- **One DO instance per channel** — addressed by `getByName(channelId)`
  (`wrangler.toml` `[[durable_objects.bindings]]` name `CHAT_ROOM`, `class_name = "ChatRoom"`,
  registered as an SQLite-backed class via `new_sqlite_classes = ["ChatRoom"]`).
- **WebSocket is gateway-bypassing / DO-direct.** Browser clients connect straight to the
  DO, not through the API gateway. Access is gated by a short-lived **HMAC ws-ticket**
  (`src/wsticket.ts`, signed with `WS_TICKET_SECRET`) plus an **Origin allow-list** enforced
  by the DO. The HTTP master mints the ticket after authz; the DO verifies it.
- **The DO fans out `ChatRealtimeEvent`** to connected sockets and tracks presence.
- **In P0 the DO holds no durable rows** — it is a WS coordinator only; the SQLite class is
  still registered so the migration can create it.
- **Co-hosting for P0:** the `ChatRoom` DO is co-hosted with the HTTP master Worker for now.
  Production may split it into a dedicated `chat-rt` Worker addressed by
  `CHAT_RT_DO_URL_BASE` via a cross-script binding — a deployment change, not a redesign.

## Consequences

- Positive: no external realtime vendor, secret, or per-message bill; realtime state lives
  on the same platform as D1/Queues, and the single-per-channel actor gives a natural
  ordering/coordination point for message and presence fan-out.
- Positive: security posture is self-contained (HMAC ticket + Origin allow-list), and the
  master↔realtime boundary is clean (RealtimePublisher stub in the master until wired).
- Negative: DO fan-out to very large rooms is bounded by a single instance's throughput; if
  a channel ever needs massive concurrent connections, sharding or a hub/spoke DO topology
  would be required. Acceptable for the expected DevHub scale.
- Negative: WebSocket hibernation, ticket rotation, and Origin-list maintenance are our
  responsibility (vs. offloaded to a SaaS).
- **(要確認)** DO durable storage stays empty in P0; if presence or catch-up history is later
  persisted in the DO's SQLite, that schema is a future decision.

## Alternatives considered

| Option | Why not |
|---|---|
| Ably / Pusher (managed realtime) | Adds an external vendor, secret, and per-message/connection cost; splits realtime state off-platform; client SDK lock-in. DO keeps everything inside Cloudflare with no extra bill. |
| Raw WebSockets on a stateless Worker | Workers are stateless — no place to hold connections or coordinate per-channel fan-out/presence without an external store. DO is the platform's answer to exactly this. |
| Polling the HTTP master | Higher latency and D1 read load; no presence. Not viable for chat UX. |
