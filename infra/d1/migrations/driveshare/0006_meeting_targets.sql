-- namespace: driveshare | owner: drive-share-service (カレンダー > ミーティング: 複数の対象)
-- A meeting invites the union of one or more targets: 全体 ('all'), roles, and individual members
-- ('person' = userId). The event stays on ONE calendar, driveshare_meetings.target_id
-- (meeting.calendarTargetOf: 全体 if a target, else the first role, else the unshared 個別
-- calendar 'people'); that column is kept as is, so a worker from before this migration keeps
-- working. A meeting with no rows here reads as its target_id alone (read fallback).
-- No FK to driveshare_meetings on purpose: a worker from before this migration deletes a meeting
-- without knowing this table, and an FK would make that delete fail. Orphans are harmless.
CREATE TABLE driveshare_meeting_targets (
  org_id     TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('all','role','person')),
  target_id  TEXT NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, kind, target_id)
);
CREATE INDEX idx_driveshare_meeting_targets_org ON driveshare_meeting_targets(org_id, meeting_id);

-- Backfill: every existing meeting's single target becomes its first (only) target row.
INSERT OR IGNORE INTO driveshare_meeting_targets (org_id, meeting_id, kind, target_id, position)
SELECT org_id, id, CASE WHEN target_id = 'all' THEN 'all' ELSE 'role' END, target_id, 0
  FROM driveshare_meetings;
