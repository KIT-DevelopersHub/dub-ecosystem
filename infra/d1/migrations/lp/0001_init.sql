-- lp-analytics service — lp_ namespace. LP管理アプリの「流入URL」と「訪問ログ」。
-- lp_links  = 発行した計測つき LP URL（utm_source=<slug>）。停止しても行は消さない。
-- lp_visits = LP が自分で報告した 1 ページビュー（公開ビーコン経由・append-only）。
-- 集計は day_jst（運営が見る「今日」= JST の暦日）で切る。UTC で切ると深夜帯が前日に落ちる。
-- visitor_key は端末内乱数 ID のハッシュ（IP/UA は保存も派生もしない）。timestamps は app 側（D2）。
-- 「訪問」= 同じ訪問者・同じ日・同じ流入元・同じページは 1 回（再読み込みで水増ししない）。
-- 公開ビーコンは匿名で叩けるため、lp_ingest_days の日次上限で共有 D1 の書き込み枠を守る。

CREATE TABLE IF NOT EXISTS lp_links (
  id          TEXT PRIMARY KEY,                    -- prefix-ULID (newId("lnk"))
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,                       -- 表示名（例: Instagram 告知投稿）
  slug        TEXT NOT NULL,                       -- utm_source の値（小文字正規化済み）
  active      INTEGER NOT NULL CHECK (active BETWEEN 0 AND 1),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 同じ流入元が 2 行に割れないよう org 内で slug は一意。
CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_links_org_slug ON lp_links(org_id, slug);

CREATE TABLE IF NOT EXISTS lp_visits (
  id             TEXT PRIMARY KEY,                 -- prefix-ULID (newId("lpv"))
  org_id         TEXT NOT NULL,
  link_id        TEXT,                             -- 一致した lp_links.id（無ければ NULL）
  source         TEXT NOT NULL,                    -- 正規化済み utm_source / 'direct'
  lp_version     TEXT,
  path           TEXT NOT NULL,
  referrer_host  TEXT,
  country        TEXT,
  device         TEXT NOT NULL CHECK (device IN ('mobile', 'desktop', 'bot', 'unknown')),
  kind           TEXT NOT NULL CHECK (kind IN ('redirect', 'ingest')), -- redirect = 発行済み流入URL経由
  visitor_key    TEXT NOT NULL,                    -- 匿名訪問者キー（一意訪問者の数え上げ用）
  day_jst        TEXT NOT NULL,                    -- YYYY-MM-DD (Asia/Tokyo)
  occurred_at    TEXT NOT NULL
);

-- 期間集計（範囲スキャン）と生ログ（(day_jst, id) の逆順走査で LIMIT 早期終了）を 1 本で賄う。
-- index は書き込み行数を増やす（D1 は index 更新も課金行）ので、使わない index は張らない。
CREATE INDEX IF NOT EXISTS idx_lp_visits_org_day ON lp_visits(org_id, day_jst, id);
-- 再読み込みの重複を INSERT 時に捨てる（ON CONFLICT DO NOTHING）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_visits_dedupe ON lp_visits(visitor_key, day_jst, source, path);

-- 日ごとの取り込み件数（上限判定用・1 日 1 行）。
CREATE TABLE IF NOT EXISTS lp_ingest_days (
  day_jst     TEXT PRIMARY KEY,
  recorded    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
