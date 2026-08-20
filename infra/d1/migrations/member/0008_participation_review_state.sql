-- namespace: member | owner: member-service (参加届: 管理者レビュー状態 review_state)
-- 名簿への反映を「提出時に自動」から「管理者が一覧で確定」へ変更 (B案) するための
-- additive ALTER。non-destructive・冪等。既存の自動反映済み行 (0007以前に提出され
-- member_people へ反映済み) は review_state='added' として後方互換を保つ (backfill)。
-- 以後の新規提出は app 層が 'pending' を書き、確定時に 'added'/'skipped' へ更新する。
-- SQLite ADD COLUMN は NOT NULL 既定を付けられないため nullable。
ALTER TABLE member_participations ADD COLUMN review_state TEXT;
UPDATE member_participations SET review_state = 'added' WHERE review_state IS NULL;
