-- lp-analytics service — lp_ticket_orders に「LP管理 プレビュー由来のテスト注文」印を足す（LP管理 の購入者一覧で「テスト」表示）。
-- preview = 1: LP管理「プレビュー」（販売あり）のテスト購入トークンで作られた注文（Stripe テストキーの時だけ作れる）。
-- 表示専用: サービスはこの列が無くても購入を止めない（書き込みは失敗を握りつぶす。有料のテスト注文は cs_test_ でも判別）。
-- 追加のみ（nullable・DEFAULT なし）。既存行は NULL のまま。

ALTER TABLE lp_ticket_orders ADD COLUMN preview INTEGER;
