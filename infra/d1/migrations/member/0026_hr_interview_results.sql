-- 人事アプリ: 面談結果 (合否・理由・合格で発行したアカウント・メール送信)。新規テーブルのみの additive。
-- applicant_id UNIQUE で応募者ごとに 1 件。二度押し・再試行でもアカウントとメールは 1 回だけ (lease_until は処理中の占有)。
-- Mirrors the schema.ts const MEMBER_HR_INTERVIEW_RESULTS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_hr_interview_results (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL,
  applicant_id             TEXT NOT NULL UNIQUE REFERENCES member_hr_applicants(id),
  decision                 TEXT NOT NULL,
  reason                   TEXT NOT NULL,
  include_reason           INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL,
  issued_address           TEXT,
  issued_identity_user_id  TEXT,
  issued_member_id         TEXT,
  mail_sent_at             TEXT,
  lease_until              TEXT,
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  completed_at             TEXT
);
CREATE INDEX idx_member_hr_interview_results_org ON member_hr_interview_results(org_id, created_at);
