-- lp-tickets — 返金・取消のお知らせを outbox で送り直せるようにする（kind に 'buyer_refund' を足す）。
-- SQLite は CHECK を ALTER できないので、行を保ったまま作り直す（task/0003 と同じ「横に退避 → 同じ名前で
-- 作り直す → 全行コピー → 退避を消す」）。列・型・既定値・UNIQUE・索引は 0002 と同じで、変わるのは CHECK だけ。
-- 他のテーブルからの外部キーは無い。wrangler d1 execute --file は 1 トランザクションなので途中で止まっても元のまま。
--
-- 何度当てても同じ結果になる（2 回目も同じ作り直しをするだけ）。
-- 当てる前のコードも後のコードもそのまま動く。当てずに新しいコードを出すと、返金は通るがお知らせが
-- outbox に入らない（INSERT OR IGNORE が CHECK 違反を飛ばす）ので、デプロイの前に当てる。

ALTER TABLE lp_ticket_outbox RENAME TO lp_ticket_outbox_v0003;

CREATE TABLE lp_ticket_outbox (
  id                TEXT PRIMARY KEY,               -- <orderId>:<kind>。Resend の Idempotency-Key にもなる
  order_id          TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('buyer_confirmation', 'ops_copy', 'buyer_refund')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,     -- 宛先側の理由で断られた回数（一時障害は数えない）
  next_attempt_at   TEXT NOT NULL,
  last_error        TEXT,                           -- 短い理由コードだけ。本文・宛先・トークンは入れない
  sent_at           TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (order_id, kind)
);

INSERT INTO lp_ticket_outbox (id, order_id, kind, status, attempts, next_attempt_at, last_error, sent_at, created_at)
  SELECT id, order_id, kind, status, attempts, next_attempt_at, last_error, sent_at, created_at
  FROM lp_ticket_outbox_v0003;

DROP TABLE lp_ticket_outbox_v0003;

-- 0002 の索引を作り直す（退避したテーブルと一緒に消えている）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_outbox_due ON lp_ticket_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_lp_ticket_outbox_sent ON lp_ticket_outbox(status, sent_at);
