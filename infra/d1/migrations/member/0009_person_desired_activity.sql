-- 参加届: 希望する活動(desired_activity) を名簿(member_people)にも保持する additive ALTER
-- (non-destructive). 0005〜0007 が 参加届 の各項目を member_people へミラーしたのと同じ流儀
-- で、唯一ミラーされていなかった desired_activity を足す。これにより本人が アカウント設定 →
-- 参加情報 で自分の 参加届 (希望活動 を含む) を自己 read/update でき、実DBへ往復保存できる。
-- Mirrors the schema.ts const MEMBER_PERSON_DESIRED_ACTIVITY_MIGRATION
-- (schema-lockstep.test.ts). SQLite ADD COLUMN は既定値を付けられないため nullable。
ALTER TABLE member_people ADD COLUMN desired_activity TEXT;
