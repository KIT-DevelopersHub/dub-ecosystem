// D1-backed MemberRepo. Owns namespace `member_*` only (enforced by @dub/db strict
// client). All timestamps come from the service (nowIso), never DDL DEFAULT (D2).
import type { DbClient } from "@dub/db";
import type { member } from "@dub/types";
import { composeName } from "./domain";
import type { MemberRepo, ParticipationRow, PersonRow, TeamRow, MemberStatus } from "./types";

interface TeamDbRow {
  id: string;
  org_id: string;
  key: string;
  name: string;
  color: string | null;
  description: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
interface PersonDbRow {
  id: string;
  org_id: string;
  name: string;
  role_title: string | null;
  status: string;
  department: string | null;
  grade: string | null;
  identity_user_id: string | null;
  contact: string | null;
  school_email: string | null;
  gmail: string | null;
  last_name: string | null;
  first_name: string | null;
  last_name_kana: string | null;
  first_name_kana: string | null;
  last_name_romaji: string | null;
  first_name_romaji: string | null;
  phone: string | null;
  note: string | null;
  sort_order: number;
  version: number;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toTeamRow(r: TeamDbRow): TeamRow {
  return {
    id: r.id,
    orgId: r.org_id,
    key: r.key,
    name: r.name,
    color: r.color,
    description: r.description,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
interface ParticipationDbRow {
  id: string;
  org_id: string;
  member_id: string | null;
  name: string;
  normalized_name: string;
  last_name: string | null;
  first_name: string | null;
  name_kana: string | null;
  last_name_kana: string | null;
  first_name_kana: string | null;
  last_name_romaji: string | null;
  first_name_romaji: string | null;
  grade: string | null;
  department: string | null;
  contact: string | null;
  phone: string | null;
  school_email: string | null;
  gmail: string | null;
  desired_team_id: string | null;
  desired_activity: string | null;
  note: string | null;
  status: string;
  match_kind: string;
  submitted_by: string;
  submitted_at: string;
  created_at: string;
  updated_at: string;
}

function toParticipationRow(r: ParticipationDbRow): ParticipationRow {
  return {
    id: r.id,
    orgId: r.org_id,
    memberId: r.member_id,
    name: r.name,
    normalizedName: r.normalized_name,
    lastName: r.last_name,
    firstName: r.first_name,
    nameKana: r.name_kana,
    lastNameKana: r.last_name_kana,
    firstNameKana: r.first_name_kana,
    // nameRomaji is derived (no dedicated column): compose "Last First" from the split
    // romaji fields, matching how the service composes it before persisting.
    nameRomaji: composeName(r.last_name_romaji, r.first_name_romaji) || null,
    lastNameRomaji: r.last_name_romaji,
    firstNameRomaji: r.first_name_romaji,
    grade: r.grade as member.Grade | null,
    department: r.department,
    contact: r.contact,
    phone: r.phone,
    schoolEmail: r.school_email ?? "",
    gmail: r.gmail ?? "",
    desiredTeamId: r.desired_team_id,
    desiredActivity: r.desired_activity as member.DesiredActivity | null,
    note: r.note,
    status: "submitted",
    matchKind: r.match_kind as member.ParticipationMatchKind,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toPersonRow(r: PersonDbRow): PersonRow {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    roleTitle: r.role_title,
    status: r.status as MemberStatus,
    department: r.department,
    grade: r.grade,
    identityUserId: r.identity_user_id,
    contact: r.contact,
    schoolEmail: r.school_email,
    gmail: r.gmail,
    lastName: r.last_name,
    firstName: r.first_name,
    lastNameKana: r.last_name_kana,
    firstNameKana: r.first_name_kana,
    lastNameRomaji: r.last_name_romaji,
    firstNameRomaji: r.first_name_romaji,
    phone: r.phone,
    note: r.note,
    sortOrder: r.sort_order,
    version: r.version,
    archivedAt: r.archived_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createD1MemberRepo(db: DbClient): MemberRepo {
  async function replaceLinks(personId: string, teamIds: string[], now: string): Promise<void> {
    await db.run(`DELETE FROM member_team_links WHERE person_id = ?`, personId);
    for (const teamId of teamIds) {
      await db.run(
        `INSERT INTO member_team_links (person_id, team_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        personId, teamId, now, now,
      );
    }
  }

  return {
    // ---- teams ----
    async createTeam(row: TeamRow): Promise<void> {
      await db.run(
        `INSERT INTO member_teams (id, org_id, key, name, color, description, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.orgId, row.key, row.name, row.color, row.description, row.sortOrder, row.createdAt, row.updatedAt,
      );
    },
    async getTeam(id: string): Promise<TeamRow | null> {
      const r = await db.first<TeamDbRow>(`SELECT * FROM member_teams WHERE id = ?`, id);
      return r ? toTeamRow(r) : null;
    },
    async getTeamByKey(orgId, key: string): Promise<TeamRow | null> {
      const r = await db.first<TeamDbRow>(`SELECT * FROM member_teams WHERE org_id = ? AND key = ?`, orgId, key);
      return r ? toTeamRow(r) : null;
    },
    async listTeams(orgId): Promise<TeamRow[]> {
      const rows = await db.all<TeamDbRow>(
        `SELECT * FROM member_teams WHERE org_id = ? ORDER BY sort_order ASC, id ASC`,
        orgId,
      );
      return rows.map(toTeamRow);
    },
    async updateTeam(row: TeamRow): Promise<boolean> {
      const res = await db.run(
        `UPDATE member_teams SET key = ?, name = ?, color = ?, description = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
        row.key, row.name, row.color, row.description, row.sortOrder, row.updatedAt, row.id,
      );
      return res.meta.changes > 0;
    },
    async deleteTeam(id: string): Promise<void> {
      // Detach the team from all people, then remove it. People are kept.
      await db.run(`DELETE FROM member_team_links WHERE team_id = ?`, id);
      await db.run(`DELETE FROM member_teams WHERE id = ?`, id);
    },
    async maxTeamSortOrder(orgId): Promise<number> {
      const r = await db.first<{ m: number | null }>(
        `SELECT MAX(sort_order) AS m FROM member_teams WHERE org_id = ?`,
        orgId,
      );
      return r?.m ?? 0;
    },

    // ---- people ----
    async createPerson(row: PersonRow, teamIds: string[]): Promise<void> {
      await db.run(
        `INSERT INTO member_people
          (id, org_id, name, role_title, status, department, grade, identity_user_id, contact, school_email, gmail, last_name, first_name, last_name_kana, first_name_kana, last_name_romaji, first_name_romaji, phone, note, sort_order, version, archived_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.orgId, row.name, row.roleTitle, row.status, row.department, row.grade, row.identityUserId, row.contact, row.schoolEmail, row.gmail,
        row.lastName, row.firstName, row.lastNameKana, row.firstNameKana, row.lastNameRomaji, row.firstNameRomaji, row.phone, row.note,
        row.sortOrder, row.version, row.archivedAt, row.createdBy, row.createdAt, row.updatedAt,
      );
      await replaceLinks(row.id, teamIds, row.createdAt);
    },
    async getPerson(id: string): Promise<PersonRow | null> {
      const r = await db.first<PersonDbRow>(
        `SELECT * FROM member_people WHERE id = ? AND archived_at IS NULL`,
        id,
      );
      return r ? toPersonRow(r) : null;
    },
    async getPersonByIdentityUserId(orgId, identityUserId: string): Promise<PersonRow | null> {
      const r = await db.first<PersonDbRow>(
        `SELECT * FROM member_people WHERE org_id = ? AND identity_user_id = ? AND archived_at IS NULL`,
        orgId, identityUserId,
      );
      return r ? toPersonRow(r) : null;
    },
    async listPeople(orgId): Promise<PersonRow[]> {
      const rows = await db.all<PersonDbRow>(
        `SELECT * FROM member_people WHERE org_id = ? AND archived_at IS NULL ORDER BY sort_order ASC, id ASC`,
        orgId,
      );
      return rows.map(toPersonRow);
    },
    async updatePerson(next: PersonRow, expectedVersion: number, teamIds?: string[]): Promise<boolean> {
      const res = await db.run(
        `UPDATE member_people SET
           name = ?, role_title = ?, status = ?, department = ?, grade = ?, identity_user_id = ?, contact = ?, school_email = ?, gmail = ?, last_name = ?, first_name = ?, last_name_kana = ?, first_name_kana = ?, last_name_romaji = ?, first_name_romaji = ?, phone = ?, note = ?, sort_order = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ? AND archived_at IS NULL`,
        next.name, next.roleTitle, next.status, next.department, next.grade, next.identityUserId, next.contact, next.schoolEmail, next.gmail,
        next.lastName, next.firstName, next.lastNameKana, next.firstNameKana, next.lastNameRomaji, next.firstNameRomaji, next.phone, next.note, next.sortOrder,
        next.version, next.updatedAt, next.id, expectedVersion,
      );
      if (res.meta.changes === 0) return false;
      if (teamIds) await replaceLinks(next.id, teamIds, next.updatedAt);
      return true;
    },
    async archivePerson(id: string): Promise<void> {
      await db.run(`DELETE FROM member_team_links WHERE person_id = ?`, id);
      await db.run(`UPDATE member_people SET archived_at = ? WHERE id = ?`, new Date().toISOString(), id);
    },
    async maxPersonSortOrder(orgId): Promise<number> {
      const r = await db.first<{ m: number | null }>(
        `SELECT MAX(sort_order) AS m FROM member_people WHERE org_id = ?`,
        orgId,
      );
      return r?.m ?? 0;
    },

    async teamLinksForOrg(orgId): Promise<Array<{ personId: string; teamId: string }>> {
      const rows = await db.all<{ person_id: string; team_id: string }>(
        `SELECT l.person_id, l.team_id FROM member_team_links l
           JOIN member_people p ON p.id = l.person_id
          WHERE p.org_id = ? AND p.archived_at IS NULL`,
        orgId,
      );
      return rows.map((r) => ({ personId: r.person_id, teamId: r.team_id }));
    },

    // ---- participations (参加届) ----
    async upsertParticipation(row: ParticipationRow): Promise<void> {
      // Idempotent on (org_id, normalized_name): a resubmission overwrites the prior
      // row in place (created_at is carried by the service from the existing row).
      await db.run(
        `INSERT INTO member_participations
          (id, org_id, member_id, name, normalized_name, last_name, first_name, name_kana,
           last_name_kana, first_name_kana, last_name_romaji, first_name_romaji, grade, department, contact, phone,
           school_email, gmail, desired_team_id, desired_activity, note, status, match_kind,
           submitted_by, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, normalized_name) DO UPDATE SET
           member_id = excluded.member_id,
           name = excluded.name,
           last_name = excluded.last_name,
           first_name = excluded.first_name,
           name_kana = excluded.name_kana,
           last_name_kana = excluded.last_name_kana,
           first_name_kana = excluded.first_name_kana,
           last_name_romaji = excluded.last_name_romaji,
           first_name_romaji = excluded.first_name_romaji,
           grade = excluded.grade,
           department = excluded.department,
           contact = excluded.contact,
           phone = excluded.phone,
           school_email = excluded.school_email,
           gmail = excluded.gmail,
           desired_team_id = excluded.desired_team_id,
           desired_activity = excluded.desired_activity,
           note = excluded.note,
           status = excluded.status,
           match_kind = excluded.match_kind,
           submitted_by = excluded.submitted_by,
           submitted_at = excluded.submitted_at,
           updated_at = excluded.updated_at`,
        row.id, row.orgId, row.memberId, row.name, row.normalizedName, row.lastName, row.firstName, row.nameKana,
        row.lastNameKana, row.firstNameKana, row.lastNameRomaji, row.firstNameRomaji, row.grade, row.department, row.contact, row.phone,
        row.schoolEmail, row.gmail, row.desiredTeamId, row.desiredActivity,
        row.note, row.status, row.matchKind, row.submittedBy, row.submittedAt, row.createdAt, row.updatedAt,
      );
    },
    async getParticipationByNormalizedName(orgId, normalizedName: string): Promise<ParticipationRow | null> {
      const r = await db.first<ParticipationDbRow>(
        `SELECT * FROM member_participations WHERE org_id = ? AND normalized_name = ?`,
        orgId, normalizedName,
      );
      return r ? toParticipationRow(r) : null;
    },
    async listParticipations(orgId): Promise<ParticipationRow[]> {
      const rows = await db.all<ParticipationDbRow>(
        `SELECT * FROM member_participations WHERE org_id = ? ORDER BY submitted_at DESC, id ASC`,
        orgId,
      );
      return rows.map(toParticipationRow);
    },
  } satisfies MemberRepo;
}
