-- 目標管理: チームの 1 か月の目標と KPI (1 チーム 1 か月 1 行)。新規テーブルのみの additive。
-- KPI は単体で検索しないので JSON で持つ。実績は保存せず各アプリのデータから数える。
-- Mirrors the schema.ts const MEMBER_GOALS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_goals (
  org_id           TEXT NOT NULL,
  team_id          TEXT NOT NULL,
  month            TEXT NOT NULL,
  title            TEXT NOT NULL,
  kpis_json        TEXT NOT NULL,
  version          INTEGER NOT NULL,
  updated_by       TEXT NOT NULL,
  updated_by_name  TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (org_id, team_id, month)
);
CREATE INDEX idx_member_goals_org_month ON member_goals(org_id, month);
