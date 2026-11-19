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

// Physical twin: infra/d1/migrations/driveshare/0004_meeting_attendance.sql (lockstep test).
// 定例の出席: 定例 flags, manual / Dub-join records, ingested Meet participants, the ingest ledger,
// Google account id -> member links, and the attendance threshold. No FK to the meeting.
export const DRIVESHARE_ATTENDANCE_MIGRATION: Migration = {
  namespace: "driveshare",
  id: "0004_meeting_attendance",
  up: `
CREATE TABLE driveshare_meeting_regulars (
  meeting_id TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  enabled_by TEXT NOT NULL,
  enabled_at TEXT NOT NULL
);
CREATE TABLE driveshare_meeting_attendance (
  meeting_id      TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('present','excused','absent')),
  source          TEXT NOT NULL CHECK (source IN ('join','manual')),
  joined_at       TEXT,
  recorded_by     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (meeting_id, occurrence_date, user_id, source)
);
CREATE INDEX idx_driveshare_attendance_org_date ON driveshare_meeting_attendance(org_id, occurrence_date);
CREATE TABLE driveshare_meet_participants (
  meeting_id       TEXT NOT NULL,
  occurrence_date  TEXT NOT NULL,
  participant_key  TEXT NOT NULL,
  org_id           TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('signed_in','anonymous','phone')),
  google_user_id   TEXT,
  display_name     TEXT NOT NULL,
  first_join       TEXT NOT NULL,
  last_leave       TEXT,
  duration_seconds INTEGER NOT NULL,
  approx           INTEGER NOT NULL,
  ingested_at      TEXT NOT NULL,
  PRIMARY KEY (meeting_id, occurrence_date, participant_key)
);
CREATE INDEX idx_driveshare_meet_participants_org_date ON driveshare_meet_participants(org_id, occurrence_date);
CREATE TABLE driveshare_meet_ingests (
  meeting_id      TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('done','no_conference','error')),
  conferences     INTEGER NOT NULL,
  participants    INTEGER NOT NULL,
  attempts        INTEGER NOT NULL,
  last_error      TEXT,
  ingested_at     TEXT NOT NULL,
  PRIMARY KEY (meeting_id, occurrence_date)
);
CREATE TABLE driveshare_google_identity_links (
  org_id         TEXT NOT NULL,
  google_user_id TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('self','confirmed')),
  linked_by      TEXT NOT NULL,
  linked_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, google_user_id)
);
CREATE INDEX idx_driveshare_google_links_user ON driveshare_google_identity_links(org_id, user_id);
CREATE TABLE driveshare_attendance_settings (
  org_id      TEXT PRIMARY KEY,
  min_percent INTEGER NOT NULL CHECK (min_percent BETWEEN 1 AND 100),
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`.trim(),
};

// Physical twin: infra/d1/migrations/driveshare/0005_google_api_usage.sql (lockstep test).
// Calendar / Meet calls per UTC minute, read by usage-meter for the 無料枠 dashboard.
export const DRIVESHARE_GOOGLE_API_USAGE_MIGRATION: Migration = {
  namespace: "driveshare",
  id: "0005_google_api_usage",
  up: `
CREATE TABLE driveshare_google_api_usage (
  api    TEXT NOT NULL CHECK (api IN ('calendar','meet')),
  minute TEXT NOT NULL,
  calls  INTEGER NOT NULL,
  PRIMARY KEY (api, minute)
);
`.trim(),
};

// Physical twin: infra/d1/migrations/driveshare/0006_meeting_targets.sql (lockstep test).
// 複数の対象: a meeting invites the union of its targets (全体 / roles / members). Additive: the
// meeting's target_id stays (its calendar), and the backfill copies it as the first target.
export const DRIVESHARE_MEETING_TARGETS_MIGRATION: Migration = {
  namespace: "driveshare",
  id: "0006_meeting_targets",
  up: `
CREATE TABLE driveshare_meeting_targets (
  org_id     TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('all','role','person')),
  target_id  TEXT NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, kind, target_id)
);
CREATE INDEX idx_driveshare_meeting_targets_org ON driveshare_meeting_targets(org_id, meeting_id);
INSERT OR IGNORE INTO driveshare_meeting_targets (org_id, meeting_id, kind, target_id, position)
SELECT org_id, id, CASE WHEN target_id = 'all' THEN 'all' ELSE 'role' END, target_id, 0
  FROM driveshare_meetings;
`.trim(),
};
