-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on (#850): each member's Slack times channel, one row per Dub user.
-- Written by src/slack-times.ts when the bot creates the channel ('created') or finds one
-- with the planned name already there ('existing'). A row = "this member has a times
-- channel": the auto trigger and the bulk action skip recorded users. channel_name is
-- UNIQUE per org so two members whose names slug the same get a suffix (-2, -3, ...).
-- Timestamps are app-supplied (no DDL DEFAULT datetime, D2).
CREATE TABLE chat_slack_times (
  org_id           TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  slack_user_id    TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  channel_name     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('created','existing')),
  created_at       TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE UNIQUE INDEX idx_chat_slack_times_name ON chat_slack_times(org_id, channel_name);
