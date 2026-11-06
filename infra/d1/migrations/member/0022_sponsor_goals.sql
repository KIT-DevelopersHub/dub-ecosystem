-- スポンサーアプリの月間目標 (1 か月 1 行)。新規テーブルのみの additive。実績は保存せず営業進捗の日付から数える。
-- Mirrors the schema.ts const MEMBER_SPONSOR_GOALS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_sponsor_goals (
  org_id            TEXT NOT NULL,
  month             TEXT NOT NULL,
  contacted_target  INTEGER,
  proposed_target   INTEGER,
  agreed_target     INTEGER,
  amount_target     INTEGER,
  version           INTEGER NOT NULL,
  updated_by        TEXT NOT NULL,
  updated_by_name   TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, month)
);
