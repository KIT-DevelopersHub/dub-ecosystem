-- lp-analytics service — lp_ namespace. チケット販売のプレビュー表示フラグ。
-- preview_enabled = LP管理「バージョン」タブのトグル。1 のとき、版のプレビュー（?version= / LP管理の「見る」）
--   でだけチケット販売中の見た目になる。公開中の LP（版指定なし）には一切効かず、申し込みもできない。
-- 追加のみ。既存行は 0（オフ）になる。
ALTER TABLE lp_ticket_settings ADD COLUMN preview_enabled INTEGER NOT NULL DEFAULT 0;
