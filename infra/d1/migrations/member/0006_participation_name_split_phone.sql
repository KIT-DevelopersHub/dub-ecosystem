-- namespace: member | owner: member-service (参加届: 氏名/振り仮名の姓名分割 + 電話番号)
-- Additive, non-destructive: a 参加届 now captures the 氏名 and 振り仮名 as SEPARATE
-- 姓 (last) / 名 (first) fields, plus an optional 電話番号. The legacy single `name` /
-- `name_kana` columns are RETAINED and kept in sync by the app (app composes "姓 名"
-- into `name`) so every existing reader (roster, member_people 連携) keeps working —
-- staged migration, no column drop. New columns are nullable at the DDL level (SQLite
-- can't ADD a NOT NULL column without a default); 姓/名 are required at the app layer
-- while 振り仮名 and 電話 stay optional. Retained on the resolved 運営メンバー
-- (member_people) too so the roster keeps the structured name + phone.
ALTER TABLE member_participations ADD COLUMN last_name TEXT;
ALTER TABLE member_participations ADD COLUMN first_name TEXT;
ALTER TABLE member_participations ADD COLUMN last_name_kana TEXT;
ALTER TABLE member_participations ADD COLUMN first_name_kana TEXT;
ALTER TABLE member_participations ADD COLUMN phone TEXT;
ALTER TABLE member_people ADD COLUMN last_name TEXT;
ALTER TABLE member_people ADD COLUMN first_name TEXT;
ALTER TABLE member_people ADD COLUMN last_name_kana TEXT;
ALTER TABLE member_people ADD COLUMN first_name_kana TEXT;
ALTER TABLE member_people ADD COLUMN phone TEXT;
