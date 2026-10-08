// THE entry-layer authorization surface of chat-service. Every endpoint app.ts serves is
// listed here with the permission keys its caller must hold; `policyGate` (mounted first in
// app.ts) enforces it and nothing else in this service checks a permission KEY. A route added
// to app.ts without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// ── WHAT THIS TABLE DOES *NOT* DECIDE (read this before editing anything below) ──
//
// chat is the service where the two-layer split (@dub/policy-gate gate.ts, "RESOURCE SCOPE IS
// PART OF THAT") carries the most weight, because almost every route is about ONE channel and
// channels have their own visibility:
//
//   layer 1 — this table: does the caller hold the チャット key AT ALL (type level)?
//   layer 2 — ChatService: does it apply to THIS channel/message (instance level)?
//             `loadReadable` (private + non-member -> 404, existence hidden),
//             `ensureCanWrite` (public auto-join, private -> 403),
//             `isChannelAdmin` (channel admin role OR `chat:moderate`),
//             author-only edit, author-or-moderator delete, and the caller-scoped
//             read-state / unread / search queries.
//
// Layer 2 is NOT redundant with this table and must never be removed in favour of it. Every
// read rule below is `appLevel("chat", "view")`, which an ordinary member holds — so if the
// handler checks went away, "チャット = 閲覧" would mean "may read every PRIVATE channel in
// the org". The table deliberately says nothing about channel membership: membership is a row
// in `chat_channel_members`, i.e. request data, and the gate takes none.
//
// So the rules here are coarse ON PURPOSE (basically read vs write, plus two 詳細 keys), and
// test/policy-table.test.ts carries a "visibility regression" block that asserts a caller who
// holds `app:chat:view` but is not a member still gets 404 from every channel-scoped read.
import { definePolicyTable, appLevel, PUBLIC, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Liveness. PUBLIC, and unusually so for this repo (elsewhere a health probe is INTERNAL):
  // chat-service has its workers.dev subdomain ENABLED, because realtime is DO-direct
  // (browsers open wss://<worker>/ws/:id straight at the ChatRoom DO, bypassing the gateway).
  // index.ts therefore 404s every public-host request EXCEPT /health and /ws/*, so /health is
  // genuinely reachable from the open internet by design and the rule says so. It returns a
  // fixed `{ status, service }` literal — no request data, no user, nothing to leak.
  "GET /health": PUBLIC,

  // notification -> chat system posts (DM / channel notices) over the SVC_CHAT binding.
  // Replaces the hand-rolled `if (x-dub-internal !== MARKER) 404` that used to open this
  // handler: same guarantee (api-gateway strips every inbound x-dub-*, so the marker cannot
  // be forged from outside), but now VISIBLE in the table instead of hiding in the handler.
  // The refusal is the gate's 403 `internal_only` rather than the old 404 — the gateway's own
  // internalOnlyPaths still answers 404 at the edge, which is where the hiding belongs.
  "POST /internal/system-messages": INTERNAL,

  // ---- reads: チャット = 閲覧 (`app:chat:view`) ----
  // Each of these is additionally narrowed to the caller's readable channels IN THE HANDLER
  // (loadReadable / userId-scoped queries). See the header: the key alone is not permission to
  // read a private channel.
  "GET /chat/unfurl": appLevel("chat", "view"),
  "GET /chat/channels": appLevel("chat", "view"),
  "GET /chat/channels/:id": appLevel("chat", "view"),
  "GET /chat/channels/:id/members": appLevel("chat", "view"),
  "GET /chat/channels/:id/pins": appLevel("chat", "view"),
  "GET /chat/channels/:id/ws-ticket": appLevel("chat", "view"),
  "GET /chat/search": appLevel("chat", "view"),
  "GET /chat/messages": appLevel("chat", "view"),
  "GET /chat/unread": appLevel("chat", "view"),
  "GET /chat/settings/deletion-policy": appLevel("chat", "view"),

  // Marking a channel read writes a row, but only the CALLER's own read state (the path id is
  // authoritative and the user id comes from the session — the client cannot name a subject),
  // and it is gated by `loadReadable` like any other read. It belongs with 閲覧: a 閲覧-only
  // role must be able to clear its own unread badge.
  "POST /chat/channels/:id/read": appLevel("chat", "view"),

  // ---- writes: チャット = 編集 (`app:chat:view` + `app:chat:edit`) ----
  // Instance-level authority still comes from the handler: ensureCanWrite for posting /
  // reacting / pinning, isChannelAdmin for channel settings and membership, author-only for
  // edit, author-or-moderator for delete.
  "POST /chat/channels/:id/members": appLevel("chat", "edit"),
  "DELETE /chat/channels/:id/members/:userId": appLevel("chat", "edit"),
  "PATCH /chat/channels/:id": appLevel("chat", "edit"),
  "POST /chat/channels/:id/pins": appLevel("chat", "edit"),
  "POST /chat/messages": appLevel("chat", "edit"),
  "PATCH /chat/messages/:id": appLevel("chat", "edit"),
  "DELETE /chat/messages/:id": appLevel("chat", "edit"),
  "POST /chat/messages/:id/reactions": appLevel("chat", "edit"),

  // ---- writes needing a 詳細 key on top of 編集 ----
  // `chat:create` — creating a channel is the one write that is not scoped to an existing
  // channel, so there is no handler-side instance check to pair with: this rule is the WHOLE
  // decision for it.
  "POST /chat/channels": appLevel("chat", "edit", "chat:create"),
  // `chat:moderate` (dangerous key) — the org-wide delete policy decides whether anyone's
  // message is erased physically or tombstoned, so it is admin/maintainer territory, not
  // ordinary 編集.
  "PATCH /chat/settings/deletion-policy": appLevel("chat", "edit", "chat:moderate"),
});

// NOT in this table, deliberately — both are outside the HTTP app entirely:
//   GET /ws/:channelId   served by index.ts straight off the ChatRoom DO (gateway-bypassing),
//                        which verifies Origin + the HMAC ws-ticket itself. Read permission
//                        was already checked when GET /chat/channels/:id/ws-ticket minted the
//                        ticket (that route IS in the table, and loadReadable gates it).
//   ChatRoom.publish()   a DO RPC reachable only over the CHAT_ROOM binding; it has no HTTP
//                        entry point for a gate to sit in front of.
