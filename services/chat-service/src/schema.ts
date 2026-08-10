// D1 schema for the `chat` namespace (design §3). DRAFT: frozen only after 9-C
// (theme11/theme12). The physical migration file belongs in
// infra/d1/migrations/chat/0001_init.sql (owned by infra-d1-seed #28 — NOT
// created here to respect unit boundaries). No FK to other namespaces (chat is
// the DB-split first candidate): user/event/file ids are plain references.
// Timestamps are app-supplied (nowIso); DDL DEFAULT for datetime is banned (D2).
import type { Migration } from "@dub/db";

export const CHAT_SCHEMA_MIGRATION: Migration = {
  namespace: "chat",
  id: "0001_init",
  up: `
CREATE TABLE chat_channels (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('event','topic','dm')),
  visibility  TEXT NOT NULL CHECK (visibility IN ('public','private')),
  name        TEXT NOT NULL,
  topic       TEXT,
  event_id    TEXT,
  dm_key      TEXT UNIQUE,
  created_by  TEXT NOT NULL,
  archived_at TEXT,
  version     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_chat_channels_event ON chat_channels(event_id);
CREATE INDEX idx_chat_channels_visibility ON chat_channels(visibility) WHERE archived_at IS NULL;

CREATE TABLE chat_channel_members (
  channel_id TEXT NOT NULL REFERENCES chat_channels(id),
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin','member')),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_chat_members_user ON chat_channel_members(user_id);

CREATE TABLE chat_messages (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES chat_channels(id),
  thread_root_id      TEXT,
  author_id           TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('user','system')),
  body                TEXT NOT NULL,
  attachment_file_ids TEXT NOT NULL,
  version             INTEGER NOT NULL,
  edited_at           TEXT,
  deleted_at          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_channel ON chat_messages(channel_id, id DESC);
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_root_id, id);

CREATE TABLE chat_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  emoji      TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, emoji, user_id)
);

CREATE TABLE chat_read_states (
  channel_id           TEXT NOT NULL REFERENCES chat_channels(id),
  user_id              TEXT NOT NULL,
  last_read_message_id TEXT,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
`.trim(),
};

// Slack-parity backend tables (pins + presence). A SEPARATE migration id so 0001 is
// never mutated after apply (migration immutability); infra-d1-seed materializes both
// physical files. Search re-uses chat_messages (LIKE keyset scan) — no new table.
// Timestamps are app-supplied (D2); no FK to other namespaces (chat DB-split rule).
export const CHAT_SLACK_PARITY_MIGRATION: Migration = {
  namespace: "chat",
  id: "0002_slack_parity",
  up: `
CREATE TABLE chat_pins (
  channel_id TEXT NOT NULL REFERENCES chat_channels(id),
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  pinned_by  TEXT NOT NULL,
  pinned_at  TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
CREATE INDEX idx_chat_pins_channel ON chat_pins(channel_id, pinned_at DESC);

CREATE TABLE chat_presence (
  user_id           TEXT PRIMARY KEY,
  presence          TEXT NOT NULL CHECK (presence IN ('auto','away')),
  status_emoji      TEXT,
  status_text       TEXT,
  status_expires_at TEXT,
  last_active_at    TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
`.trim(),
};
