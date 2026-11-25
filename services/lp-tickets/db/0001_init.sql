-- lp-tickets service — 専用 D1 `dub-tickets` の初期スキーマ。
-- infra/d1/migrations/lp/ の 0003 / 0005 / 0006 / 0007 / 0008 / 0009 を統合した最終形（テーブル名はそのまま）。
-- lp_ticket_settings    = サイトごとに 1 行。販売 on/off・LP の参加登録ボタン差し替え on/off と入力項目（JSON）。
-- lp_ticket_types       = 券種（名前・説明・価格・定員・対象日・1 回の上限枚数・販売中）。
-- lp_ticket_orders      = 1 回の購入。決済は Stripe Checkout（合計 0 円は Stripe を通さず即 paid）。
--   status: pending / paid / expired / refunded / needs_review。
-- lp_ticket_order_items = 購入の明細（券種 x 枚数）。定員判定は paid + 作成 35 分以内の pending の枚数合計。
-- lp_ticket_coupons     = 無料券のクーポン。1 コード = 1 券種 x 最大 max_uses 枚。削除はしない（止めるときは active = 0）。
--
-- 列の順序は dub-core の物理順（CREATE の列 → ALTER で足した順）と完全に同じにしてある。
-- wrangler d1 export の INSERT を流し込むので、順序を変えない（test/schema.test.ts が検査する）。
-- 冪等（IF NOT EXISTS）。

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
  status             TEXT NOT NULL,                 -- 'pending' | 'paid' | 'expired' | 'refunded' | 'needs_review'
  buyer_name         TEXT NOT NULL,
  buyer_email        TEXT NOT NULL,
  answers_json       TEXT NOT NULL DEFAULT '[]',    -- [{fieldId,label,value}]
  stripe_session_id  TEXT UNIQUE,
  created_at         TEXT NOT NULL,
  paid_at            TEXT,
  payment_method     TEXT,                          -- Stripe の PaymentMethod.type。無料・未確定・不明は NULL
  preview            INTEGER,                       -- 1 = LP管理プレビュー由来のテスト注文
  payment_intent_id  TEXT,                          -- 返金・チャージバックの webhook を注文に結び付けるキー
  refunded_at        TEXT,
  review_reason      TEXT,                          -- needs_review の理由（確定後も履歴として残す）
  resolved_by        TEXT,                          -- needs_review を paid に確定した人（自動なら 'stripe'）
  resolved_at        TEXT,
  client_key         TEXT,                          -- 公開 LP Worker が計算した送信元 IP のハッシュ（生 IP は保存しない）
  coupon_id          TEXT                           -- その注文で使ったクーポン。クーポン注文は常に 0 円
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

CREATE TABLE IF NOT EXISTS lp_ticket_coupons (
  id              TEXT PRIMARY KEY,
  site            TEXT NOT NULL,
  code            TEXT NOT NULL,                   -- サーバーが生成（英大文字と数字のみ・ハイフンなし）
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

-- 券種ごとの販売数・定員判定（明細 -> 注文の status）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_order_items_type ON lp_ticket_order_items(ticket_type_id);
-- 購入者一覧（新しい順）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_created ON lp_ticket_orders(site, created_at);
-- charge.refunded / charge.dispute.created -> 注文。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_payment_intent ON lp_ticket_orders(payment_intent_id);
-- 照合: status='pending' かつ作成日時の範囲。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_status_created ON lp_ticket_orders(site, status, created_at);
-- 送信元ごとの決済待ち枚数（client_key + status + 作成日時）。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_client ON lp_ticket_orders(client_key, status, created_at);
-- クーポンごとの使用枚数。
CREATE INDEX IF NOT EXISTS idx_lp_ticket_orders_coupon ON lp_ticket_orders(coupon_id, status, created_at);
