-- lp-analytics service — lp_ namespace. 公開 LP のチケット購入（/tickets）。
-- lp_ticket_settings = サイトごとに 1 行。販売 on/off（lp:publish 必須）と入力項目（JSON）。
-- lp_ticket_types    = 券種（名前・説明・価格・定員・販売中）。LP管理 編集で追加/変更。
-- lp_ticket_orders   = 1 注文 = 1 枚。決済は Stripe Checkout（0 円は Stripe を通さず即 paid）。
--   status: pending -> paid / expired。遷移は常に WHERE status='pending'（webhook と thanks の二重確定に冪等）。
--   定員判定は paid + 作成 35 分以内の pending。回答は label ごと JSON で保存（項目を消しても意味が残る）。
-- 追加のみ・冪等（IF NOT EXISTS）。site は lp_publish と同じキー（例: hokuriku-it-conf.com）。

CREATE TABLE IF NOT EXISTS lp_ticket_settings (
  site         TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 0,
  fields_json  TEXT NOT NULL DEFAULT '[]',          -- LpTicketField[]（氏名・メールは固定なので含めない）
  updated_by   TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_ticket_types (
  id           TEXT PRIMARY KEY,
  site         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price_jpy    INTEGER NOT NULL,                    -- 0 = 無料（招待枠）・1..49 は Stripe 不可で弾く
  capacity     INTEGER,                             -- NULL = 定員なし
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_ticket_orders (
  id                 TEXT PRIMARY KEY,
  site               TEXT NOT NULL,
  ticket_type_id     TEXT NOT NULL,
  ticket_type_name   TEXT NOT NULL,                 -- 購入時点の券種名
  amount_jpy         INTEGER NOT NULL,              -- 購入時点のサーバー価格
  status             TEXT NOT NULL,                 -- 'pending' | 'paid' | 'expired'
  buyer_name         TEXT NOT NULL,
  buyer_email        TEXT NOT NULL,
  answers_json       TEXT NOT NULL DEFAULT '[]',    -- [{fieldId,label,value}]
  stripe_session_id  TEXT UNIQUE,
  created_at         TEXT NOT NULL,
  paid_at            TEXT
);

-- 券種ごとの販売数・定員判定。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_type ON lp_ticket_orders(site, ticket_type_id, status);
-- 購入者一覧（新しい順）と 1 日の checkout 上限の数え上げ。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_created ON lp_ticket_orders(site, created_at);
