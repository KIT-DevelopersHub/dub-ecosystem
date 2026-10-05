-- One-off backfill: fill mail_inbound.owner_user_id for messages that were ingested
-- while owner resolution read the To: header only. A message addressed To: an external
-- party with our address in CC/BCC got owner_user_id = NULL and is therefore invisible
-- to every account (fail-closed). The envelope recipient was captured correctly in
-- `mailbox` (local-part), so the owner can be recovered from it after the fact.
--
-- NOT a migration: this is data repair for rows already in prod, so it lives here and is
-- run by hand (once) rather than from infra/d1/migrations. It is idempotent -- it only
-- touches rows that are still NULL -- so a re-run is a no-op.
--
-- Scope guard: the join is on the local-part of an active identity_users email in the
-- developershub.jp domain. A mailbox with no matching active roster user stays NULL
-- (shared alias / departed member) rather than being guessed at -- never widen the mail
-- visibility boundary on a guess.
--
-- RUN (requires explicit owner approval -- do NOT run unprompted):
--   1. dry run, count first:
--      wrangler d1 execute dub-identity --remote --command "$(cat <<'SQL'
--      SELECT i.id, i.mailbox, u.id AS would_set
--        FROM mail_inbound i
--        LEFT JOIN identity_users u
--          ON u.status = 'active'
--         AND lower(u.email) = lower(i.mailbox) || '@developershub.jp'
--       WHERE i.owner_user_id IS NULL;
--      SQL
--      )"
--   2. apply this file:
--      wrangler d1 execute dub-identity --remote --file services/mail-gateway/scripts/backfill-inbound-owner.sql
--   3. verify no recoverable rows remain (expect 0):
--      wrangler d1 execute dub-identity --remote --command \
--        "SELECT COUNT(*) FROM mail_inbound WHERE owner_user_id IS NULL AND mailbox IS NOT NULL;"
--
-- Use the same database the mail-gateway Worker's DB binding points at (prod: the
-- aggregated infra/d1 database that holds both mail_ and identity_ tables).

UPDATE mail_inbound
   SET owner_user_id = (
         SELECT u.id
           FROM identity_users u
          WHERE u.status = 'active'
            AND lower(u.email) = lower(mail_inbound.mailbox) || '@developershub.jp'
          LIMIT 1
       )
 WHERE owner_user_id IS NULL
   AND mailbox IS NOT NULL
   AND mailbox <> ''
   AND EXISTS (
         SELECT 1
           FROM identity_users u
          WHERE u.status = 'active'
            AND lower(u.email) = lower(mail_inbound.mailbox) || '@developershub.jp'
       );
