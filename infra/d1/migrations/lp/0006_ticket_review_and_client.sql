-- lp-analytics service — lp_ namespace. チケット決済の「要確認」を人が確定できるようにする + 送信元ごとの席の押さえ上限（0005 の lp_ticket_orders を拡張）。
--   遷移の追加: needs_review -> paid（LP管理で lp:publish を持つ人が確定 / チャージバックに勝った時は自動）。
--               paid|needs_review -> refunded にチャージバックの敗北（charge.dispute.closed status=lost）も含める。
--   resolved_by / resolved_at = needs_review を paid に確定した人（自動なら 'stripe'）と時刻。review_reason は履歴として残す。
--   client_key = 公開 LP Worker が計算した送信元 IP のハッシュ（生 IP は保存しない）。同じ送信元が決済待ちで押さえられる枚数の上限に使う。
-- 追加のみ。列は NULL 可・DEFAULT なし（既存行は NULL のまま動く）。index は IF NOT EXISTS。

ALTER TABLE lp_ticket_orders ADD COLUMN resolved_by TEXT;
ALTER TABLE lp_ticket_orders ADD COLUMN resolved_at TEXT;
ALTER TABLE lp_ticket_orders ADD COLUMN client_key TEXT;

-- 送信元ごとの決済待ち枚数（client_key + status + 作成日時）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_client ON lp_ticket_orders(client_key, status, created_at);
