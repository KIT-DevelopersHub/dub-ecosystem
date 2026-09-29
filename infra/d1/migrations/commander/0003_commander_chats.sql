-- commander (Commander app) — AI chat persistence in the commander_ namespace on the
-- shared dub-core D1 (in practice the LOCAL dev D1; commander-service runs local-only).
-- Persists the "Dubに聞く" (kind='ask') and "Dubを操作" (kind='operate') chat sessions +
-- messages so history survives daemon/web/service restarts. "履歴をクリア" = PHYSICAL
-- delete (rows removed; no soft-delete). Additive + idempotent (IF NOT EXISTS).
-- created_at/updated_at are stamped app-side (nowIso); DDL DEFAULT on timestamps is banned.

-- One chat session (a single conversation thread). Multiple per kind => the UI's tabs.
CREATE TABLE IF NOT EXISTS commander_chat_sessions (
  id         TEXT PRIMARY KEY,               -- prefix-ULID ("chat_…")
  kind       TEXT NOT NULL CHECK (kind IN ('ask','operate')),
  title      TEXT NOT NULL,                  -- derived from the first user message
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_chat_sessions_kind
  ON commander_chat_sessions(kind, updated_at DESC);

-- Messages within a session. `tools` is a JSON array of tool-activity labels (assistant
-- only); `seq` is the 1-based order within the session. Assistant rows may be finalized
-- (status streaming -> done/error) as a run completes.
CREATE TABLE IF NOT EXISTS commander_chat_messages (
  id         TEXT PRIMARY KEY,               -- prefix-ULID ("cmsg_…")
  session_id TEXT NOT NULL REFERENCES commander_chat_sessions(id),
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text       TEXT NOT NULL,
  tools      TEXT NOT NULL,                  -- JSON array (string[])
  status     TEXT NOT NULL CHECK (status IN ('streaming','done','error')),
  seq        INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_chat_messages_session
  ON commander_chat_messages(session_id, seq);
