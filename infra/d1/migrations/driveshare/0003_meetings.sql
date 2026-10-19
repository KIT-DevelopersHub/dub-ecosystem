-- namespace: driveshare | owner: drive-share-service (カレンダー > ミーティング)
-- Meetings created on the shared Google account connected in Drive共有 > 設定. Each target (a
-- role, or 'all' = every active member) owns ONE secondary Google calendar on that account;
-- every meeting is an event on its target's calendar with a Meet link, and the target's
-- members are kept invited (reconciled hourly by the MeetingSyncDO alarm and on every write).
-- Google still holds the events themselves; these tables are the index + provenance ledgers
-- of the attendees / calendar shares WE added, so reconcile never removes a hand-added guest.
-- All timestamps are written by the service (nowIso), never via DDL DEFAULT (D2).

-- The target's calendar per Google account. account_id = the driveshare_google_accounts row
-- id, or 'secret' for the GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN fallback. Switching the shared
-- account therefore creates a fresh calendar on the new account.
CREATE TABLE driveshare_meeting_calendars (
  org_id      TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, target_id, account_id)
);

-- One row per meeting (= one Google event, recurring or not).
CREATE TABLE driveshare_meetings (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  calendar_id      TEXT NOT NULL,
  google_event_id  TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  starts_at        TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  recurrence       TEXT NOT NULL CHECK (recurrence IN ('none','weekly','biweekly','monthly_weekday')),
  until            TEXT,
  meet_url         TEXT,
  html_link        TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  synced_at        TEXT
);
CREATE INDEX idx_driveshare_meetings_org ON driveshare_meetings(org_id, starts_at);

-- Attendees WE invited (lowercased address). Reconcile removes only these.
CREATE TABLE driveshare_meeting_invites (
  meeting_id TEXT NOT NULL REFERENCES driveshare_meetings(id),
  email      TEXT NOT NULL,
  user_id    TEXT,
  PRIMARY KEY (meeting_id, email)
);

-- Calendar ACL rules (role reader) WE created on a target calendar. Reconcile removes only these.
CREATE TABLE driveshare_meeting_calendar_acl (
  org_id      TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  email       TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  PRIMARY KEY (org_id, calendar_id, email)
);
