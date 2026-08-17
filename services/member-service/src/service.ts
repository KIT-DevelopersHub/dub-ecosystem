// Business logic for 運営メンバー管理. Pure of HTTP: takes parsed inputs + a request
// context, throws DubError, returns canonical @dub/types wire DTOs. The Hono app is a
// thin adapter. member_teams is the source of truth for the shared Team entity.
import { DubError, errors } from "@dub/errors";
import type { common, member } from "@dub/types";
import type { AppDeps, ParticipationRow, PersonRow, TeamRow } from "./types";
import {
  composeName,
  isDesiredActivity,
  isEmail,
  isGrade,
  isMemberStatus,
  isPhone,
  isRomaji,
  MAX_NAME_LEN,
  normalizeName,
  SORT_ORDER_GAP,
  slugify,
  toMember,
  toParticipation,
  toTeam,
} from "./domain";

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
      identityUserId: null,
      contact: optText(body.contact, "contact"),
      schoolEmail: null,
      gmail: null,
      lastName: null,
      firstName: null,
      lastNameKana: null,
      firstNameKana: null,
      lastNameRomaji: null,
      firstNameRomaji: null,
      phone: null,
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
    const identityUserId =
      body.identityUserId !== undefined
        ? await this.resolveIdentityLink(body.identityUserId, cur.id)
        : cur.identityUserId;
    const next: PersonRow = {
      ...cur,
      name: body.name !== undefined ? name(body.name) : cur.name,
      roleTitle: body.roleTitle !== undefined ? optText(body.roleTitle, "roleTitle") : cur.roleTitle,
      status: body.status ?? cur.status,
      department: body.department !== undefined ? optText(body.department, "department") : cur.department,
      grade: body.grade !== undefined ? optText(body.grade, "grade") : cur.grade,
      identityUserId,
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

  // ---- identity linking (#1: bridge 組織図 <-> RBAC 真実) ----
  /**
   * Validate an identityUserId assignment for `personId`. `null` unlinks. A non-empty
   * string links, but the same account may not be linked to two 運営メンバー at once
   * (409 conflict) — the relationship is 1:1 so offboarding fan-out is unambiguous.
   */
  private async resolveIdentityLink(value: unknown, personId: string): Promise<string | null> {
    if (value === null) return null;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw errors.validationFailed([{ field: "identityUserId", reason: "invalid" }]);
    }
    const id = value.trim();
    const other = await this.deps.repo.getPersonByIdentityUserId(this.deps.orgId, id);
    if (other && other.id !== personId) {
      throw new DubError("MEMBER_IDENTITY_ALREADY_LINKED", `identity user ${id} is already linked to another member`, {
        status: 409,
        details: [{ field: "identityUserId", reason: "already_linked", message: other.id }],
      });
    }
    return id;
  }

  /** Link (or re-link) a member to an identity account. Optimistic-concurrency by version. */
  async linkIdentity(_ctx: ReqCtx, id: string, body: member.LinkIdentityRequest): Promise<member.Member> {
    if (typeof body?.version !== "number") throw errors.validationFailed([{ field: "version", reason: "required" }]);
    const cur = await this.deps.repo.getPerson(id);
    if (!cur || cur.orgId !== this.deps.orgId) throw errPersonNotFound(id);
    const identityUserId = await this.resolveIdentityLink(body.identityUserId, cur.id);
    const next: PersonRow = { ...cur, identityUserId, version: body.version + 1, updatedAt: this.deps.now() };
    const ok = await this.deps.repo.updatePerson(next, body.version);
    if (!ok) throw errVersionConflict(id);
    return toMember(next, await this.currentTeamIds(id));
  }

  /** Reverse lookup used by offboarding fan-out: the member linked to an identity user. */
  async getByIdentityUserId(_ctx: ReqCtx, identityUserId: string): Promise<member.Member | null> {
    const cur = await this.deps.repo.getPersonByIdentityUserId(this.deps.orgId, identityUserId);
    if (!cur) return null;
    return toMember(cur, await this.currentTeamIds(cur.id));
  }

  private async currentTeamIds(personId: string): Promise<string[]> {
    const links = await this.deps.repo.teamLinksForOrg(this.deps.orgId);
    return links.filter((l) => l.personId === personId).map((l) => l.teamId);
  }

  // ---- 参加届 (participation) ----------------------------------------------------
  /** Validate an optional team reference exists in this org; returns the id or null. */
  private async optTeamId(desiredTeamId: unknown): Promise<string | null> {
    if (desiredTeamId === undefined || desiredTeamId === null || desiredTeamId === "") return null;
    if (typeof desiredTeamId !== "string") {
      throw errors.validationFailed([{ field: "desiredTeamId", reason: "invalid" }]);
    }
    const team = await this.deps.repo.getTeam(desiredTeamId);
    if (!team || team.orgId !== this.deps.orgId) throw errTeamNotFound(desiredTeamId);
    return team.id;
  }

  /**
   * Submit a 参加届 and reflect it onto the roster, idempotently and non-destructively:
   *  - name matched (space/width-folded) against an existing member → if 招待中/検討中,
   *    promote to 追加済; merge the desired team + contact only when currently empty.
   *  - no match → create a new 追加済 member from the submission.
   * The submission row is upserted (deduped per org by normalized name).
   */
  async submitParticipation(
    ctx: ReqCtx,
    body: member.SubmitParticipationRequest,
  ): Promise<member.SubmitParticipationResponse> {
    const orgId = this.deps.orgId;
    const now = this.deps.now();
    // 氏名: 姓/名 の分割入力を優先し、"姓 名" を合成する。旧クライアントの単一 `name` も
    // 後方互換で受ける (どちらかが揃えば OK)。合成結果が空なら name() が 400 を投げる。
    const lastName = optText(body.lastName, "lastName");
    const firstName = optText(body.firstName, "firstName");
    const composed = composeName(lastName, firstName);
    const displayName = name(composed.length > 0 ? composed : body.name);
    const normalized = normalizeName(displayName);
    if (normalized.length === 0) throw errors.validationFailed([{ field: "name", reason: "required" }]);

    const grade = body.grade == null ? null : isGrade(body.grade) ? body.grade : invalid("grade");
    const desiredActivity =
      body.desiredActivity == null ? null : isDesiredActivity(body.desiredActivity) ? body.desiredActivity : invalid("desiredActivity");
    // 振り仮名: せい/めい の分割を優先し合成、無ければ旧単一 nameKana。
    const lastNameKana = optText(body.lastNameKana, "lastNameKana");
    const firstNameKana = optText(body.firstNameKana, "firstNameKana");
    const composedKana = composeName(lastNameKana, firstNameKana);
    const nameKana = composedKana.length > 0 ? composedKana : optText(body.nameKana, "nameKana");
    // ローマ字: 姓/名 の分割を優先し合成、無ければ旧単一 nameRomaji。任意フィールドだが
    // 渡された時だけ英字形式チェック (アルファベットのメール発行に使うため)。
    const lastNameRomaji = optText(body.lastNameRomaji, "lastNameRomaji");
    const firstNameRomaji = optText(body.firstNameRomaji, "firstNameRomaji");
    if (lastNameRomaji !== null && !isRomaji(lastNameRomaji)) {
      throw errors.validationFailed([{ field: "lastNameRomaji", reason: "invalid" }]);
    }
    if (firstNameRomaji !== null && !isRomaji(firstNameRomaji)) {
      throw errors.validationFailed([{ field: "firstNameRomaji", reason: "invalid" }]);
    }
    const composedRomaji = composeName(lastNameRomaji, firstNameRomaji);
    const nameRomaji = composedRomaji.length > 0 ? composedRomaji : optText(body.nameRomaji, "nameRomaji");
    const department = optText(body.department, "department");
    const contact = optText(body.contact, "contact");
    const note = optText(body.note, "note");
    // 電話番号は任意。渡された時だけ緩い形式チェック。
    const phone = optText(body.phone, "phone");
    if (phone !== null && !isPhone(phone)) throw errors.validationFailed([{ field: "phone", reason: "invalid" }]);
    // 学校メール + Gmail は必須 & メール形式.
    if (!isEmail(body.schoolEmail)) throw errors.validationFailed([{ field: "schoolEmail", reason: "invalid" }]);
    if (!isEmail(body.gmail)) throw errors.validationFailed([{ field: "gmail", reason: "invalid" }]);
    const schoolEmail = body.schoolEmail.trim();
    const gmail = body.gmail.trim();
    const desiredTeamId = await this.optTeamId(body.desiredTeamId);

    const { member: resolved, matchKind } = await this.resolveMemberForParticipation(ctx, {
      displayName,
      normalized,
      lastName,
      firstName,
      lastNameKana,
      firstNameKana,
      lastNameRomaji,
      firstNameRomaji,
      phone,
      department,
      grade,
      contact,
      schoolEmail,
      gmail,
      note,
      desiredTeamId,
    });

    const existing = await this.deps.repo.getParticipationByNormalizedName(orgId, normalized);
    const row: ParticipationRow = {
      id: existing?.id ?? this.deps.newParticipationId(),
      orgId,
      memberId: resolved.id,
      name: displayName,
      normalizedName: normalized,
      lastName,
      firstName,
      nameKana,
      lastNameKana,
      firstNameKana,
      nameRomaji,
      lastNameRomaji,
      firstNameRomaji,
      grade,
      department,
      contact,
      phone,
      schoolEmail,
      gmail,
      desiredTeamId,
      desiredActivity,
      note,
      status: "submitted",
      matchKind,
      submittedBy: ctx.userId,
      submittedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.repo.upsertParticipation(row);
    return { participation: toParticipation(row), member: resolved, matchKind };
  }

  /** Resolve (promote-or-create) the roster member behind a submission. */
  private async resolveMemberForParticipation(
    ctx: ReqCtx,
    input: {
      displayName: string;
      normalized: string;
      lastName: string | null;
      firstName: string | null;
      lastNameKana: string | null;
      firstNameKana: string | null;
      lastNameRomaji: string | null;
      firstNameRomaji: string | null;
      phone: string | null;
      department: string | null;
      grade: member.Grade | null;
      contact: string | null;
      schoolEmail: string;
      gmail: string;
      note: string | null;
      desiredTeamId: string | null;
    },
  ): Promise<{ member: member.Member; matchKind: member.ParticipationMatchKind }> {
    const orgId = this.deps.orgId;
    const people = await this.deps.repo.listPeople(orgId);
    const match = people.find((p) => normalizeName(p.name) === input.normalized);

    if (match) {
      const currentTeamIds = await this.currentTeamIds(match.id);
      const mergedTeamIds =
        input.desiredTeamId && !currentTeamIds.includes(input.desiredTeamId)
          ? [...currentTeamIds, input.desiredTeamId]
          : currentTeamIds;
      const promote = match.status === "invited" || match.status === "considering";
      const next: PersonRow = {
        ...match,
        status: promote ? "added" : match.status,
        // non-destructive: only fill when currently empty. Both 参加届 emails are
        // retained on the roster (default `contact` to the school address when unset).
        department: match.department ?? input.department,
        grade: match.grade ?? input.grade,
        contact: match.contact ?? input.schoolEmail,
        schoolEmail: match.schoolEmail ?? input.schoolEmail,
        gmail: match.gmail ?? input.gmail,
        lastName: match.lastName ?? input.lastName,
        firstName: match.firstName ?? input.firstName,
        lastNameKana: match.lastNameKana ?? input.lastNameKana,
        firstNameKana: match.firstNameKana ?? input.firstNameKana,
        lastNameRomaji: match.lastNameRomaji ?? input.lastNameRomaji,
        firstNameRomaji: match.firstNameRomaji ?? input.firstNameRomaji,
        phone: match.phone ?? input.phone,
        note: match.note ?? input.note,
        version: match.version + 1,
        updatedAt: this.deps.now(),
      };
      const ok = await this.deps.repo.updatePerson(next, match.version, mergedTeamIds);
      if (!ok) throw errVersionConflict(match.id);
      return { member: toMember(next, mergedTeamIds), matchKind: "linked_existing" };
    }

    // No roster match → create a new 追加済 member from the submission.
    const now = this.deps.now();
    const teamIds = input.desiredTeamId ? [input.desiredTeamId] : [];
    const row: PersonRow = {
      id: this.deps.newMemberId(),
      orgId,
      name: input.displayName,
      roleTitle: null,
      status: "added",
      department: input.department,
      grade: input.grade,
      identityUserId: null,
      contact: input.contact ?? input.schoolEmail,
      schoolEmail: input.schoolEmail,
      gmail: input.gmail,
      lastName: input.lastName,
      firstName: input.firstName,
      lastNameKana: input.lastNameKana,
      firstNameKana: input.firstNameKana,
      lastNameRomaji: input.lastNameRomaji,
      firstNameRomaji: input.firstNameRomaji,
      phone: input.phone,
      note: input.note,
      sortOrder: (await this.deps.repo.maxPersonSortOrder(orgId)) + SORT_ORDER_GAP,
      version: 1,
      archivedAt: null,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.createPerson(row, teamIds);
    return { member: toMember(row, teamIds), matchKind: "created_new" };
  }

  async listParticipations(_ctx: ReqCtx): Promise<member.ListParticipationsResponse> {
    const rows = await this.deps.repo.listParticipations(this.deps.orgId);
    return { participations: rows.map(toParticipation) };
  }
}

function invalid(field: string): never {
  throw errors.validationFailed([{ field, reason: "invalid" }]);
}
