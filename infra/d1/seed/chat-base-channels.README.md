# chat base channels — production seed

Seeds the minimal set of public channels the DevHub チャット workspace ships with, so
the app opens onto real channels instead of an empty state.

## What it creates

| id | name | type / visibility | topic |
|----|------|-------------------|-------|
| `chan_base_general` | general | topic / public | 全体連絡・お知らせ・雑談OKの共通チャンネル |
| `chan_base_random` | random | topic / public | 雑談・趣味・自由な投稿はこちら |
| `chan_base_ops` | 運営連絡 | topic / public | 運営からの連絡・共有事項 |

"Workspace" is implicit — the chat schema has no workspace table. The single DevHub org
(`org_devhub`) is the workspace (the "DevHub" rail tile). Public channels need no
membership rows; every signed-in member sees them.

## Properties

- **Idempotent** — `INSERT OR IGNORE` on fixed ids; re-runs are no-ops.
- **Additive / non-destructive** — never overwrites an admin's later name/topic edits,
  never touches other rows.
- **Reversible** — rollback block at the bottom of the `.sql`.

## Run (production shared `dub-core` D1)

```
# 1. Backup the table first
wrangler d1 execute dub-core --remote --json \
  --command "SELECT * FROM chat_channels" > ~/DubVault/backups/chat_channels-$(date +%Y%m%d-%H%M%S).json

# 2. (optional) dry-run locally
wrangler d1 execute dub-core --local --file infra/d1/seed/chat-base-channels.sql

# 3. apply to production
wrangler d1 execute dub-core --remote --file infra/d1/seed/chat-base-channels.sql
```

Auth: `CLOUDFLARE_API_TOKEN=$(cat ~/DubVault/secrets/cf-token.txt)`,
account `b8f6ddbf8fa8cf4e421eae870bdb6dac`.

## Rollback

```
wrangler d1 execute dub-core --remote \
  --command "DELETE FROM chat_channels WHERE id IN ('chan_base_general','chan_base_random','chan_base_ops')"
```
