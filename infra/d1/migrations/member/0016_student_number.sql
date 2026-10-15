-- 学籍番号 (student_number, 例 "1400980") を名簿と参加届に足す additive ALTER (non-destructive).
-- 既存行は全て null（後方互換）。参加届は管理者が確定すると member_people.student_number へ引き継ぐ。
-- Mirrors the schema.ts const MEMBER_STUDENT_NUMBER_MIGRATION (schema-lockstep.test.ts).
ALTER TABLE member_people ADD COLUMN student_number TEXT;
ALTER TABLE member_participations ADD COLUMN student_number TEXT;
