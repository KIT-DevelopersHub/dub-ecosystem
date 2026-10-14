-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on for personal sidebar sections (Slack-style). Additive: no change to
-- 0001-0003 tables. Each user owns their own sections; a channel is in at most one of the
-- user's sections (PK user_id+channel_id). Same-namespace FKs only; timestamps are
-- app-supplied (no DDL DEFAULT datetime, D2).
CREATE TABLE chat_sections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chat_sections_user ON chat_sections(user_id, position);
CREATE TABLE chat_channel_sections (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES chat_channels(id),
  section_id TEXT NOT NULL REFERENCES chat_sections(id),
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX idx_chat_channel_sections_section ON chat_channel_sections(section_id);
