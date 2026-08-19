-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on: reaction-protection flag on the message deletion policy (誤削除防止).
-- When ON, a message that already has a reaction cannot be deleted by a non-moderator
-- (moderators / admin are exempt). Additive column with a non-datetime DEFAULT (0 = off),
-- so existing rows keep their behaviour (backward-compatible) and the applied 0003 ledger
-- hash is untouched (no DB_MIGRATION_DRIFT). Same-namespace only.
ALTER TABLE chat_settings ADD COLUMN protect_reacted INTEGER NOT NULL DEFAULT 0;
