-- lp-analytics service — lp_ticket_orders に実際に使われた決済手段を足す（LP管理 の購入者一覧に表示）。
-- payment_method = Stripe の PaymentMethod.type（'card' / 'paypay' など）。無料・未確定・不明は NULL。
-- 表示専用: サービスはこの列が無くても注文確定を止めない（書き込みは失敗を握りつぶす）。
-- 追加のみ（nullable・DEFAULT なし）。既存行は NULL のまま。

ALTER TABLE lp_ticket_orders ADD COLUMN payment_method TEXT;
