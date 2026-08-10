-- mail-gateway (#15) — Gmail-parity操作系 slice. Additive, forward-only. Mirror of
-- infra/d1/migrations/mail/0003_gmail_ops.sql (kept byte-identical; infra #28 is the
-- 正本 / runner, this copy backs the in-memory test schema in test/d1.ts).
-- Adds the state a Gmail-clone inbox needs on top of the frozen inbound/send tables:
--   ・per-message flags (star / archive / trash) as nullable ISO8601 stamps on
--     mail_inbound (NULL = not-in-that-state; a stamp = when it entered it).
--   ・a label registry (mail_labels) + message⇄label join (mail_message_labels).
--   ・a compose drafts table (mail_drafts).
--   ・a self-built D1 outbox (mail_outbox) — the async fan-out buffer for mutation
--     audit records, drained by the daily cron. This is the "@dub/freeq" free-queue
--     pattern: persistence in D1, ZERO new Cloudflare Queues (paid) added.
-- No timestamp DDL DEFAULT (theme3 D2); every *_at is stamped app-side (nowIso).

-- ---- per-message flags on mail_inbound (all nullable; existing rows backfill NULL) ----
ALTER TABLE mail_inbound ADD COLUMN starred_at  TEXT; -- ISO8601 when starred; NULL = not starred
ALTER TABLE mail_inbound ADD COLUMN archived_at TEXT; -- ISO8601 when archived (out of Inbox); NULL = in Inbox
ALTER TABLE mail_inbound ADD COLUMN trashed_at  TEXT; -- ISO8601 when trashed; NULL = not in Trash

CREATE INDEX IF NOT EXISTS idx_mail_inbound_starred  ON mail_inbound(starred_at);
CREATE INDEX IF NOT EXISTS idx_mail_inbound_archived ON mail_inbound(archived_at);
CREATE INDEX IF NOT EXISTS idx_mail_inbound_trashed  ON mail_inbound(trashed_at);

-- ---- label registry (org-shared, like Gmail's labels) ----
CREATE TABLE IF NOT EXISTS mail_labels (
  id         TEXT PRIMARY KEY,             -- prefix-ULID (newId("maillbl"))
  name       TEXT NOT NULL UNIQUE,         -- display name (case-sensitive, unique)
  color      TEXT,                         -- hex like "#4285F4" (NULL = default/no color)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---- message ⇄ label (many-to-many). Applying an already-applied label is a no-op. ----
CREATE TABLE IF NOT EXISTS mail_message_labels (
  message_id TEXT NOT NULL,                -- mail_inbound.id
  label_id   TEXT NOT NULL,                -- mail_labels.id
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_msg_labels_label ON mail_message_labels(label_id);
CREATE INDEX IF NOT EXISTS idx_mail_msg_labels_msg   ON mail_message_labels(message_id);

-- ---- compose drafts (saved-but-not-sent). Sending a draft = send + delete the draft. ----
CREATE TABLE IF NOT EXISTS mail_drafts (
  id          TEXT PRIMARY KEY,            -- prefix-ULID (newId("maildft"))
  to_json     TEXT NOT NULL,               -- JSON MailAddress[] (may be [])
  cc_json     TEXT,                        -- JSON MailAddress[] or NULL
  subject     TEXT NOT NULL,               -- may be "" while drafting
  text_body   TEXT NOT NULL,               -- may be "" while drafting
  html_body   TEXT,                        -- optional rich body
  in_reply_to TEXT,                        -- Message-Id this draft replies to (thread ctx)
  thread_id   TEXT,                        -- thread the draft belongs to (reply drafts)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_drafts_updated ON mail_drafts(updated_at);

-- ---- self-built D1 outbox ("@dub/freeq"): async fan-out WITHOUT a paid Cloudflare
-- Queue. Mutation endpoints append a row here in the same request; the daily cron
-- (drainOutbox) claims pending rows and publishes them to the existing AUDIT_QUEUE.
-- A failed publish backs off (attempts++/next_attempt_at) instead of blocking the caller.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id              TEXT PRIMARY KEY,        -- prefix-ULID (newId("mailob"))
  kind            TEXT NOT NULL,           -- "audit" (only kind today; kept open)
  payload_json    TEXT NOT NULL,           -- JSON payload for the sink (AuditRecordInput)
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,           -- ISO8601; claim when <= now
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending ON mail_outbox(status, next_attempt_at);
