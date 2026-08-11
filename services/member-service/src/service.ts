// Business logic for 運営メンバー管理. Pure of HTTP: takes parsed inputs + a request
// context, throws DubError, returns wire DTOs. The Hono app is a thin adapter.
import { DubError, errors } from "@dub/errors";
import type { common } from "@dub/types";
import type {
  AppDeps,
  CreateMemberRequest,
  CreateTeamRequest,
  MembersOverview,
  MemberTeam,
  OrgMember,
  PersonRow,
  TeamRow,
  UpdateMemberRequest,
  UpdateTeamRequest,
} from "./types";
import { isMemberStatus, MAX_NAME_LEN, SORT_ORDER_GAP, toMemberTeam, toOrgMember } from "./domain";

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
  async getOverview(_ctx: ReqCtx): Promise<MembersOverview> {
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
      teams: teams.map(toMemberTeam),
      members: people.map((p) => toOrgMember(p, byPerson.get(p.id) ?? [])),
    };
  }

  // ---- teams ----
  async createTeam(_ctx: ReqCtx, body: CreateTeamRequest): Promise<MemberTeam> {
    const orgId = this.deps.orgId;
    const now = this.deps.now();
    const nextSort = (await this.deps.repo.maxTeamSortOrder(orgId)) + SORT_ORDER_GAP;
    const row: TeamRow = {
      id: this.deps.newTeamId(),
      orgId,
      name: name(body.name),
      description: optText(body.description, "description"),
      sortOrder: nextSort,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.createTeam(row);
    return toMemberTeam(row);
  }

  async updateTeam(_ctx: ReqCtx, id: string, body: UpdateTeamRequest): Promise<MemberTeam> {
    const cur = await this.deps.repo.getTeam(id);
    if (!cur || cur.orgId !== this.deps.orgId) throw errTeamNotFound(id);
    const next: TeamRow = {
      ...cur,
      name: body.name !== undefined ? name(body.name) : cur.name,
      description: body.description !== undefined ? optText(body.description, "description") : cur.description,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : cur.sortOrder,
      updatedAt: this.deps.now(),
    };
    const ok = await this.deps.repo.updateTeam(next);
    if (!ok) throw errTeamNotFound(id);
    return toMemberTeam(next);
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

  async createMember(ctx: ReqCtx, body: CreateMemberRequest): Promise<OrgMember> {
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
    return toOrgMember(row, teamIds);
  }

  async updateMember(_ctx: ReqCtx, id: string, body: UpdateMemberRequest): Promise<OrgMember> {
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
      contact: body.contact !== undefined ? optText(body.contact, "contact") : cur.contact,
      note: body.note !== undefined ? optText(body.note, "note") : cur.note,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : cur.sortOrder,
      version: cur.version + 1,
      updatedAt: this.deps.now(),
    };
    const ok = await this.deps.repo.updatePerson(next, body.version, teamIds);
    if (!ok) throw errVersionConflict(id);
    const finalTeamIds = teamIds ?? (await this.currentTeamIds(id));
    return toOrgMember(next, finalTeamIds);
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
