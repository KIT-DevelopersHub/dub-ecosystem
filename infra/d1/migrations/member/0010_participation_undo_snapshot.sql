-- 参加届: 紐付け(link/create)取消(unlink)のための「紐付け前スナップショット」. Additive
-- ALTER (non-destructive, 冪等). 反映確定(link/create)時に、対象メンバーの紐付け前状態
-- (link)や作成したメンバーid(create)＋参加届の元レビュー状態を JSON で保持し、unlink で
-- 紐付け前へ厳密に復元する（結合で足した情報も撤回）。skip/未処理の行や過去に自動反映
-- された行は NULL のまま（安全に戻せないので取消不可）。Mirrors the schema.ts const
-- MEMBER_PARTICIPATION_UNDO_SNAPSHOT_MIGRATION (schema-lockstep.test.ts). SQLite ADD
-- COLUMN は既定値を付けられないため nullable。
ALTER TABLE member_participations ADD COLUMN undo_snapshot TEXT;
