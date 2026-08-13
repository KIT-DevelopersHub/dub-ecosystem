-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on for Slack-parity pinned messages. Additive: no change to 0001
-- tables, so the applied 0001 ledger hash is untouched (no DB_MIGRATION_DRIFT). No
-- cross-namespace FK; pinned_by/pinned_at are app-supplied (no DDL DEFAULT datetime, D2).
CREATE TABLE chat_pins (
  channel_id TEXT NOT NULL REFERENCES chat_channels(id),
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  pinned_by  TEXT NOT NULL,
  pinned_at  TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
CREATE INDEX idx_chat_pins_channel ON chat_pins(channel_id, message_id DESC);
