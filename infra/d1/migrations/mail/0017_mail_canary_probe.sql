-- mail-gateway (本番の合成メール監視 / canary) — one row per synthetic probe.
-- Mirror of services/mail-gateway/db/0017_mail_canary_probe.sql (kept byte-identical;
-- infra is the 正本 / runner, the service copy backs the in-memory test schema).
-- Additive, forward-only; a new table only (no existing table is touched).
--
-- The cron (src/canary.ts) sends a real mail through the normal outbound path To=QA_A,
-- Cc=QA_B with a unique token in the subject, then on later ticks looks for it in
-- mail_inbound per recipient until the deadline. Timestamps are stamped app-side.
--   status        : pending (waiting for arrival) | ok | failed (finalized)
--   send_ok       : 1 = provider accepted the send, 0 = send itself failed
--   to_ok / cc_ok : 1/0 once finalized (NULL while pending) — that recipient's copy is in
--                   mail_inbound (matched by Message-ID or the subject token)
--   *_latency_ms  : first-seen ingest time minus sent_at for that recipient
--   notified      : 'alert' | 'recovered' when this probe raised a notification
CREATE TABLE IF NOT EXISTS mail_canary_probe (
  id             TEXT PRIMARY KEY,                  -- prefix-ULID (newId("mailcan"))
  token          TEXT NOT NULL UNIQUE,              -- uuid in the subject "[dub-canary] <token>"
  subject        TEXT NOT NULL,
  message_id     TEXT,                              -- RFC Message-Id returned by the send core
  to_address     TEXT NOT NULL,
  cc_address     TEXT NOT NULL,
  sent_at        TEXT NOT NULL,                     -- ISO8601
  send_ok        INTEGER NOT NULL,
  send_error     TEXT,                              -- @dub/errors code when send_ok = 0
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','ok','failed')),
  to_ok          INTEGER,
  cc_ok          INTEGER,
  to_latency_ms  INTEGER,
  cc_latency_ms  INTEGER,
  checked_at     TEXT,                              -- ISO8601 when finalized
  notified       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_canary_probe_status ON mail_canary_probe(status, sent_at);
CREATE INDEX IF NOT EXISTS idx_mail_canary_probe_sent   ON mail_canary_probe(sent_at);
