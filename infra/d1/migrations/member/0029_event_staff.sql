-- namespace: member | owner: member-service. Additive: 運営メンバー per event.
-- The roster (member_people) and the 班 (member_teams) stay ONE org-wide list; an event
-- SELECTS its staff and its 班 from them here — nothing is duplicated. event_id is the
-- event-service id (opaque string, no cross-namespace FK). Roles stay org-wide.
-- IF NOT EXISTS: re-runnable. Existing data is not touched (the backfill is separate).
CREATE TABLE IF NOT EXISTS member_event_people (
  event_id  TEXT NOT NULL,
  person_id TEXT NOT NULL,
  added_by  TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (event_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_member_event_people_person ON member_event_people(person_id);
CREATE TABLE IF NOT EXISTS member_event_teams (
  event_id TEXT NOT NULL,
  team_id  TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_member_event_teams_team ON member_event_teams(team_id);
