// D1 schema for the `driveshare` namespace. Semantic source of truth for the physical
// migration applied from infra/d1/migrations/driveshare/0001_init.sql. The two MUST stay
// in lockstep (test/schema-lockstep.test.ts) — change this const and that .sql together.
//
// This service otherwise owns NO domain data (Google Drive holds the files/permissions);
// these two tables are only the role→file grant index and the provenance ledger of the
// Drive permissions WE created, so revoke/reconcile never touches individual shares.
import type { Migration } from "@dub/db";

export const DRIVESHARE_SCHEMA_MIGRATION: Migration = {
  namespace: "driveshare",
  id: "0001_init",
  up: `
CREATE TABLE driveshare_role_file_grants (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  drive_role TEXT NOT NULL CHECK (drive_role IN ('reader','commenter','writer')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, file_id, role_id)
);
CREATE INDEX idx_driveshare_grants_org ON driveshare_role_file_grants(org_id);
CREATE INDEX idx_driveshare_grants_file ON driveshare_role_file_grants(org_id, file_id);
CREATE TABLE driveshare_role_grant_members (
  grant_id      TEXT NOT NULL REFERENCES driveshare_role_file_grants(id),
  email         TEXT NOT NULL,
  permission_id TEXT,
  created_by_us INTEGER NOT NULL,
  PRIMARY KEY (grant_id, email)
);
CREATE INDEX idx_driveshare_grant_members_grant ON driveshare_role_grant_members(grant_id);
`.trim(),
};

// Physical twin: infra/d1/migrations/driveshare/0002_google_account.sql (lockstep test).
// The registered Google accounts (encrypted refresh tokens), which one is in use, and
// pending OAuth states.
export const DRIVESHARE_GOOGLE_ACCOUNT_MIGRATION: Migration = {
  namespace: "driveshare",
  id: "0002_google_account",
  up: `
CREATE TABLE driveshare_google_accounts (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  email          TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  token_cipher   TEXT NOT NULL,
  token_iv       TEXT NOT NULL,
  connected_by   TEXT NOT NULL,
  connected_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (org_id, email)
);
CREATE TABLE driveshare_google_active_account (
  org_id       TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES driveshare_google_accounts(id),
  switched_by  TEXT NOT NULL,
  switched_at  TEXT NOT NULL
);
CREATE TABLE driveshare_google_oauth_states (
  state        TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX idx_driveshare_google_oauth_states_expires ON driveshare_google_oauth_states(expires_at);
`.trim(),
};

// Physical twin: infra/d1/migrations/driveshare/0003_meetings.sql (lockstep test).
// カレンダー > ミーティング: per-target calendars, meetings, and the ledgers of the attendees /
// calendar shares we added.
export const DRIVESHARE_MEETINGS_MIGRATION: Migration = {
  namespace: "driveshare",
  id: "0003_meetings",
  up: `
CREATE TABLE driveshare_meeting_calendars (
  org_id      TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, target_id, account_id)
);
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
CREATE TABLE driveshare_meeting_invites (
  meeting_id TEXT NOT NULL REFERENCES driveshare_meetings(id),
  email      TEXT NOT NULL,
  user_id    TEXT,
  PRIMARY KEY (meeting_id, email)
);
CREATE TABLE driveshare_meeting_calendar_acl (
  org_id      TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  email       TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  PRIMARY KEY (org_id, calendar_id, email)
);
`.trim(),
};
