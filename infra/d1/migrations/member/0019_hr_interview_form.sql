-- 人事アプリ: 面談申し込みフォーム (参加届より前の面談に申し込むためのフォーム)。新規テーブルのみの additive。
-- フォームの定義 (タイトル・説明・質問) は org ごとに 1 行 (form_key = 'interview')。質問の形と検証は @dub/types hrForm が SoT。
-- 回答は応募者 (member_hr_applicants) に結ぶ: 送信すると応募者が 面談日程調整中 で登録され、既存の人事フローに乗る。
-- 回答時点の質問も保存し、あとでフォームを編集しても過去の回答の見出しが崩れないようにする。
-- Mirrors the schema.ts const MEMBER_HR_INTERVIEW_FORM_MIGRATION (schema-lockstep.test.ts).
CREATE TABLE member_hr_forms (
  org_id          TEXT NOT NULL,
  form_key        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  questions_json  TEXT NOT NULL,
  accepting       INTEGER NOT NULL DEFAULT 1,
  version         INTEGER NOT NULL,
  updated_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, form_key)
);
CREATE TABLE member_hr_form_responses (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  form_key        TEXT NOT NULL,
  applicant_id    TEXT NOT NULL REFERENCES member_hr_applicants(id),
  answers_json    TEXT NOT NULL,
  questions_json  TEXT NOT NULL,
  via             TEXT NOT NULL,
  submitted_by    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_member_hr_form_responses_org ON member_hr_form_responses(org_id, form_key, created_at);
CREATE INDEX idx_member_hr_form_responses_applicant ON member_hr_form_responses(applicant_id);
