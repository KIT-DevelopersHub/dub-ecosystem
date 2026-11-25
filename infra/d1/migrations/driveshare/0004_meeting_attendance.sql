-- namespace: driveshare | owner: drive-share-service (カレンダー > ミーティング → 人事 > 出席)
-- 定例の出席. A meeting listed in driveshare_meeting_regulars is a 定例 (全体定例 when its target is
-- 'all', else チーム定例). Attendance is derived at read time from, strongest first:
--   driveshare_meeting_attendance  manual records by 人事 (source 'manual') and Dub joins ('join')
--   driveshare_meet_participants   Google Meet participant records ingested after each occurrence,
--                                  matched to members through driveshare_google_identity_links
-- Additive only: no existing table changes. No FK to driveshare_meetings on purpose — attendance is
-- 人事 history and must survive the meeting being deleted (mirrored from Google Calendar).
-- All timestamps are written by the service (nowIso), never via DDL DEFAULT (D2).

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

-- One row per Meet participant per occurrence (all conferences / sessions of that person merged).
-- participant_key = 'u:<google user id>' for signed-in users, else the participant resource name.
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

-- Which occurrences were read from Meet (idempotent re-runs, catch-up within Google's retention).
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

-- Google account id (users/{id} in Meet = the OIDC sub) -> Dub member. 'self' = the member's own
-- 「Googleと連携」; 'confirmed' = 人事 confirmed a Meet participant once.
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
