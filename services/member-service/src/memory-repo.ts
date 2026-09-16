// In-memory MemberRepo: backs unit/HTTP tests without D1. Team membership is a
// nested Map (personId -> Set<teamId>) so there is no fragile string-join key.
import type { common } from "@dub/types";
import type { MemberRepo, ParticipationRow, PersonRow, TeamRow } from "./types";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class InMemoryMemberRepo implements MemberRepo {
  private teams = new Map<string, TeamRow>();
  private people = new Map<string, PersonRow>();
  private links = new Map<string, Set<string>>(); // personId -> Set<teamId>
  private participations = new Map<string, ParticipationRow>(); // id -> row

  private setLinks(personId: string, teamIds: string[]): void {
    this.links.set(personId, new Set(teamIds));
  }

  // ---- teams ----
  async createTeam(row: TeamRow): Promise<void> {
    this.teams.set(row.id, { ...row });
  }
  async getTeam(id: string): Promise<TeamRow | null> {
    const r = this.teams.get(id);
    return r ? { ...r } : null;
  }
  async getTeamByKey(orgId: common.OrgId, key: string): Promise<TeamRow | null> {
    for (const t of this.teams.values()) if (t.orgId === orgId && t.key === key) return { ...t };
    return null;
  }
  async listTeams(orgId: common.OrgId): Promise<TeamRow[]> {
    return [...this.teams.values()]
      .filter((t) => t.orgId === orgId)
      .sort((a, b) => a.sortOrder - b.sortOrder || cmp(a.id, b.id))
      .map((t) => ({ ...t }));
  }
  async updateTeam(row: TeamRow): Promise<boolean> {
    if (!this.teams.has(row.id)) return false;
    this.teams.set(row.id, { ...row });
    return true;
  }
  async deleteTeam(id: string): Promise<void> {
    this.teams.delete(id);
    for (const set of this.links.values()) set.delete(id);
  }
  async maxTeamSortOrder(orgId: common.OrgId): Promise<number> {
    let max = 0;
    for (const t of this.teams.values()) if (t.orgId === orgId && t.sortOrder > max) max = t.sortOrder;
    return max;
  }

  // ---- people ----
  async createPerson(row: PersonRow, teamIds: string[]): Promise<void> {
    this.people.set(row.id, { ...row });
    this.setLinks(row.id, teamIds);
  }
  async getPerson(id: string): Promise<PersonRow | null> {
    const r = this.people.get(id);
    return r && r.archivedAt === null ? { ...r } : null;
  }
  async getPersonByIdentityUserId(orgId: common.OrgId, identityUserId: string): Promise<PersonRow | null> {
    for (const p of this.people.values()) {
      if (p.orgId === orgId && p.archivedAt === null && p.identityUserId === identityUserId) return { ...p };
    }
    return null;
  }
  async listPeople(orgId: common.OrgId): Promise<PersonRow[]> {
    return [...this.people.values()]
      .filter((p) => p.orgId === orgId && p.archivedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder || cmp(a.id, b.id))
      .map((p) => ({ ...p }));
  }
  async updatePerson(next: PersonRow, expectedVersion: number, teamIds?: string[]): Promise<boolean> {
    const cur = this.people.get(next.id);
    if (!cur || cur.archivedAt !== null || cur.version !== expectedVersion) return false;
    this.people.set(next.id, { ...next });
    if (teamIds) this.setLinks(next.id, teamIds);
    return true;
  }
  async archivePerson(id: string): Promise<void> {
    const cur = this.people.get(id);
    if (cur) this.people.set(id, { ...cur, archivedAt: "archived" });
    this.links.delete(id);
  }
  async hardDeletePerson(id: string): Promise<void> {
    this.people.delete(id);
    this.links.delete(id);
  }
  async maxPersonSortOrder(orgId: common.OrgId): Promise<number> {
    let max = 0;
    for (const p of this.people.values()) if (p.orgId === orgId && p.sortOrder > max) max = p.sortOrder;
    return max;
  }

  async teamLinksForOrg(orgId: common.OrgId): Promise<Array<{ personId: string; teamId: string }>> {
    const out: Array<{ personId: string; teamId: string }> = [];
    for (const [personId, teamIds] of this.links) {
      const p = this.people.get(personId);
      if (!p || p.orgId !== orgId || p.archivedAt !== null) continue;
      for (const teamId of teamIds) out.push({ personId, teamId });
    }
    return out;
  }

  // ---- participations (参加届) ----
  async upsertParticipation(row: ParticipationRow): Promise<void> {
    this.participations.set(row.id, { ...row });
  }
  async getParticipation(id: string): Promise<ParticipationRow | null> {
    const r = this.participations.get(id);
    return r ? { ...r } : null;
  }
  async getParticipationByNormalizedName(orgId: common.OrgId, normalizedName: string): Promise<ParticipationRow | null> {
    for (const p of this.participations.values()) {
      if (p.orgId === orgId && p.normalizedName === normalizedName) return { ...p };
    }
    return null;
  }
  async listParticipations(orgId: common.OrgId): Promise<ParticipationRow[]> {
    return [...this.participations.values()]
      .filter((p) => p.orgId === orgId)
      .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : cmp(a.id, b.id)))
      .map((p) => ({ ...p }));
  }
}
