-- lp-analytics service — lp_ namespace. 公開サイトに出す LP の版（LP管理の「公開版切り替え」）。
-- lp_publish = サイトごとに 1 行。公開 LP Worker が service binding で読み、その版を配信する。
-- 切り替えは lp:publish を持つロールだけ（lp-analytics の POST /lp/publish が検査）。
-- 初期値は切り替え機能導入時点の本番版 v3.4（行が無い時もアプリ側で同じ既定を返す）。

CREATE TABLE IF NOT EXISTS lp_publish (
  site        TEXT PRIMARY KEY,                    -- 例: hokuriku-it-conf.com
  version_id  TEXT NOT NULL,                       -- 例: v3.4（@dub/types lp.LP_PUBLISHABLE_VERSION_IDS）
  updated_by  TEXT,                                -- 切り替えた user id（初期 seed は NULL）
  updated_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO lp_publish (site, version_id, updated_by, updated_at) VALUES
  ('hokuriku-it-conf.com', 'v3.4', NULL, '2026-10-12T00:00:00.000Z');
