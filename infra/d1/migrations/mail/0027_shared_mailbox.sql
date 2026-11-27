-- mail-gateway — shared sending addresses (共用アドレスから送る). Additive, forward-only.
-- Mirror of infra/d1/migrations/mail/0027_shared_mailbox.sql (kept byte-identical; infra is the
-- 正本 / runner, the service copy backs the in-memory test schema).
--
-- mail_shared_mailbox: one row per shared address members may pick as the From in compose
-- (same shape as mail_team_list, 0024). Who may send as it is decided per send:
--   allow = 'all_members' every linked 運営メンバー (member-service, declined left out)
--   allow = 'team'        the members of team_id
--   display_name          the From name the recipient sees
--   signature             put at the end of the body when the address is picked in compose
-- The address must already reach this Worker through Email Routing (info@ does), or the
-- replies never come back. Removal is a SOFT delete (deleted_at). Timestamps app-side.
CREATE TABLE IF NOT EXISTS mail_shared_mailbox (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  signature     TEXT NOT NULL DEFAULT '',
  allow         TEXT NOT NULL CHECK (allow IN ('all_members', 'team')),
  team_id       TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_shared_mailbox_address ON mail_shared_mailbox(address) WHERE deleted_at IS NULL;

-- info@ open to 運営メンバー全員, as decided for 第1段. INSERT OR IGNORE: re-running is a no-op.
INSERT OR IGNORE INTO mail_shared_mailbox
  (id, address, display_name, signature, allow, team_id, created_by, created_at, updated_at, deleted_at)
VALUES
  ('mailshared_info', 'info@developershub.jp', '北陸ITカンファレンス 実行委員会',
   '--' || char(10) || '北陸ITカンファレンス 実行委員会' || char(10) || 'info@developershub.jp',
   'all_members', NULL, NULL, '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z', NULL);

-- The shared address a send went out as (NULL = an ordinary send). The sender is the row's
-- owner_user_id / requester as before; a reply to the shared address whose In-Reply-To /
-- References names this row is also delivered to that sender.
-- D1 has no "ADD COLUMN IF NOT EXISTS": run this file once. Before a re-run, check
-- `SELECT name FROM pragma_table_info('mail_send_log') WHERE name = 'shared_mailbox'` (and the
-- same for mail_scheduled); a "duplicate column name" error means it is already applied.
ALTER TABLE mail_send_log ADD COLUMN shared_mailbox TEXT;
-- The shared address a scheduled send was booked as; the drain checks the permission again.
ALTER TABLE mail_scheduled ADD COLUMN shared_mailbox TEXT;
