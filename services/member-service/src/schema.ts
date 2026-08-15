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

// 0002: link a 運営メンバー to its identity-roster login account (RBAC 橋渡し).
// Additive ALTER — see infra/d1/migrations/member/0002_identity_link.sql (kept in
// lockstep by schema-lockstep.test.ts). Not a cross-namespace FK (ids stay strings).
export const MEMBER_IDENTITY_LINK_MIGRATION: Migration = {
  namespace: "member",
  id: "0002_identity_link",
  up: `
ALTER TABLE member_people ADD COLUMN identity_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_member_people_identity
  ON member_people(identity_user_id) WHERE identity_user_id IS NOT NULL;
`.trim(),
};

// 0003: 学科(department)・学年(grade) を note(メモ) から専用カラムへ分離する非破壊 ALTER。
// 既存行を保持し NULL 許容カラムを足すだけ (mirrors 0003_person_dept_grade.sql).
export const MEMBER_PERSON_COLS_MIGRATION: Migration = {
  namespace: "member",
  id: "0003_person_dept_grade",
  up: `
ALTER TABLE member_people ADD COLUMN department TEXT;
ALTER TABLE member_people ADD COLUMN grade TEXT;
`.trim(),
};

// 参加届 (participation submissions). Additive: a person's self-submitted intent to
// join, resolved to a member_people row on submit (invited -> added, or new added).
export const MEMBER_PARTICIPATION_MIGRATION: Migration = {
  namespace: "member",
  id: "0004_participation",
  up: `
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
`.trim(),
};

// 参加届: 学校メール + Gmail の2アドレス. Additive ALTER (non-destructive): both are
// required at the app layer but nullable in DDL (SQLite ADD COLUMN can't be NOT NULL
// without a default). Retained on member_people too so the roster keeps both channels.
export const MEMBER_PARTICIPATION_EMAILS_MIGRATION: Migration = {
  namespace: "member",
  id: "0005_participation_emails",
  up: `
ALTER TABLE member_participations ADD COLUMN school_email TEXT;
ALTER TABLE member_participations ADD COLUMN gmail TEXT;
ALTER TABLE member_people ADD COLUMN school_email TEXT;
ALTER TABLE member_people ADD COLUMN gmail TEXT;
`.trim(),
};

// All member-namespace migrations in apply order (mirrors infra/d1/migrations/member).
export const MEMBER_MIGRATIONS: readonly Migration[] = [
  MEMBER_SCHEMA_MIGRATION,
  MEMBER_IDENTITY_LINK_MIGRATION,
  MEMBER_PERSON_COLS_MIGRATION,
  MEMBER_PARTICIPATION_MIGRATION,
  MEMBER_PARTICIPATION_EMAILS_MIGRATION,
];
