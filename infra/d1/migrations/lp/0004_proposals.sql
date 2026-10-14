-- lp-analytics service — lp_ namespace. 公開 LP の登壇者募集（/proposals）。
-- lp_proposal_settings = サイトごとに 1 行。募集 on/off（lp:publish 必須）と追加の入力項目（JSON）。
--   fields_json が NULL = まだ保存していない（サービス側の既定の項目を使う）。
-- lp_proposals         = 応募 1 件。氏名・メール・タイトル・概要は固定列、追加項目は label ごと JSON。
--   status: submitted（未対応） / accepted（採択） / rejected（見送り）。LP管理 で切り替える。
--   client_key = 送信元 IP のハッシュ（LP Worker が計算・生 IP は保存しない）。同じ送信元の 1 日の上限に使う。
-- 追加のみ・冪等（IF NOT EXISTS）。site は lp_publish と同じキー（例: hokuriku-it-conf.com）。

CREATE TABLE IF NOT EXISTS lp_proposal_settings (
  site         TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 0,
  fields_json  TEXT,                                -- LpTicketField[]（固定項目は含めない）。NULL = 既定
  updated_by   TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lp_proposals (
  id            TEXT PRIMARY KEY,
  site          TEXT NOT NULL,
  speaker_name  TEXT NOT NULL,
  email         TEXT NOT NULL,
  title         TEXT NOT NULL,
  abstract      TEXT NOT NULL,
  answers_json  TEXT NOT NULL DEFAULT '[]',         -- [{fieldId,label,value}]
  status        TEXT NOT NULL DEFAULT 'submitted',  -- 'submitted' | 'accepted' | 'rejected'
  reviewed_by   TEXT,
  client_key    TEXT,                               -- 送信元のハッシュ。NULL = 不明
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 応募一覧（新しい順）と 1 日の応募上限の数え上げ。
CREATE INDEX IF NOT EXISTS idx_lp_proposals_created ON lp_proposals(site, created_at);
-- 同じ送信元からの 1 日の応募数。
CREATE INDEX IF NOT EXISTS idx_lp_proposals_client ON lp_proposals(site, client_key, created_at);
