-- lp-analytics service — lp_ namespace. チケット購入ページの事前プレビュー。
-- lp_ticket_previews = 販売を公開する前に /tickets を確認するための期限付きリンク（LP管理 編集で発行）。
--   token は保存せず SHA-256 の hex だけを持つ。期限切れの行は次の発行時に消す。
-- 追加のみ・冪等（IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS lp_ticket_previews (
  token_hash   TEXT PRIMARY KEY,
  site         TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lp_ticket_previews_expires ON lp_ticket_previews (expires_at);
