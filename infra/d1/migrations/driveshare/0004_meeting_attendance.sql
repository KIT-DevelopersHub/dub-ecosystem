-- namespace: driveshare | owner: drive-share-service (カレンダー > ミーティング → 人事 > 出席)
-- 定例の出席. A meeting listed in driveshare_meeting_regulars is a 定例 (全体定例 when its target
-- is 'all', else チーム定例). A member who opens its Meet from Dub during an occurrence is recorded
-- present for that occurrence (JST date); 人事 can set / clear records by hand.
-- Additive only: no existing table changes. No FK to driveshare_meetings on purpose — attendance
-- is 人事 history and must survive the meeting being deleted (mirrored from Google Calendar).
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
  status          TEXT NOT NULL CHECK (status IN ('present','excused')),
  source          TEXT NOT NULL CHECK (source IN ('join','manual')),
  joined_at       TEXT,
  recorded_by     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (meeting_id, occurrence_date, user_id)
);
CREATE INDEX idx_driveshare_attendance_org_date ON driveshare_meeting_attendance(org_id, occurrence_date);
