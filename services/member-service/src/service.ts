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
const errParticipationNotFound = (id: string): DubError =>
  new DubError("MEMBER_PARTICIPATION_NOT_FOUND", `Participation not found: ${id}`, { status: 404 });

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

    // 名簿への反映は管理者が一覧で確定する（B案）。提出時は 参加届 を記録するだけで、
    // roster には一切書き込まない（自動追加による重複を根絶）。再提出は既存行の
    // レビュー状態(reviewState/memberId/matchKind)を保持したまま内容だけ更新する。
    const existing = await this.deps.repo.getParticipationByNormalizedName(orgId, normalized);
    const row: ParticipationRow = {
      id: existing?.id ?? this.deps.newParticipationId(),
      orgId,
      // 未処理のうちは反映先メンバー無し。確定済みの再提出は既存の反映先を保持。
      memberId: existing?.memberId ?? null,
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
      // matchKind は未処理時は意味を持たない placeholder（reviewState で表示制御）。
      matchKind: existing?.matchKind ?? "created_new",
      reviewState: existing?.reviewState ?? "pending",
      submittedBy: ctx.userId,
      submittedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.repo.upsertParticipation(row);
    // 既に反映済み(再提出)なら反映先メンバーをエコー、未処理なら null。
    const echoed = row.memberId ? await this.getMemberById(row.memberId) : null;
    return { participation: toParticipation(row), member: echoed, matchKind: row.matchKind };
  }

  private async getMemberById(id: string): Promise<member.Member | null> {
    const p = await this.deps.repo.getPerson(id);
    if (!p || p.orgId !== this.deps.orgId) return null;
    return toMember(p, await this.currentTeamIds(id));
  }

  // ---- 参加届: 突合候補 (招待中/検討中のみ) ----------------------------------------
  /** 参加届の提出者と同一人物かもしれない既存メンバーを、氏名(正規化)＋学校メール/Gmail
   *  の一致で探して候補提示する。email 一致を上位に。結合対象は招待中/検討中のみ
   *  (added は既に在籍なので結合しない)。最終確定は resolve(link) で管理者が行う。 */
  async listParticipationCandidates(
    _ctx: ReqCtx,
    participationId: string,
  ): Promise<member.ListParticipationCandidatesResponse> {
    const p = await this.deps.repo.getParticipation(participationId);
    if (!p || p.orgId !== this.deps.orgId) throw errParticipationNotFound(participationId);
    const people = await this.deps.repo.listPeople(this.deps.orgId);
    const wantEmails = new Set(
      [p.schoolEmail, p.gmail].filter((e): e is string => !!e).map((e) => e.trim().toLowerCase()),
    );
    const candidates: member.ParticipationCandidate[] = [];
    for (const m of people) {
      if (m.status !== "invited" && m.status !== "considering") continue;
      const matchedBy: Array<"email" | "name"> = [];
      const memberEmails = [m.schoolEmail, m.gmail, m.contact]
        .filter((e): e is string => !!e)
        .map((e) => e.trim().toLowerCase());
      if (memberEmails.some((e) => wantEmails.has(e))) matchedBy.push("email");
      if (normalizeName(m.name) === p.normalizedName) matchedBy.push("name");
      if (matchedBy.length === 0) continue;
      candidates.push({
        memberId: m.id,
        name: m.name,
        status: m.status,
        schoolEmail: m.schoolEmail,
        gmail: m.gmail,
        version: m.version,
        matchedBy,
      });
    }
    const rank = (c: member.ParticipationCandidate): number =>
      (c.matchedBy.includes("email") ? 2 : 0) + (c.matchedBy.includes("name") ? 1 : 0);
    candidates.sort((a, b) => rank(b) - rank(a));
    return { candidates };
  }

  // ---- 参加届: 反映確定 (管理者) --------------------------------------------------
  /** 管理者が 参加届 の名簿反映を確定する。link=既存の招待中/検討中を在籍へ昇格・結合、
   *  create=新規メンバー作成、skip=対象外。link/create のみ roster を書き換える。 */
  async resolveParticipation(
    ctx: ReqCtx,
    participationId: string,
    body: member.ResolveParticipationRequest,
  ): Promise<member.ResolveParticipationResponse> {
    const p = await this.deps.repo.getParticipation(participationId);
    if (!p || p.orgId !== this.deps.orgId) throw errParticipationNotFound(participationId);
    const action = (body as { action?: unknown } | null)?.action;
    const now = this.deps.now();

    if (action === "skip") {
      const row: ParticipationRow = { ...p, memberId: null, reviewState: "skipped", updatedAt: now };
      await this.deps.repo.upsertParticipation(row);
      return { participation: toParticipation(row), member: null };
    }

    if (action === "link") {
      const memberId = optText((body as { memberId?: unknown }).memberId, "memberId");
      if (!memberId) throw errors.validationFailed([{ field: "memberId", reason: "required" }]);
      const expectedVersion = (body as { expectedVersion?: unknown }).expectedVersion;
      if (typeof expectedVersion !== "number") {
        throw errors.validationFailed([{ field: "expectedVersion", reason: "required" }]);
      }
      const target = await this.deps.repo.getPerson(memberId);
      if (!target || target.orgId !== this.deps.orgId) throw errPersonNotFound(memberId);
      // 整合ガード: 同一メンバーを別の 参加届 に二重紐付けしない（1メンバー=1反映元）。
      const others = await this.deps.repo.listParticipations(this.deps.orgId);
      const clash = others.find((o) => o.id !== p.id && o.memberId === memberId && o.reviewState === "added");
      if (clash) {
        throw new DubError(
          "MEMBER_PARTICIPATION_ALREADY_LINKED",
          `member ${memberId} is already linked to another 参加届`,
          { status: 409, details: [{ field: "memberId", reason: "already_linked", message: clash.id }] },
        );
      }
      const resolved = await this.promoteFromParticipation(target, p, expectedVersion);
      const row: ParticipationRow = {
        ...p,
        memberId: resolved.id,
        matchKind: "linked_existing",
        reviewState: "added",
        updatedAt: now,
      };
      await this.deps.repo.upsertParticipation(row);
      return { participation: toParticipation(row), member: resolved };
    }

    if (action === "create") {
      const resolved = await this.createMemberFromParticipation(ctx, p);
      const row: ParticipationRow = {
        ...p,
        memberId: resolved.id,
        matchKind: "created_new",
        reviewState: "added",
        updatedAt: now,
      };
      await this.deps.repo.upsertParticipation(row);
      return { participation: toParticipation(row), member: resolved };
    }

    throw errors.validationFailed([{ field: "action", reason: "invalid" }]);
  }

  /** desiredTeamId が今も実在すれば返す (削除済みは無視)。link/create 時の結合に使う。 */
  private async liveDesiredTeamId(desiredTeamId: string | null): Promise<string | null> {
    if (!desiredTeamId) return null;
    const t = await this.deps.repo.getTeam(desiredTeamId);
    return t && t.orgId === this.deps.orgId ? t.id : null;
  }

  /** 既存メンバー(招待中/検討中想定)を在籍(added)へ昇格し、参加届の内容を非破壊マージする。
   *  空欄のみ埋め、希望チームを追加する。楽観ロック(expectedVersion)で衝突は 409。 */
  private async promoteFromParticipation(
    match: PersonRow,
    p: ParticipationRow,
    expectedVersion: number,
  ): Promise<member.Member> {
    const desiredTeamId = await this.liveDesiredTeamId(p.desiredTeamId);
    const currentTeamIds = await this.currentTeamIds(match.id);
    const mergedTeamIds =
      desiredTeamId && !currentTeamIds.includes(desiredTeamId)
        ? [...currentTeamIds, desiredTeamId]
        : currentTeamIds;
    const promote = match.status === "invited" || match.status === "considering";
    const next: PersonRow = {
      ...match,
      status: promote ? "added" : match.status,
      // 非破壊: 空欄のみ補完。参加届の2アドレスは名簿にも保持 (contact 未設定は学校メール)。
      department: match.department ?? p.department,
      grade: match.grade ?? p.grade,
      contact: match.contact ?? p.schoolEmail,
      schoolEmail: match.schoolEmail ?? p.schoolEmail,
      gmail: match.gmail ?? p.gmail,
      lastName: match.lastName ?? p.lastName,
      firstName: match.firstName ?? p.firstName,
      lastNameKana: match.lastNameKana ?? p.lastNameKana,
      firstNameKana: match.firstNameKana ?? p.firstNameKana,
      lastNameRomaji: match.lastNameRomaji ?? p.lastNameRomaji,
      firstNameRomaji: match.firstNameRomaji ?? p.firstNameRomaji,
      phone: match.phone ?? p.phone,
      note: match.note ?? p.note,
      version: match.version + 1,
      updatedAt: this.deps.now(),
    };
    const ok = await this.deps.repo.updatePerson(next, expectedVersion, mergedTeamIds);
    if (!ok) throw errVersionConflict(match.id);
    return toMember(next, mergedTeamIds);
  }

  /** 参加届の内容から新規の在籍(added)メンバーを作成する。 */
  private async createMemberFromParticipation(ctx: ReqCtx, p: ParticipationRow): Promise<member.Member> {
    const orgId = this.deps.orgId;
    const now = this.deps.now();
    const desiredTeamId = await this.liveDesiredTeamId(p.desiredTeamId);
    const teamIds = desiredTeamId ? [desiredTeamId] : [];
    const row: PersonRow = {
      id: this.deps.newMemberId(),
      orgId,
      name: p.name,
      roleTitle: null,
      status: "added",
      department: p.department,
      grade: p.grade,
      identityUserId: null,
      contact: p.contact ?? p.schoolEmail,
      schoolEmail: p.schoolEmail,
      gmail: p.gmail,
      lastName: p.lastName,
      firstName: p.firstName,
      lastNameKana: p.lastNameKana,
      firstNameKana: p.firstNameKana,
      lastNameRomaji: p.lastNameRomaji,
      firstNameRomaji: p.firstNameRomaji,
      phone: p.phone,
      note: p.note,
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

  async listParticipations(_ctx: ReqCtx): Promise<member.ListParticipationsResponse> {
    const rows = await this.deps.repo.listParticipations(this.deps.orgId);
    return { participations: rows.map(toParticipation) };
  }
}

function invalid(field: string): never {
  throw errors.validationFailed([{ field, reason: "invalid" }]);
}
