// D1-backed MemberRepo. Owns namespace `member_*` only (enforced by @dub/db strict
// client). All timestamps come from the service (nowIso), never DDL DEFAULT (D2).
import type { DbClient } from "@dub/db";
import type { MemberRepo, PersonRow, TeamRow, MemberStatus } from "./types";

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
  contact: string | null;
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
function toPersonRow(r: PersonDbRow): PersonRow {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    roleTitle: r.role_title,
    status: r.status as MemberStatus,
    department: r.department,
    grade: r.grade,
    contact: r.contact,
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
          (id, org_id, name, role_title, status, department, grade, contact, note, sort_order, version, archived_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.orgId, row.name, row.roleTitle, row.status, row.department, row.grade, row.contact, row.note,
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
           name = ?, role_title = ?, status = ?, department = ?, grade = ?, contact = ?, note = ?, sort_order = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ? AND archived_at IS NULL`,
        next.name, next.roleTitle, next.status, next.department, next.grade, next.contact, next.note, next.sortOrder,
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
  } satisfies MemberRepo;
}
