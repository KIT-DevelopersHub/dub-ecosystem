-- mail-gateway — team mailing lists (チームのメーリングリスト). Additive, forward-only.
-- Mirror of services/mail-gateway/db/0024_team_list.sql (kept byte-identical; infra is the
-- 正本 / runner, the service copy backs the in-memory test schema).
--
-- One row per list address. Membership is NOT stored here: it is the team's roster
-- (member_team_links) read from member-service when a mail arrives, so joining or leaving
-- a team needs no list maintenance.
--   address     lowercased full address (e.g. design@developershub.jp)
--   team_id     member_teams.id the list expands to
-- The Cloudflare Email Routing rule that hands the address to this Worker is found by its
-- name (`dub-list:<local>`) + address, so it cannot drift from a stored rule id.
-- Removal is a SOFT delete (deleted_at); the address can then be issued again.
-- Timestamps app-side.
CREATE TABLE IF NOT EXISTS mail_team_list (
  id          TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_team_list_address ON mail_team_list(address) WHERE deleted_at IS NULL;
