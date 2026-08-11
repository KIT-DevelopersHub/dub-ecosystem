-- mail-gateway (#15) — DEMO RESET (DESTRUCTIVE). Wipes every mail MESSAGE row so the
-- inbox + Sent folders return to a clean, empty initial state for a demo/screenshot.
--
-- WARNING: This DELETES ALL rows from mail_inbound and mail_send_log. There is NO undo.
-- It is intended for the DEPLOY OWNER to run against a demo/staging database only, to
-- clear the "weird demo mails" (leftover smoke-test sends + test receives) that are LIVE
-- rows in D1 (not seed code). Do NOT run this casually against a database that holds real
-- received or sent mail.
--
-- Scope: messages only. The mailbox registry (mail_mailboxes) and Email Routing address
-- config are NOT touched — clearing messages must never de-provision addresses.
--
-- Dry run first (local copy, no remote writes):
--   wrangler d1 execute dub-core --local --file=db/reset-demo.sql
-- Apply to the remote demo DB (deploy owner only; see services/mail-gateway/README.md):
--   wrangler d1 execute dub-core --remote --file=db/reset-demo.sql

DELETE FROM mail_inbound;
DELETE FROM mail_send_log;
