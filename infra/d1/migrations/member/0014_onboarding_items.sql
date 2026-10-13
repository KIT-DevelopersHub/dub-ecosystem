-- オンボーディング案内項目 (新メンバーへの「やってほしいこと」)。新規テーブルのみの additive。
-- 管理者が 運営メンバー・名簿 → オンボーディング で編集し、公開ページ /onboarding が表示する。
-- Mirrors the schema.ts const MEMBER_ONBOARDING_ITEMS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_onboarding_items (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  url         TEXT,
  sort_order  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_member_onboarding_items_org ON member_onboarding_items(org_id, sort_order);
