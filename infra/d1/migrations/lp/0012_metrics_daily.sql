-- LP のアクセス解析（LP管理 > ログ管理 >「詳しい分析」・#904）。
-- 1 人・1 訪問ごとの行は持たない。「JST の日 × 項目(dim) × 値(key)」の件数と合計だけを足し込む
-- （項目どうしを掛け合わせない = 個人の再構成ができない）。cookie・IP・UA・訪問者 ID は保存しない。
-- dim: total / path / source / medium / campaign / referrer / device / os / browser / country / region /
--      scroll / section / cta / funnel / funnel_src / vital（行の作り方は @dub/types lpInsights.insightRows）。
-- n = ページビュー（または件数）/ sessions = その行で始まった訪問 / sum_ms = 表示時間などの合計。
-- 書き込みは 1 ビーコン = 数行の UPSERT（PRIMARY KEY だけで二次 index なし = 書き込み行数を増やさない）。
-- 読み取りは期間の範囲スキャン 1 本（PK の先頭 (org_id, day_jst) で絞れる）。日次上限は dim='total' の n で判定。
CREATE TABLE IF NOT EXISTS lp_metrics_daily (
  org_id    TEXT NOT NULL,
  day_jst   TEXT NOT NULL,                 -- YYYY-MM-DD (Asia/Tokyo)
  dim       TEXT NOT NULL,
  key       TEXT NOT NULL,                 -- 値（'' = 無し / total）
  n         INTEGER NOT NULL DEFAULT 0,
  sessions  INTEGER NOT NULL DEFAULT 0,
  sum_ms    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day_jst, dim, key)
) WITHOUT ROWID;
