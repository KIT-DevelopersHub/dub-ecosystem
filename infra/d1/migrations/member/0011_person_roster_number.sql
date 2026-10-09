-- 名列番号 (roster_number, 例 "3EP2-26") を名簿に足す additive ALTER (non-destructive).
-- 既存行は全て null（後方互換）。形式検証・正規化はアプリ層で行う。
-- Mirrors the schema.ts const MEMBER_PERSON_ROSTER_NUMBER_MIGRATION (schema-lockstep.test.ts).
ALTER TABLE member_people ADD COLUMN roster_number TEXT;
