-- 参加届にも名列番号 (roster_number, 例 "3EP2-26") を足す additive ALTER (non-destructive).
-- 既存行は全て null（後方互換）。管理者が確定すると member_people.roster_number へ引き継ぐ。
-- Mirrors the schema.ts const MEMBER_PARTICIPATION_ROSTER_NUMBER_MIGRATION (schema-lockstep.test.ts).
ALTER TABLE member_participations ADD COLUMN roster_number TEXT;
