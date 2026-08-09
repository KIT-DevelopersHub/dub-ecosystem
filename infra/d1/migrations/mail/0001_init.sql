-- mail-gateway service (#15) — mail_ namespace. Owns the thin adapter's state:
-- the outbound idempotent send-log (二重送信ゼロ), the inbound normalized-message
-- table (受信取りこぼしゼロ; message_id UNIQUE = redelivery dedup, also backs
-- GET /messages), and a light mailbox registry.
-- created_at/updated_at are stamped app-side (nowIso); DDL DEFAULT on timestamps is
-- banned (theme3 D2). Body content is NOT persisted (frozen MailMessage carries no
-- body field — snippet only; 正本は送信=managed provider / 受信=Email Routing).

-- Outbound send log: one row per idempotency key. UNIQUE(idempotency_key) makes
-- concurrent/replayed sends collapse to a single delivery.
CREATE TABLE IF NOT EXISTS mail_send_log (
  id                  TEXT PRIMARY KEY,              -- prefix-ULID (newId("maillog"))
  idempotency_key     TEXT NOT NULL UNIQUE,          -- x-dub-idempotency-key
  req_hash            TEXT NOT NULL,                 -- FNV-1a of the request (conflict detection)
  requester           TEXT NOT NULL,                 -- x-dub-caller (service) or user id
  to_json             TEXT NOT NULL,                 -- JSON MailAddress[]
  subject             TEXT NOT NULL,
  thread_id           TEXT,
  provider            TEXT,                          -- 'ses' | 'mailchannels' | 'resend'
  provider_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','failed')),
  error_code          TEXT,                          -- @dub/errors code when failed
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_send_log_created ON mail_send_log(created_at);
CREATE INDEX IF NOT EXISTS idx_mail_send_log_status  ON mail_send_log(status, updated_at);

-- Inbound normalized messages. message_id (RFC Message-Id) is the dedup key: an
-- Email-Routing redelivery INSERT OR IGNOREs to a no-op. Reconstructs the frozen
-- MailMessage DTO in full (no body field exists on it — snippet suffices).
CREATE TABLE IF NOT EXISTS mail_inbound (
  id             TEXT PRIMARY KEY,                   -- prefix-ULID (newId("mailin"))
  message_id     TEXT NOT NULL UNIQUE,               -- RFC Message-Id = dedup key
  thread_id      TEXT NOT NULL,
  mailbox        TEXT,                               -- destination mailbox id (best-effort)
  from_json      TEXT NOT NULL,                      -- JSON MailAddress
  to_json        TEXT NOT NULL,                      -- JSON MailAddress[]
  subject        TEXT NOT NULL,
  snippet        TEXT NOT NULL,
  auto_submitted TEXT,                               -- Auto-Submitted header (loop hint)
  loop_marker    TEXT,                               -- X-Dub-Mail-Loop header (loop hint)
  received_at    TEXT NOT NULL,                      -- ISO8601
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_inbound_thread  ON mail_inbound(thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_mail_inbound_created ON mail_inbound(created_at);

-- Light mailbox registry (managed addresses). watch/history columns retired with the
-- 9-B pivot to Email Routing (no Gmail watch); kept minimal per the frozen Mailbox STUB.
CREATE TABLE IF NOT EXISTS mail_mailboxes (
  id         TEXT PRIMARY KEY,                       -- e.g. 'info'
  address    TEXT NOT NULL UNIQUE,                   -- e.g. 'info@developershub.jp'
  provider   TEXT NOT NULL DEFAULT 'cf-email-routing',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
