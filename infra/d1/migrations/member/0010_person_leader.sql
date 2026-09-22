-- 各メンバーが配下につく「リーダー」への自己参照リンク (leader_id) を足す additive ALTER
-- (non-destructive). 組織図の親子関係と名簿の組織図順ソートに使う。null は直属リーダー無し。
-- 既存行は全て null（後方互換）。SQLite ADD COLUMN は既定値/参照制約を付けられないため
-- nullable のプレーン TEXT（アプリ層で同一 org・非自己参照を検証）。
-- Mirrors the schema.ts const MEMBER_PERSON_LEADER_MIGRATION (schema-lockstep.test.ts).
ALTER TABLE member_people ADD COLUMN leader_id TEXT;
CREATE INDEX IF NOT EXISTS idx_member_people_leader
  ON member_people(leader_id) WHERE leader_id IS NOT NULL;
