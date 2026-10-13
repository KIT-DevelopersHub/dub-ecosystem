-- lp-analytics service — lp_ namespace. 公開 LP のチケット購入（/tickets）。
-- lp_ticket_settings    = サイトごとに 1 行。販売 on/off・LP の参加登録ボタン差し替え on/off（どちらも lp:publish 必須）と入力項目（JSON）。
-- lp_ticket_types       = 券種（名前・説明・価格・定員・対象日・1 回の上限枚数・販売中）。LP管理 編集で追加/変更。
-- lp_ticket_orders      = 1 回の購入。決済は Stripe Checkout（合計 0 円は Stripe を通さず即 paid）。
--   status: pending -> paid / expired。遷移は常に WHERE status='pending'（webhook と thanks の二重確定に冪等）。
--   回答は label ごと JSON で保存（項目を消しても意味が残る）。
-- lp_ticket_order_items = 購入の明細（券種 x 枚数）。定員判定は paid + 作成 35 分以内の pending の枚数合計。
-- 追加のみ・冪等（IF NOT EXISTS）。site は lp_publish と同じキー（例: hokuriku-it-conf.com）。

CREATE TABLE IF NOT EXISTS lp_ticket_settings (
  site         TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 0,
  cta_enabled  INTEGER NOT NULL DEFAULT 0,          -- LP の「参加登録」ボタンを「参加チケットを購入」に差し替える
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
  capacity     INTEGER,                             -- NULL = 定員なし（枚数）
  day_label    TEXT NOT NULL DEFAULT '',            -- 対象日（例 Day 1）。'' = 通し/共通
  max_per_order INTEGER NOT NULL DEFAULT 10,        -- 1 回の購入で買える上限枚数
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_ticket_orders (
  id                 TEXT PRIMARY KEY,
  site               TEXT NOT NULL,
  quantity           INTEGER NOT NULL,              -- 合計枚数
  amount_jpy         INTEGER NOT NULL,              -- 合計金額（購入時点のサーバー価格）
  status             TEXT NOT NULL,                 -- 'pending' | 'paid' | 'expired'
  buyer_name         TEXT NOT NULL,
  buyer_email        TEXT NOT NULL,
  answers_json       TEXT NOT NULL DEFAULT '[]',    -- [{fieldId,label,value}]
  stripe_session_id  TEXT UNIQUE,
  created_at         TEXT NOT NULL,
  paid_at            TEXT
);

CREATE TABLE IF NOT EXISTS lp_ticket_order_items (
  order_id           TEXT NOT NULL,
  ticket_type_id     TEXT NOT NULL,
  ticket_type_name   TEXT NOT NULL,                 -- 購入時点の券種名
  day_label          TEXT NOT NULL DEFAULT '',      -- 購入時点の対象日
  unit_price_jpy     INTEGER NOT NULL,              -- 購入時点のサーバー価格
  quantity           INTEGER NOT NULL,
  PRIMARY KEY (order_id, ticket_type_id)
);

-- 券種ごとの販売数・定員判定（明細 -> 注文の status）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_order_items_type ON lp_ticket_order_items(ticket_type_id);
-- 購入者一覧（新しい順）と 1 日の checkout 上限の数え上げ。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_created ON lp_ticket_orders(site, created_at);
