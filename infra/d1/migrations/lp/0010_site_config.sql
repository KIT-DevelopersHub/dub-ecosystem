-- lp-analytics service — lp_ namespace. LP の公開設定（セクションのバリアント・表示/非表示・オプション）。
-- lp_site_config = サイトごとに 1 行。下書き（プレビュー）と本番の layout と楽観ロックの revision。
--   draft_json     = LpSiteConfig（layout + release の下書き）。'{}' = まだ保存していない（本番と同じ）。
--   published_json = LpLayout だけ。本番の release は既存の lp_publish / lp_ticket_settings / lp_proposal_settings が正本。
--   revision は下書き保存・リセット・本番反映のたびに 1 増える。食い違えば 409（同時編集の上書き防止）。
-- lp_site_config_history = 本番反映 1 回 = 1 行（反映した LpSiteConfig 全体）。1 つ前に戻す・監査用。append-only。
--   本番反映は lp_site_config・既存 3 テーブル・この履歴を D1 batch 1 回（= 1 トランザクション）で書く。
-- 行が無いときはアプリ側が「全セクション既定値」と既存テーブルの値を返す（適用前のコードもそのまま動く）。
-- 追加のみ・冪等（IF NOT EXISTS）。site は lp_publish と同じキー（例: hokuriku-it-conf.com）。

CREATE TABLE IF NOT EXISTS lp_site_config (
  site              TEXT PRIMARY KEY,
  draft_json        TEXT NOT NULL DEFAULT '{}',
  published_json    TEXT NOT NULL DEFAULT '{}',
  revision          INTEGER NOT NULL DEFAULT 0,
  draft_updated_by  TEXT,
  draft_updated_at  TEXT,
  published_by      TEXT,
  published_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_site_config_history (
  id            TEXT PRIMARY KEY,                    -- prefix-ULID newId("lph")
  site          TEXT NOT NULL,
  config_json   TEXT NOT NULL,                       -- 反映した LpSiteConfig 全体
  published_by  TEXT NOT NULL,
  published_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lp_site_config_history_site ON lp_site_config_history(site, published_at);
