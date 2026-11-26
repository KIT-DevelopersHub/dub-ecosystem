-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on (#850): each member's times channel in Dub chat, one row per Dub user.
-- Written by src/times.ts when it creates the channel ('created', owner = the member) or finds
-- a channel with the planned name the member already owns ('existing'). A row = "this member
-- has a times channel": the auto trigger and the bulk action skip recorded users.
-- channel_name is UNIQUE per org so two members whose names slug the same get a suffix
-- (-2, -3, ...). The row is reserved before the channel is created (channel_id '' until then)
-- so concurrent runs cannot create two channels. Timestamps are app-supplied (D2).
CREATE TABLE chat_times (
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('created','existing')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE UNIQUE INDEX idx_chat_times_name ON chat_times(org_id, channel_name);
