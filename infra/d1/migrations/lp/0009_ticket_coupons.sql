-- lp-analytics service — lp_ namespace. 無料券のクーポンコード（0003 の券種・注文を拡張）。
-- lp_ticket_coupons = LP管理で発行するコード。1 コード = 1 券種 x 最大 max_uses 枚。
--   code はサーバーが生成する推測できない文字列（正規化済み: 英大文字と数字のみ・ハイフンなし）。
--   使った枚数は注文から数える（paid / needs_review + 作成 35 分以内の pending の枚数合計。席の押さえと同じ規則）。
--   使用枚数の判定は注文の INSERT と同じ 1 batch（= 1 トランザクション）なので、同時に使っても max_uses を超えない。
--   削除はしない（注文が参照するため）。止めるときは active = 0。
-- lp_ticket_orders.coupon_id = その注文で使ったクーポン。クーポン注文は常に 0 円（Stripe を通さない）。
--   価格 0 円の券種はクーポン必須（コード無しの申し込みは受け付けない）。
-- 追加のみ。列は NULL 可・DEFAULT なし（既存行は NULL のまま動く）。CREATE / index は IF NOT EXISTS。

CREATE TABLE IF NOT EXISTS lp_ticket_coupons (
  id              TEXT PRIMARY KEY,
  site            TEXT NOT NULL,
  code            TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',        -- 用途メモ（例: 登壇者招待）
  ticket_type_id  TEXT NOT NULL,                   -- 対象の券種（この券種だけが 0 円になる）
  max_uses        INTEGER NOT NULL,                -- 使える枚数の合計
  expires_at      TEXT,                            -- NULL = 期限なし
  active          INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (site, code)
);

ALTER TABLE lp_ticket_orders ADD COLUMN coupon_id TEXT;

-- クーポンごとの使用枚数。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_coupon ON lp_ticket_orders(coupon_id, status, created_at);
