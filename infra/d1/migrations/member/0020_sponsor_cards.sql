-- スポンサーアプリ (フェーズ1 = 名刺の共有)。新規テーブルのみの additive。項目と上限は @dub/types sponsor が SoT。
-- 写真本体は R2 (dub-file-attachments の sponsor/cards/<id>)。ここには形式だけを持ち、NULL = 写真なし。
-- created_by_name は登録時点の名簿 (member_people) の氏名 (表示用・名簿に紐付いていなければ NULL)。
-- Mirrors the schema.ts const MEMBER_SPONSOR_CARDS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_sponsor_cards (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  company_name        TEXT,
  person_name         TEXT,
  department          TEXT,
  title               TEXT,
  email               TEXT,
  phone               TEXT,
  note                TEXT,
  image_content_type  TEXT,
  version             INTEGER NOT NULL,
  created_by          TEXT NOT NULL,
  created_by_name     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  archived_at         TEXT
);
CREATE INDEX idx_member_sponsor_cards_org ON member_sponsor_cards(org_id, updated_at) WHERE archived_at IS NULL;
