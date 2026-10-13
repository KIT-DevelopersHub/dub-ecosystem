-- オンボーディング案内のミーティング (全体 / チームごとの「いつ・どのリンクに入るか」)。
-- 新規テーブルのみの additive。team_id = '' が全体ミーティング、それ以外は member_teams.id。
-- Mirrors the schema.ts const MEMBER_ONBOARDING_MEETINGS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_onboarding_meetings (
  org_id      TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  schedule    TEXT NOT NULL,
  url         TEXT,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, team_id)
);
