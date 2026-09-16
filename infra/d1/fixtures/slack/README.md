# Slack import fixtures (dry-run / pilot)

Offline stand-ins for the Slack Web API responses `scripts/slack-import.ts --fixture-dir`
reads instead of hitting the network. They let the whole pipeline (parse → map →
INSERT-SQL generation) be exercised end-to-end **before the real bot token / channel
list arrive** — see `infra/d1/test/slackImportRun.test.ts` and the pilot steps in
`docs/runbooks/07-slack-history-import.md`.

Two channels, mirroring a realistic 公開+プライベート カンファ運営 pair:

| File | Shape mirrors | Notes |
|---|---|---|
| `users.json` | `users.list` → `members[]` | 4 Slack users: 2 map to `identity-users.json` by email, 1 has no matching email (退職/ゲスト — exercises the unmapped-user path), 1 is a bot (`is_bot: true`, no email). |
| `channels.json` | `conversations.list` → `channels[]` | `C_CONF_PUBLIC` (public), `C_CONF_CORE` (private, `is_private: true`). |
| `history-C_CONF_PUBLIC.json` | `conversations.history` → `messages[]` | A thread root (`reply_count: 2`), a message with reactions, a message with a file attachment, and a message from the unmapped user. |
| `replies-C_CONF_PUBLIC-1717000000.000100.json` | `conversations.replies` → `messages[]` | The thread root + its 2 replies (root repeated, per Slack's actual API shape). |
| `history-C_CONF_CORE.json` | `conversations.history` → `messages[]` | One plain message, to exercise the private-channel path. |
| `identity-users.json` | `SELECT id, email FROM identity_users` export | 2 rows, matching 2 of the 4 Slack users. |

Re-running the importer against these same fixtures with a persisted ledger must be a
no-op (idempotency) — that is asserted directly in the test suite.
