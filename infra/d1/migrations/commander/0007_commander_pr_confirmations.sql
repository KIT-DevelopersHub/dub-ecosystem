-- commander — audit log of the 「確認」 button (additive). Every press records which PR /
-- head commit was approved for production (the `確認した` label), as which GitHub login,
-- with the CI summary at that moment, and the outcome — including refusals, so a blocked
-- attempt is as visible as a successful one. Append-only; nothing updates or deletes rows.
--   result : labeled | already_confirmed | refused | error
--   reason : refusal / error code (NULL when labeled)

CREATE TABLE IF NOT EXISTS commander_pr_confirmations (
  id            TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  pr_number     INTEGER NOT NULL,
  head_sha      TEXT,
  label         TEXT NOT NULL,
  github_login  TEXT,
  result        TEXT NOT NULL
                CHECK (result IN ('labeled', 'already_confirmed', 'refused', 'error')),
  reason        TEXT,
  checks_json   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_pr_confirmations_pr
  ON commander_pr_confirmations (repo, pr_number, created_at);
