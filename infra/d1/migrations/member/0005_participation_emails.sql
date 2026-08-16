-- namespace: member | owner: member-service (参加届: 学校メール + Gmail の2アドレス)
-- Additive, non-destructive: a 参加届 now carries two required email addresses (the
-- participant's school address and their Gmail). Both are retained on the resolved
-- 運営メンバー (member_people) too, so the roster keeps both channels — not just the
-- single free-text `contact`. New columns are nullable at the DDL level (SQLite can't
-- ADD a NOT NULL column without a default); the app layer requires them on submit.
ALTER TABLE member_participations ADD COLUMN school_email TEXT;
ALTER TABLE member_participations ADD COLUMN gmail TEXT;
ALTER TABLE member_people ADD COLUMN school_email TEXT;
ALTER TABLE member_people ADD COLUMN gmail TEXT;
