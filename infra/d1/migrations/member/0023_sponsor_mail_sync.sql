-- スポンサーアプリのメール連携。新規テーブルのみの additive (既存の表・行は変えない)。
-- Mirrors the schema.ts const MEMBER_SPONSOR_MAIL_SYNC_MIGRATION (schema-lockstep.test.ts).
-- member_sponsor_mail_links: 画面で営業先に紐付けたメールアドレス (1 アドレス = 1 社)。
CREATE TABLE member_sponsor_mail_links (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  lead_id           TEXT NOT NULL,
  address           TEXT NOT NULL,
  thread_id         TEXT,
  created_by        TEXT NOT NULL,
  created_by_name   TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_member_sponsor_mail_links_address ON member_sponsor_mail_links(org_id, address);
-- member_sponsor_lead_activity: メールからの自動更新の履歴 (どのメールで何が変わったか)。件名・本文は持たない。
CREATE TABLE member_sponsor_lead_activity (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  lead_id           TEXT NOT NULL,
  source            TEXT NOT NULL,
  direction         TEXT NOT NULL,
  mail_at           TEXT NOT NULL,
  counterpart       TEXT NOT NULL,
  matched_by        TEXT NOT NULL,
  mailbox           TEXT,
  changes_json      TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_member_sponsor_lead_activity_lead ON member_sponsor_lead_activity(lead_id, created_at);
