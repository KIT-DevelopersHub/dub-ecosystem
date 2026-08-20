-- Chat base data — the minimal set of public channels the DevHub workspace ships
-- with, so チャット opens onto real channels instead of an empty state. This is
-- BASE data (what 運営 actually uses), not demo/fixture data.
--
-- "Workspace" is implicit: the chat schema has no workspace table — the single
-- DevHub org (DUB_DEFAULT_ORG_ID = org_devhub) IS the workspace, shown as the
-- "DevHub" rail tile in fe6-chat. So base data = a few public `topic` channels.
--
-- Public channels (visibility='public') are visible to every signed-in member with
-- no membership row required (chat-service d1-repo.listChannelsForUser:
-- `visibility = 'public' OR EXISTS(member row)`), so no chat_channel_members seed
-- is needed here.
--
-- Idempotent + additive + non-destructive: INSERT OR IGNORE on fixed ids — re-runs
-- are no-ops and it never overwrites a name/topic an admin later edits. Reversible:
-- see the rollback block at the bottom.
--
-- HOW TO RUN (production shared dub-core D1):
--   Backup first (see chat-base-channels.README.md), then:
--   wrangler d1 execute dub-core --file infra/d1/seed/chat-base-channels.sql --remote
--   Dry-run locally:
--   wrangler d1 execute dub-core --file infra/d1/seed/chat-base-channels.sql --local

INSERT OR IGNORE INTO chat_channels
  (id, type, visibility, name, topic, event_id, dm_key, created_by, archived_at, version, created_at, updated_at)
VALUES
  ('chan_base_general', 'topic', 'public', 'general', '全体連絡・お知らせ・雑談OKの共通チャンネル', NULL, NULL, 'system-seed', NULL, 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
  ('chan_base_random',  'topic', 'public', 'random',  '雑談・趣味・自由な投稿はこちら', NULL, NULL, 'system-seed', NULL, 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
  ('chan_base_ops',     'topic', 'public', '運営連絡', '運営からの連絡・共有事項', NULL, NULL, 'system-seed', NULL, 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');

-- ROLLBACK (removes only these base rows; nothing else is touched):
--   DELETE FROM chat_channels WHERE id IN ('chan_base_general','chan_base_random','chan_base_ops');
