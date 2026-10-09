-- 名簿の学年 (自由記述だった頃の値) を参加届と同じ選択肢 (1〜4 / graduate) にそろえる。
-- 2026-10-10 時点の本番は '2年' と '３' の 2 行だけが対象 (staging は全行 null)。
-- 何度流しても結果は同じ (冪等)。読み込み時の normalizeGrade は保険として残す。
-- Mirrors the schema.ts const MEMBER_PERSON_GRADE_NORMALIZE_MIGRATION (schema-lockstep.test.ts).
UPDATE member_people SET grade = '1' WHERE grade IN ('1年', '1年生', '１', '１年', '１年生');
UPDATE member_people SET grade = '2' WHERE grade IN ('2年', '2年生', '２', '２年', '２年生');
UPDATE member_people SET grade = '3' WHERE grade IN ('3年', '3年生', '３', '３年', '３年生');
UPDATE member_people SET grade = '4' WHERE grade IN ('4年', '4年生', '４', '４年', '４年生');
UPDATE member_people SET grade = 'graduate' WHERE grade IN ('院生', '大学院', 'M1', 'M2', 'D1', 'D2', 'D3');
