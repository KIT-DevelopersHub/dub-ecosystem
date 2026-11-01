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
| `history-C_CONF_PUBLIC.json` | `conversations.history` → `messages[]` | A thread root (`reply_count: 2`), a pinned+edited message with standard/custom/skin-tone reactions, a message with one downloadable + one free-plan-hidden file, the unmapped user's post, a bot_id-only post with a legacy attachment, a Slack bot user's post, a channel_join, and a reply whose root is outside the window. |
| `replies-C_CONF_PUBLIC-1717000000.000100.json` | `conversations.replies` → `messages[]` | The thread root + its 2 replies (root repeated, per Slack's actual API shape). |
| `history-C_CONF_CORE.json` | `conversations.history` → `messages[]` | One plain message, to exercise the private-channel path. |
| `members-<channel>.json` | `conversations.members` → `members[]` | Channel membership. |
| `bookmarks-C_CONF_PUBLIC.json` | `bookmarks.list` → `bookmarks[]` | 2 links + 1 folder (folders are skipped). |
| `identity-users.json` | `SELECT id, email FROM identity_users` export | 2 rows, matching 2 of the 4 Slack users. |

Applying the generated SQL twice must not duplicate anything (ids are derived from Slack
ids) — asserted in the test suite.
