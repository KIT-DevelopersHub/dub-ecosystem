-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on for the in-app Slack channel import (fe6-chat 「チャンネル取り込み」).
-- One row per (org, Slack channel): the resumable step job's cursor + progress. Each step
-- writes its data rows AND advances this row in ONE D1 batch, so a step is all-or-nothing.
-- lease_token/lease_until stop two browser tabs from stepping the same job at once.
-- state/counters are JSON text. Timestamps are app-supplied (no DDL DEFAULT datetime, D2).
CREATE TABLE chat_slack_import_jobs (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  slack_channel_id   TEXT NOT NULL,
  slack_channel_name TEXT NOT NULL,
  is_private         INTEGER NOT NULL,
  dub_channel_id     TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  phase              TEXT NOT NULL,
  state              TEXT NOT NULL,
  counters           TEXT NOT NULL,
  error_code         TEXT,
  error_message      TEXT,
  next_run_at        TEXT,
  lease_token        TEXT,
  lease_until        TEXT,
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  finished_at        TEXT
);
CREATE UNIQUE INDEX idx_chat_slack_import_jobs_channel ON chat_slack_import_jobs(org_id, slack_channel_id);
CREATE INDEX idx_chat_slack_import_jobs_recent ON chat_slack_import_jobs(org_id, updated_at DESC);
