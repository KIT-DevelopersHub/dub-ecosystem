-- 会計: 団体の発行者情報 (領収書に出す法人名・所在地・インボイス登録番号・税率)。1 団体 1 行。新規テーブルのみの additive。
-- Mirrors the schema.ts const MEMBER_ACCOUNTING_ISSUER_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_accounting_issuer (
  org_id                   TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  office_name              TEXT,
  postal_code              TEXT,
  address                  TEXT,
  phone                    TEXT,
  email                    TEXT,
  url                      TEXT,
  invoice_registration_no  TEXT,
  tax_rate_percent         INTEGER NOT NULL,
  version                  INTEGER NOT NULL,
  updated_by               TEXT NOT NULL,
  updated_by_name          TEXT,
  updated_at               TEXT NOT NULL
);
