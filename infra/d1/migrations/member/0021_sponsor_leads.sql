-- スポンサーアプリの営業進捗 (スプレッドシートの 1 行 = 1 社)。新規テーブルのみの additive。項目と選択肢は @dub/types sponsor が SoT。
-- 名刺とは外部キーを持たず、会社名の照合キー (sponsor.companyKey) で結び付ける。
-- Mirrors the schema.ts const MEMBER_SPONSOR_LEADS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_sponsor_leads (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  company_name      TEXT NOT NULL,
  industry          TEXT,
  owner             TEXT,
  contact_name      TEXT,
  contact_role      TEXT,
  contact_email     TEXT,
  source            TEXT,
  contact_type      TEXT,
  evidence          TEXT,
  priority          TEXT,
  plan              TEXT,
  status            TEXT NOT NULL,
  first_contact_on  TEXT,
  last_contact_on   TEXT,
  next_action       TEXT,
  next_action_on    TEXT,
  expected_amount   INTEGER,
  confidence        TEXT,
  budget_period     TEXT,
  decision_period   TEXT,
  note              TEXT,
  version           INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  created_by_name   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  archived_at       TEXT
);
CREATE INDEX idx_member_sponsor_leads_org ON member_sponsor_leads(org_id, updated_at) WHERE archived_at IS NULL;
