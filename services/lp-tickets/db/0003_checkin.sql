-- lp-tickets — 当日受付・無料参加登録・領収書の宛名。追加のみ（既存の列・行は変えない）。
-- 新しい列は NULL 可・DEFAULT なしなので、この SQL を当てる前のコードも後のコードもそのまま動く。
--
-- lp_ticket_checkins = 受付の記録。1 枚 x 開催日 1 行（全体受付を開催日ごとに行う）。
--   通し券は Day 1 と Day 2 でそれぞれ 1 回ずつ受付でき、同じ日の 2 回目は UNIQUE で弾く。
--   受付は INSERT ... ON CONFLICT DO NOTHING の 1 文で、変更 0 行 = 受付済み（キューやバッチは使わない）。
--   受付の取り消し（読み間違え）は行の DELETE。
--   event_day = 開催日（JST の 'YYYY-MM-DD'）。券種の day_label は表示用の自由文字列なので鍵にしない。
--
-- 1 回だけ当てる: ALTER TABLE ADD COLUMN は 2 回目に duplicate column で止まる（その前の CREATE は IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS lp_ticket_checkins (
  ticket_id       TEXT NOT NULL,                  -- lp_tickets.id
  event_day       TEXT NOT NULL,                  -- 開催日 'YYYY-MM-DD'（JST）
  checked_in_at   TEXT NOT NULL,
  checked_in_by   TEXT NOT NULL,                  -- 受付した運営のユーザー id
  PRIMARY KEY (ticket_id, event_day)
);

-- 日ごとの受付一覧・入場数（新しい順）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_checkins_day ON lp_ticket_checkins(event_day, checked_in_at);

-- 1 注文で複数枚のときの参加者名（名札用・任意）。NULL = 購入者名を使う。
ALTER TABLE lp_tickets ADD COLUMN holder_name TEXT;
-- 1 = 0 円券をクーポン無しで申し込める（無料参加登録）。NULL / 0 = 今まで通りクーポン必須。
ALTER TABLE lp_ticket_types ADD COLUMN open_registration INTEGER;
-- 領収書の宛名（任意）。NULL = 宛名なし（購入者名は使わない）。
ALTER TABLE lp_ticket_orders ADD COLUMN receipt_name TEXT;
