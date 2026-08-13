// Business logic for 運営メンバー管理. Pure of HTTP: takes parsed inputs + a request
// context, throws DubError, returns canonical @dub/types wire DTOs. The Hono app is a
// thin adapter. member_teams is the source of truth for the shared Team entity.
import { DubError, errors } from "@dub/errors";
import type { common, member } from "@dub/types";
import type { AppDeps, PersonRow, TeamRow } from "./types";
import { isMemberStatus, MAX_NAME_LEN, SORT_ORDER_GAP, slugify, toMember, toTeam } from "./domain";

export interface ReqCtx {
  requestId: string;
  userId: common.UserId;
}

const errVersionConflict = (id: string): DubError =>
  new DubError("MEMBER_VERSION_CONFLICT", `Version conflict for ${id}`, { status: 409 });
const errTeamNotFound = (id: string): DubError =>
  new DubError("MEMBER_TEAM_NOT_FOUND", `Team not found: ${id}`, { status: 404 });
const errPersonNotFound = (id: string): DubError =>
  new DubError("MEMBER_NOT_FOUND", `Member not found: ${id}`, { status: 404 });

function name(value: unknown, field = "name"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw errors.validationFailed([{ field, reason: "required" }]);
  }
  if (value.length > MAX_NAME_LEN) throw errors.validationFailed([{ field, reason: "too_long" }]);
  return value.trim();
}

function optText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw errors.validationFailed([{ field, reason: "invalid" }]);
  const t = value.trim();
  return t.length === 0 ? null : t;
}

export class MemberService {
  constructor(private readonly deps: AppDeps) {}

  // ---- overview (powers all three views) ----
  async getOverview(_ctx: ReqCtx): Promise<member.MembersOverview> {
    const orgId = this.deps.orgId;
    const [teams, people, links] = await Promise.all([
      this.deps.repo.listTeams(orgId),
      this.deps.repo.listPeople(orgId),
      this.deps.repo.teamLinksForOrg(orgId),
    ]);
    const byPerson = new Map<string, string[]>();
    for (const l of links) {
      const arr = byPerson.get(l.personId) ?? [];
      arr.push(l.teamId);
      byPerson.set(l.personId, arr);
    }
    return {
      teams: teams.map(toTeam),
      members: people.map((p) => toMember(p, byPerson.get(p.id) ?? [])),
    };
  }

  // ---- teams (member_teams is the canonical source read by other apps) ----
  async listTeams(_ctx: ReqCtx): Promise<member.ListTeamsResponse> {
    const teams = await this.deps.repo.listTeams(this.deps.orgId);
    return { teams: teams.map(toTeam) };
  }

  /** Resolve a unique, URL-safe key within the org (auto-suffix on collision). */
  private async resolveKey(orgId: common.OrgId, desired: string, fallback: string, excludeId?: string): Promise<string> {
    let base = slugify(desired);
    if (base.length === 0) base = slugify(fallback) || `team-${Math.random().toString(36).slice(2, 8)}`;
    let candidate = base;
    for (let i = 2; ; i++) {
      const existing = await this.deps.repo.getTeamByKey(orgId, candidate);
      if (!existing || existing.id === excludeId) return candidate;
      candidate = `${base}-${i}`;
    }
  }

  async createTeam(_ctx: ReqCtx, body: member.CreateTeamRequest): Promise<member.Team> {
    const orgId = this.deps.orgId;
    const now = this.deps.now();
    const teamName = name(body.name);
    const id = this.deps.newTeamId();
    const key = await this.resolveKey(orgId, body.key ?? teamName, id);
    const row: TeamRow = {
      id,
      orgId,
      key,
      name: teamName,
      color: optText(body.color, "color"),
      description: optText(body.description, "description"),
      sortOrder: (await this.deps.repo.maxTeamSortOrder(orgId)) + SORT_ORDER_GAP,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.createTeam(row);
    return toTeam(row);
  }

  async updateTeam(_ctx: ReqCtx, id: string, body: member.UpdateTeamRequest): Promise<member.Team> {
    const cur = await this.deps.repo.getTeam(id);
    if (!cur || cur.orgId !== this.deps.orgId) throw errTeamNotFound(id);
    const nextName = body.name !== undefined ? name(body.name) : cur.name;
    const key = body.key !== undefined ? await this.resolveKey(cur.orgId, body.key, nextName, cur.id) : cur.key;
    const next: TeamRow = {
      ...cur,
      key,
      name: nextName,
      color: body.color !== undefined ? optText(body.color, "color") : cur.color,
      description: body.description !== undefined ? optText(body.description, "description") : cur.description,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : cur.sortOrder,
      updatedAt: this.deps.now(),
    };
    const ok = await this.deps.repo.updateTeam(next);
    if (!ok) throw errTeamNotFound(id);
    return toTeam(next);
  }

  async deleteTeam(_ctx: ReqCtx, id: string): Promise<void> {
    const cur = await this.deps.repo.getTeam(id);
    if (!cur || cur.orgId !== this.deps.orgId) throw errTeamNotFound(id);
    await this.deps.repo.deleteTeam(id);
  }

  // ---- people ----
  private async validateTeamIds(teamIds: unknown): Promise<string[]> {
    if (teamIds === undefined) return [];
    if (!Array.isArray(teamIds) || teamIds.some((t) => typeof t !== "string")) {
      throw errors.validationFailed([{ field: "teamIds", reason: "invalid" }]);
    }
    const unique = [...new Set(teamIds as string[])];
    if (unique.length === 0) return [];
    const existing = await this.deps.repo.listTeams(this.deps.orgId);
    const known = new Set(existing.map((t) => t.id));
    for (const t of unique) if (!known.has(t)) throw errTeamNotFound(t);
    return unique;
  }

  async createMember(ctx: ReqCtx, body: member.CreateMemberRequest): Promise<member.Member> {
    if (!isMemberStatus(body.status)) throw errors.validationFailed([{ field: "status", reason: "invalid" }]);
    const teamIds = await this.validateTeamIds(body.teamIds);
    const orgId = this.deps.orgId;
    const now = this.deps.now();
    const row: PersonRow = {
      id: this.deps.newMemberId(),
      orgId,
      name: name(body.name),
      roleTitle: optText(body.roleTitle, "roleTitle"),
      status: body.status,
      department: optText(body.department, "department"),
      grade: optText(body.grade, "grade"),
      contact: optText(body.contact, "contact"),
      note: optText(body.note, "note"),
      sortOrder: (await this.deps.repo.maxPersonSortOrder(orgId)) + SORT_ORDER_GAP,
      version: 1,
      archivedAt: null,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.createPerson(row, teamIds);
    return toMember(row, teamIds);
  }

  async updateMember(_ctx: ReqCtx, id: string, body: member.UpdateMemberRequest): Promise<member.Member> {
    if (typeof body.version !== "number") throw errors.validationFailed([{ field: "version", reason: "required" }]);
    const cur = await this.deps.repo.getPerson(id);
    if (!cur || cur.orgId !== this.deps.orgId) throw errPersonNotFound(id);
    if (body.status !== undefined && !isMemberStatus(body.status)) {
      throw errors.validationFailed([{ field: "status", reason: "invalid" }]);
    }
    const teamIds = body.teamIds !== undefined ? await this.validateTeamIds(body.teamIds) : undefined;
    const next: PersonRow = {
      ...cur,
      name: body.name !== undefined ? name(body.name) : cur.name,
      roleTitle: body.roleTitle !== undefined ? optText(body.roleTitle, "roleTitle") : cur.roleTitle,
      status: body.status ?? cur.status,
      department: body.department !== undefined ? optText(body.department, "department") : cur.department,
      grade: body.grade !== undefined ? optText(body.grade, "grade") : cur.grade,
      contact: body.contact !== undefined ? optText(body.contact, "contact") : cur.contact,
      note: body.note !== undefined ? optText(body.note, "note") : cur.note,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : cur.sortOrder,
      version: cur.version + 1,
      updatedAt: this.deps.now(),
    };
    const ok = await this.deps.repo.updatePerson(next, body.version, teamIds);
    if (!ok) throw errVersionConflict(id);
    const finalTeamIds = teamIds ?? (await this.currentTeamIds(id));
    return toMember(next, finalTeamIds);
  }

  async deleteMember(_ctx: ReqCtx, id: string): Promise<void> {
    const cur = await this.deps.repo.getPerson(id);
    if (!cur || cur.orgId !== this.deps.orgId) throw errPersonNotFound(id);
    await this.deps.repo.archivePerson(id);
  }

  private async currentTeamIds(personId: string): Promise<string[]> {
    const links = await this.deps.repo.teamLinksForOrg(this.deps.orgId);
    return links.filter((l) => l.personId === personId).map((l) => l.teamId);
  }
}
