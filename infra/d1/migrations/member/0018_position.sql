-- 役職 (position: organizer / leader / member) を名簿と参加届に足す additive ALTER (non-destructive).
-- 参加届で本人が選び、管理者が確定すると member_people.position へ引き継ぐ。名簿では管理者が直せる。
-- 既存行は全て null（後方互換・役職ロールは付かない）。値の検証はアプリ層 (member.isMemberPosition)。
-- Mirrors the schema.ts const MEMBER_POSITION_MIGRATION (schema-lockstep.test.ts).
ALTER TABLE member_people ADD COLUMN position TEXT;
ALTER TABLE member_participations ADD COLUMN position TEXT;
