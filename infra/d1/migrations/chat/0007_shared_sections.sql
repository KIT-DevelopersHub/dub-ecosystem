-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on: ORG-WIDE sidebar sections (one shared set every member sees),
-- replacing the per-user sections of 0004. Additive: 0004's chat_sections /
-- chat_channel_sections stay in place but are no longer read or written (their rows are
-- simply not shown any more). A channel is in at most one shared section (PK channel_id).
-- Writes are gated by chat:manage_sections (identity/0024). Same-namespace FKs only;
-- timestamps are app-supplied (no DDL DEFAULT datetime, D2).
CREATE TABLE chat_shared_sections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chat_shared_sections_position ON chat_shared_sections(position);
CREATE TABLE chat_shared_channel_sections (
  channel_id TEXT PRIMARY KEY REFERENCES chat_channels(id),
  section_id TEXT NOT NULL REFERENCES chat_shared_sections(id)
);
CREATE INDEX idx_chat_shared_channel_sections_section ON chat_shared_channel_sections(section_id);
