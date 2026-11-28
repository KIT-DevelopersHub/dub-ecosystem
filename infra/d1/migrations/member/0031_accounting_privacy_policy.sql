-- 会計: 公式サイト (LP) のプライバシーポリシー本文。1 回の保存 = 1 行 (版ごとに残す = 変更履歴)。現在の本文は最大の version。
-- 新規テーブルのみの additive。Mirrors the schema.ts const MEMBER_ACCOUNTING_PRIVACY_POLICY_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_accounting_privacy_policy (
  org_id           TEXT NOT NULL,
  version          INTEGER NOT NULL,
  body             TEXT NOT NULL,
  updated_by       TEXT NOT NULL,
  updated_by_name  TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (org_id, version)
);
