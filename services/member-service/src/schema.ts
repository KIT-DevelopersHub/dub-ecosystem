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

// 参加届: 氏名/振り仮名を 姓(last)/名(first) に分割 + 電話番号. Additive ALTER (non-
// destructive): the legacy single `name` / `name_kana` columns are retained and kept
// in sync by the app ("姓 名" composed into `name`), so every existing reader keeps
// working. 姓/名 required at the app layer; 振り仮名/電話 optional. Nullable in DDL
// (SQLite ADD COLUMN can't be NOT NULL without a default). Retained on member_people.
export const MEMBER_PARTICIPATION_NAME_SPLIT_MIGRATION: Migration = {
  namespace: "member",
  id: "0006_participation_name_split_phone",
  up: `
ALTER TABLE member_participations ADD COLUMN last_name TEXT;
ALTER TABLE member_participations ADD COLUMN first_name TEXT;
ALTER TABLE member_participations ADD COLUMN last_name_kana TEXT;
ALTER TABLE member_participations ADD COLUMN first_name_kana TEXT;
ALTER TABLE member_participations ADD COLUMN phone TEXT;
ALTER TABLE member_people ADD COLUMN last_name TEXT;
ALTER TABLE member_people ADD COLUMN first_name TEXT;
ALTER TABLE member_people ADD COLUMN last_name_kana TEXT;
ALTER TABLE member_people ADD COLUMN first_name_kana TEXT;
ALTER TABLE member_people ADD COLUMN phone TEXT;
`.trim(),
};

// 参加届: 氏名のローマ字(アルファベット)表記. Additive ALTER (non-destructive): 姓/名 を
// ローマ字で別途保持し、アルファベットのメールアドレス発行 (例 first.last@) の候補生成に
// 使う。任意フィールド (英字) で nullable. Retained on member_people too so the roster
// keeps the alphabet name. Mirrors 0007_participation_romaji.sql (schema-lockstep).
export const MEMBER_PARTICIPATION_ROMAJI_MIGRATION: Migration = {
  namespace: "member",
  id: "0007_participation_romaji",
  up: `
ALTER TABLE member_participations ADD COLUMN last_name_romaji TEXT;
ALTER TABLE member_participations ADD COLUMN first_name_romaji TEXT;
ALTER TABLE member_people ADD COLUMN last_name_romaji TEXT;
ALTER TABLE member_people ADD COLUMN first_name_romaji TEXT;
`.trim(),
};

// 参加届: 管理者レビュー状態 (review_state). 名簿への反映を「提出時に自動」から
// 「管理者が一覧で確定」へ変更 (B案) するための additive ALTER (non-destructive, 冪等).
// 既存の自動反映済み行 (0007以前に提出され member_people へ反映済み) は review_state=
// 'added' として後方互換を保つ (backfill)。以後の新規提出は app 層が 'pending' を書き、
// 確定時に 'added'/'skipped' へ更新する。Mirrors 0008_participation_review_state.sql
// (schema-lockstep). SQLite ADD COLUMN は NOT NULL 既定を付けられないため nullable。
export const MEMBER_PARTICIPATION_REVIEW_STATE_MIGRATION: Migration = {
  namespace: "member",
  id: "0008_participation_review_state",
  up: `
ALTER TABLE member_participations ADD COLUMN review_state TEXT;
UPDATE member_participations SET review_state = 'added' WHERE review_state IS NULL;
`.trim(),
};

// 参加届: 希望する活動(desired_activity) を名簿(member_people)にも保持する additive ALTER
// (non-destructive)。0005〜0007 が 参加届 の各項目を member_people へミラーしたのと同じ流儀
// で、唯一ミラーされていなかった desired_activity を足す。これにより本人が アカウント設定 →
// 参加情報 で自分の 参加届 (希望活動 を含む) を自己 read/update でき、実DBへ往復保存できる。
// SQLite ADD COLUMN は既定値を付けられないため nullable。Mirrors
// 0009_person_desired_activity.sql (schema-lockstep).
export const MEMBER_PERSON_DESIRED_ACTIVITY_MIGRATION: Migration = {
  namespace: "member",
  id: "0009_person_desired_activity",
  up: `
ALTER TABLE member_people ADD COLUMN desired_activity TEXT;
`.trim(),
};

// All member-namespace migrations in apply order (mirrors infra/d1/migrations/member).
export const MEMBER_MIGRATIONS: readonly Migration[] = [
  MEMBER_SCHEMA_MIGRATION,
  MEMBER_IDENTITY_LINK_MIGRATION,
  MEMBER_PERSON_COLS_MIGRATION,
  MEMBER_PARTICIPATION_MIGRATION,
  MEMBER_PARTICIPATION_EMAILS_MIGRATION,
  MEMBER_PARTICIPATION_NAME_SPLIT_MIGRATION,
  MEMBER_PARTICIPATION_ROMAJI_MIGRATION,
  MEMBER_PARTICIPATION_REVIEW_STATE_MIGRATION,
  MEMBER_PERSON_DESIRED_ACTIVITY_MIGRATION,
];
