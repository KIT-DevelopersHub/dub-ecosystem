-- mail-gateway (#15) — inbox detail slice (統合波 next slice). Additive, forward-only.
-- Adds body persistence + per-message read-state to mail_inbound so the fe2 inbox can
-- open a message (full body), render text/HTML safely, and show an unread badge.
--   body_text : plain-text body extracted from the raw RFC822 message (best-effort).
--   html_body : HTML part when present (NULL otherwise); sanitized before render.
--   read_at   : ISO8601 stamp when first opened; NULL = unread (drives the badge).
-- All nullable (existing rows backfill to NULL = unread, empty body). No timestamp
-- DEFAULT (theme3 D2); read_at is stamped app-side (nowIso) on the mark-read call.
ALTER TABLE mail_inbound ADD COLUMN body_text TEXT;
ALTER TABLE mail_inbound ADD COLUMN html_body TEXT;
ALTER TABLE mail_inbound ADD COLUMN read_at TEXT;
