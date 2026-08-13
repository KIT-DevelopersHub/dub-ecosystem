// D1 schema for the `member` namespace. Semantic source of truth for the physical
// migrations under infra/d1/migrations/member/. Each const MUST stay in lockstep with
// its .sql file (schema-lockstep.test.ts) — change the const and its .sql together, and
// keep MEMBER_MIGRATIONS ordered by id ascending (forward-only, one file per const).
import type { Migration } from "@dub/db";

export const MEMBER_SCHEMA_MIGRATION: Migration = {
  namespace: "member",
  id: "0001_init",
  up: `
CREATE TABLE member_teams (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT,
  description TEXT,
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_member_teams_org_key ON member_teams(org_id, key);
CREATE INDEX idx_member_teams_org ON member_teams(org_id, sort_order);
CREATE TABLE member_people (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  role_title  TEXT,
  status      TEXT NOT NULL,
  contact     TEXT,
  note        TEXT,
  sort_order  INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  archived_at TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_member_people_org ON member_people(org_id, sort_order) WHERE archived_at IS NULL;
CREATE TABLE member_team_links (
  person_id  TEXT NOT NULL REFERENCES member_people(id),
  team_id    TEXT NOT NULL REFERENCES member_teams(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_id, team_id)
);
CREATE INDEX idx_member_team_links_team ON member_team_links(team_id);
`.trim(),
};

// 学科(department)・学年(grade) を note(メモ) から専用カラムへ分離する非破壊 ALTER。
// 既存行を保持し NULL 許容カラムを足すだけ (mirrors 0002_person_dept_grade.sql).
export const MEMBER_PERSON_COLS_MIGRATION: Migration = {
  namespace: "member",
  id: "0002_person_dept_grade",
  up: `
ALTER TABLE member_people ADD COLUMN department TEXT;
ALTER TABLE member_people ADD COLUMN grade TEXT;
`.trim(),
};

/** All member migrations, forward-only, ordered by id ascending. */
export const MEMBER_MIGRATIONS: Migration[] = [MEMBER_SCHEMA_MIGRATION, MEMBER_PERSON_COLS_MIGRATION];
