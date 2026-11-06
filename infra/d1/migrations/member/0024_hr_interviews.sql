-- 人事アプリ: 面談の日程調整。新規テーブルのみの additive。
-- 面談枠 (slots) は人事ごとの空き時間。予約すると applicant_id が入る。部分 UNIQUE で 1 人 1 枠を保証する。
-- 招待 (invites) は応募者ごとに 1 行。sent_at が NULL の間は案内メール保留中で、token が日程選択 URL の資格情報。
-- 設定 (settings) は org ごと 1 行。行が無ければ @dub/types hrInterview.DEFAULT_MIN_OPEN_SLOTS。
-- Mirrors the schema.ts const MEMBER_HR_INTERVIEWS_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_hr_interview_slots (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  start_at          TEXT NOT NULL,
  end_at            TEXT NOT NULL,
  interviewer_id    TEXT NOT NULL,
  interviewer_name  TEXT NOT NULL,
  applicant_id      TEXT REFERENCES member_hr_applicants(id),
  booked_at         TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_member_hr_interview_slots_org ON member_hr_interview_slots(org_id, start_at);
CREATE UNIQUE INDEX idx_member_hr_interview_slots_owner_time ON member_hr_interview_slots(org_id, interviewer_id, start_at);
CREATE UNIQUE INDEX idx_member_hr_interview_slots_applicant ON member_hr_interview_slots(applicant_id) WHERE applicant_id IS NOT NULL;
CREATE TABLE member_hr_interview_invites (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  applicant_id  TEXT NOT NULL UNIQUE REFERENCES member_hr_applicants(id),
  token         TEXT NOT NULL UNIQUE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_member_hr_interview_invites_org ON member_hr_interview_invites(org_id, created_at);
CREATE TABLE member_hr_interview_settings (
  org_id          TEXT PRIMARY KEY,
  min_open_slots  INTEGER NOT NULL,
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
