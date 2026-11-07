-- スポンサーアプリのメール連携: メールからの自動更新の履歴 (どのメールで何が変わったか)。新規テーブルのみの additive。
-- 件名・本文は持たない (メールの持ち主以外のチーム全員に見えるため)。
-- Mirrors the schema.ts const MEMBER_SPONSOR_MAIL_SYNC_MIGRATION (schema-lockstep.test.ts).
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
