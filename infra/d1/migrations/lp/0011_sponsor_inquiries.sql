-- lp-analytics service — lp_ namespace. 公開 LP のスポンサー募集（/sponsors の資料請求）。
-- lp_sponsor_inquiry_settings = サイトごとに 1 行。公開 on/off（lp:publish 必須）と通知先。
--   notify_channel_id = 通知を流す Dub チャットのチャンネル id（NULL = チャットに流さない）。
--   notify_email      = スポンサーチームのメール（NULL = Worker の LP_SPONSOR_NOTIFY_EMAIL）。
-- lp_sponsor_inquiries = 資料請求 1 件。必須はメールだけ。
--   status: new（未対応） / sent（資料送付済み） / closed（対応終了）。LP管理 で切り替える。
--   notified_via: chat / mail / both / none（スポンサーチームへの通知がどこに届いたか）。
--   client_key = 送信元 IP のハッシュ（LP Worker が計算・生 IP は保存しない）。1 時間の上限に使う。
-- 追加のみ・冪等（IF NOT EXISTS）。site は lp_publish と同じキー（例: hokuriku-it-conf.com）。

CREATE TABLE IF NOT EXISTS lp_sponsor_inquiry_settings (
  site               TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 0,
  notify_channel_id  TEXT,
  notify_email       TEXT,
  updated_by         TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_sponsor_inquiries (
  id             TEXT PRIMARY KEY,
  site           TEXT NOT NULL,
  company_name   TEXT NOT NULL DEFAULT '',
  contact_name   TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL,
  message        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'new',   -- 'new' | 'sent' | 'closed'
  notified_via   TEXT NOT NULL DEFAULT 'none',  -- 'chat' | 'mail' | 'both' | 'none'
  updated_by     TEXT,
  client_key     TEXT,                          -- 送信元のハッシュ。NULL = 不明
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- 一覧（新しい順）と 1 日の全体上限。
CREATE INDEX IF NOT EXISTS idx_lp_sponsor_inquiries_created ON lp_sponsor_inquiries(site, created_at);
-- 同じ送信元からの 1 時間の件数。
CREATE INDEX IF NOT EXISTS idx_lp_sponsor_inquiries_client ON lp_sponsor_inquiries(site, client_key, created_at);
