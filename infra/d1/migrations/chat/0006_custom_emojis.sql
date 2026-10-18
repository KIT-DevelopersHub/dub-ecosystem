-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on: workspace custom emoji (Slack import first; member upload later).
-- A reaction stores the literal ":name:" (chat_reactions.emoji), so a row here is what turns
-- that text into an image. An image row owns an object in R2 dub-file-attachments under
-- `custom-emoji/<name>` (original bytes + content type); an alias row owns no image and renders
-- its alias_of target. Timestamps are app-supplied (no DDL DEFAULT datetime, D2).
CREATE TABLE chat_custom_emojis (
  name         TEXT PRIMARY KEY,
  r2_key       TEXT,
  content_type TEXT,
  alias_of     TEXT,
  source       TEXT NOT NULL CHECK (source IN ('slack','upload')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK ((alias_of IS NULL AND r2_key IS NOT NULL AND content_type IS NOT NULL)
      OR (alias_of IS NOT NULL AND r2_key IS NULL AND content_type IS NULL))
);
