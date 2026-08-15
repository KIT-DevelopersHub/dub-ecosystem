-- namespace: member | owner: member-service (運営メンバー管理)
-- 学科(department)・学年(grade) を専用カラムに昇格する。従来は自由記述の note(メモ)
-- 欄に手書き混在していた学科/学年を、一覧・詳細・編集で独立して扱える構造化フィールド
-- へ分離する。既存の member_people 行は保持したまま NULL 許容カラムを追加するだけの
-- 非破壊 ALTER（forward-only・ledger管理で一度だけ適用）。既知分はアプリ/移行で backfill
-- でき、不明分は空(NULL)のまま。note 列は残すが、学科/学年はカラムを優先表示する。
ALTER TABLE member_people ADD COLUMN department TEXT;
ALTER TABLE member_people ADD COLUMN grade TEXT;
