# Architecture Decision Records (ADR)

Records of non-obvious architectural decisions for the DevHub (Dub) ecosystem, in
[MADR](https://adr.github.io/madr/)-style format (Context / Decision / Consequences /
Status, plus Alternatives). These record **decisions**, not implementation — they do not
change code. Points that could not be asserted against the current code are marked
`(要確認)`.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-email-outbound-provider-resend-first.md) | Outbound email provider — **Resend first**, SES for future/bulk | Accepted |
| [0002](0002-realtime-durable-objects-chatroom.md) | Realtime foundation — **Durable Objects (`ChatRoom`)**, not a realtime SaaS | Accepted |
| [0003](0003-event-payload-versioning-and-compatibility.md) | Event payload **versioning & compatibility** (numeric `version`, tolerant reader, idempotency by `id`) | Accepted |
| [0004](0004-auth-session-cookie-plus-trusted-gateway-header.md) | Auth — **session cookie** at the edge + **trusted gateway header** (`x-dub-user-id`) internally | Accepted |
| [0005](0005-single-d1-core-logical-namespace-partitioning.md) | **Single D1 (`dub-core`)** with 16 logical namespaces (prefix + lint enforced) | Accepted |
| [0006](0006-desktop-flutter-client.md) | Desktop client — **Flutter** (macOS + Windows) over the shared gateway | Proposed |
| [0007](0007-cross-scope-task-dependencies-within-team.md) | Task dependencies span **any WBS scope within a team**; **cross-team rejected** (backend门番 + fe4 picker, single reason constant) | Accepted |
| [0008](0008-cross-team-task-requests-not-dependencies.md) | Cross-team task links are **request → approval → cross-link** (送る・受け取る), never a dependency arrow | Accepted |
