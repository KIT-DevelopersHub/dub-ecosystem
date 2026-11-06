-- lp-tickets — 購入後の受け渡し（チケットと送信 outbox）。追加のみ・冪等（IF NOT EXISTS）。
-- lp_tickets        = 1 席 1 行。id は「注文 id + 連番」なので発行は何度流しても同じ行になる。
--   URL に入るトークンは署名から毎回導出し、ここにも backup にも保存しない。
-- lp_ticket_outbox  = 注文ごとの送信予定。next_attempt_at は次の試行時刻 兼 送信中のリース。
-- lp_ticket_jobs    = 1 日 1 回の処理の実行記録（backup した日・全件見直しをした日など）。

CREATE TABLE IF NOT EXISTS lp_tickets (
  id                TEXT PRIMARY KEY,               -- <orderId>-<seq>（seq は 1 始まり）
  order_id          TEXT NOT NULL,
  ticket_type_id    TEXT NOT NULL,
  ticket_type_name  TEXT NOT NULL,                  -- 購入時点の券種名
  day_label         TEXT NOT NULL DEFAULT '',       -- 購入時点の対象日
  status            TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'void')),
  created_at        TEXT NOT NULL,
  voided_at         TEXT
);

CREATE TABLE IF NOT EXISTS lp_ticket_outbox (
  id                TEXT PRIMARY KEY,               -- <orderId>:<kind>。Resend の Idempotency-Key にもなる
  order_id          TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('buyer_confirmation', 'ops_copy')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,     -- 宛先側の理由で断られた回数（一時障害は数えない）
  next_attempt_at   TEXT NOT NULL,
  last_error        TEXT,                           -- 短い理由コードだけ。本文・宛先・トークンは入れない
  sent_at           TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (order_id, kind)
);

CREATE TABLE IF NOT EXISTS lp_ticket_jobs (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 注文 -> チケット（送信・返金時の無効化・一括読み出し）。
CREATE INDEX IF NOT EXISTS idx_lp_tickets_order ON lp_tickets(order_id);
-- 送信待ちの取り出し（status='pending' かつ next_attempt_at が過去）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_outbox_due ON lp_ticket_outbox(status, next_attempt_at);
-- 1 日の送信数（TICKET_MAIL_DAILY_CAP）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_outbox_sent ON lp_ticket_outbox(status, sent_at);
-- 発行漏れの見直し（最近支払われた注文だけを読む）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_paid ON lp_ticket_orders(site, status, paid_at);
