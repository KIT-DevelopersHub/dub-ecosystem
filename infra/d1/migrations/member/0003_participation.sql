-- namespace: member | owner: member-service (参加届 / participation submissions)
-- 参加届: a person's self-submitted intent to join. Traced from leaders-meetup-bot's
-- `participation_forms`, mapped onto the DevHub member model. On submit the service
-- resolves this row to a `member_people` record (invited -> added, or a new added
-- person) so the roster reflects reality without a separate manual import step.
-- `normalized_name` is the space/width-folded key used for 表記ゆれ (name-variant)
-- matching and per-org dedupe. `member_id` links the resolved 運営メンバー.
-- All timestamps are app-set (nowIso), never via DDL DEFAULT (lint D2).
CREATE TABLE member_participations (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  member_id        TEXT REFERENCES member_people(id),
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  name_kana        TEXT,
  grade            TEXT,
  department       TEXT,
  contact          TEXT,
  desired_team_id  TEXT REFERENCES member_teams(id),
  desired_activity TEXT,
  note             TEXT,
  status           TEXT NOT NULL,
  match_kind       TEXT NOT NULL,
  submitted_by     TEXT NOT NULL,
  submitted_at     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_member_participations_org_norm ON member_participations(org_id, normalized_name);
CREATE INDEX idx_member_participations_org ON member_participations(org_id, submitted_at);
CREATE INDEX idx_member_participations_member ON member_participations(member_id);
