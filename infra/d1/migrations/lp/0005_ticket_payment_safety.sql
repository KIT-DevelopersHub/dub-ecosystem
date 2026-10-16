-- lp-analytics service — lp_ namespace. チケット決済の取りこぼし・返金の反映（0003 の lp_ticket_orders を拡張）。
--   status に 'refunded'（全額返金・席を解放）と 'needs_review'（金額/通貨の不一致・チャージバック。席は確保したまま人が確認）が加わる。
--   遷移: pending|expired -> paid（遅れて届いた支払い完了は期限切れより優先） / pending -> expired（paid からは戻さない） /
--         pending|expired|paid -> needs_review / paid|needs_review -> refunded。
--   payment_intent_id = 返金・チャージバックの webhook（charge.*）を注文に結び付けるキー。
--   refunded_at       = 全額返金を反映した時刻。
--   review_reason     = needs_review にした理由（amount_mismatch / currency_mismatch / dispute）。
-- 追加のみ。列は NULL 可・DEFAULT なし（既存行は NULL のまま動く）。index は IF NOT EXISTS。

ALTER TABLE lp_ticket_orders ADD COLUMN payment_intent_id TEXT;
ALTER TABLE lp_ticket_orders ADD COLUMN refunded_at TEXT;
ALTER TABLE lp_ticket_orders ADD COLUMN review_reason TEXT;

-- charge.refunded / charge.dispute.created -> 注文。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_payment_intent ON lp_ticket_orders(payment_intent_id);
-- 照合 cron: status='pending' かつ作成日時の範囲。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_status_created ON lp_ticket_orders(site, status, created_at);
