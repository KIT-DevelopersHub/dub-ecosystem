-- 参加届にも学籍番号 (student_id, 例 "1400980") を足す additive ALTER (non-destructive).
-- 既存行は全て null（後方互換）。管理者が確定すると member_people.student_id へ引き継ぐ。
-- Mirrors the schema.ts const MEMBER_PARTICIPATION_STUDENT_ID_MIGRATION (schema-lockstep.test.ts).
ALTER TABLE member_participations ADD COLUMN student_id TEXT;
