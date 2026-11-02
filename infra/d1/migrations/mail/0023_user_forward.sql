-- mail-gateway — per-user opt-in auto-forward to a personal address (Gmail 自動転送). Additive, forward-only.
-- Mirror of services/mail-gateway/db/0023_user_forward.sql (kept byte-identical; infra is the
-- 正本 / runner, the service copy backs the in-memory test schema).
--
-- One row per account (owner_user_id) that opted in. Nothing is forwarded without a row:
-- the feature is OFF for everyone until the user registers a target themselves.
--   target         lowercased personal address (e.g. someone@gmail.com); unique among live rows
--   cf_address_id  the Cloudflare Email Routing destination address CREATED by this
--                  registration. Cloudflare mails a verification link to `target`; clicking
--                  it is the user's proof of ownership AND what lets message.forward() reach it.
--   verified_at    stamped once that destination is seen verified (GET /mail/forward or the
--                  cron sweep). Forwarding requires enabled = 1 AND verified_at IS NOT NULL.
--   enabled        the user's switch (1 = on). Registering sets it on (intent); it only takes
--                  effect after verification.
--   last_*         outcome of the most recent forward attempt (shown in the settings UI).
--   register_*     per-day registration counter (each registration sends a verification mail).
-- Removal is a SOFT delete (deleted_at); re-registering revives the row. Timestamps app-side.
CREATE TABLE IF NOT EXISTS mail_user_forward (
  owner_user_id   TEXT PRIMARY KEY,
  target          TEXT NOT NULL,
  cf_address_id   TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,                    -- 0 | 1
  requested_at    TEXT NOT NULL,
  verified_at     TEXT,
  last_result     TEXT CHECK (last_result IS NULL OR last_result IN ('forwarded', 'failed')),
  last_error      TEXT,
  last_at         TEXT,
  register_day    TEXT,
  register_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_user_forward_target ON mail_user_forward(target) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_user_forward_pending ON mail_user_forward(verified_at, deleted_at);
