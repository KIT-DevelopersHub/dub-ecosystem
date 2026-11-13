-- 面談枠を予約済みなのに 面談日程調整中 のままの応募者を 面談確定 にそろえる (予約時の自動更新より前のデータ・手で戻した分)。
-- 何度流しても結果は同じ (冪等)。行の追加・削除はしない。
-- Mirrors the schema.ts const MEMBER_HR_BOOKED_BACKFILL_MIGRATION (schema-lockstep.test.ts).
UPDATE member_hr_applicants
SET stage = 'interview_set', version = version + 1
WHERE stage = 'scheduling'
  AND archived_at IS NULL
  AND id IN (SELECT applicant_id FROM member_hr_interview_slots WHERE applicant_id IS NOT NULL);
