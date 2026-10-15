-- 学籍番号 (student_id, 例 "1400980"・7 桁の数字) を名簿に足す additive ALTER (non-destructive).
-- 既存行は全て null（後方互換・任意項目）。先頭 0 を保つため TEXT。形式検証・正規化はアプリ層。
-- Mirrors the schema.ts const MEMBER_PERSON_STUDENT_ID_MIGRATION (schema-lockstep.test.ts).
ALTER TABLE member_people ADD COLUMN student_id TEXT;
