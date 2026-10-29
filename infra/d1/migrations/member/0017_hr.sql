-- 人事アプリ (応募 → 書類選考 → 面談 → 内定/不採用 → 参加 → オンボーディング)。新規テーブルのみの additive。
-- 名簿 (member_people) は複製しない: 参加確定で member_id に名簿行を結ぶだけ。オンボーディングの
-- チェックリストは既存の案内項目 member_onboarding_items をテンプレートとして使い、チェック状態だけ持つ。
-- Mirrors the schema.ts const MEMBER_HR_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_hr_applicants (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  name              TEXT NOT NULL,
  name_kana         TEXT,
  email             TEXT,
  department        TEXT,
  grade             TEXT,
  desired_team_id   TEXT,
  source            TEXT,
  motivation        TEXT,
  stage             TEXT NOT NULL,
  member_id         TEXT,
  participation_id  TEXT,
  version           INTEGER NOT NULL,
  archived_at       TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_member_hr_applicants_org ON member_hr_applicants(org_id, stage) WHERE archived_at IS NULL;
CREATE TABLE member_hr_events (
  id            TEXT PRIMARY KEY,
  applicant_id  TEXT NOT NULL REFERENCES member_hr_applicants(id),
  kind          TEXT NOT NULL,
  from_stage    TEXT,
  to_stage      TEXT,
  body          TEXT,
  actor_id      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_member_hr_events_applicant ON member_hr_events(applicant_id, created_at);
CREATE TABLE member_hr_onboarding_checks (
  person_id   TEXT NOT NULL REFERENCES member_people(id),
  item_id     TEXT NOT NULL,
  checked_by  TEXT NOT NULL,
  checked_at  TEXT NOT NULL,
  PRIMARY KEY (person_id, item_id)
);
