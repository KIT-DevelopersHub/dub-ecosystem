// 人事 (応募 → 選考 → 内定 → 参加 → オンボーディング) のビジネスロジック。HTTP 非依存。
//
// 名簿との関係 (重複させない):
//  - 参加確定 (join) は名簿 (member_people) を唯一の実体として扱う。新規なら既存の
//    MemberService.createMember で在籍 (added) の名簿行を作り、既存行 (招待中など) なら結ぶだけ。
//  - オンボーディングのチェックリストは 参加届アプリの案内項目 (member_onboarding_items) を
//    テンプレートとして読み、人事側はチェック状態 (member_hr_onboarding_checks) だけを持つ。
import { DubError, errors } from "@dub/errors";
import { hr, member } from "@dub/types";
import type { HrRepo, ApplicantRow } from "./hr-repo";
import type { MemberService, ReqCtx } from "./service";
import type { AppDeps } from "./types";

const MAX_TEXT = 2000;
const MAX_NAME = 100;

const errApplicantNotFound = (id: string): DubError =>
  new DubError("HR_APPLICANT_NOT_FOUND", `Applicant not found: ${id}`, { status: 404 });
const errVersionConflict = (id: string): DubError =>
  new DubError("HR_VERSION_CONFLICT", `Version conflict for ${id}`, { status: 409 });
const errBadTransition = (from: string, to: string): DubError =>
  new DubError("HR_INVALID_TRANSITION", `Cannot move applicant from ${from} to ${to}`, { status: 409 });

function text(value: unknown, field: string, max = MAX_TEXT): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw errors.validationFailed([{ field, reason: "invalid" }]);
  const t = value.trim();
  if (t.length > max) throw errors.validationFailed([{ field, reason: "too_long" }]);
  return t.length === 0 ? null : t;
}

function requiredName(value: unknown): string {
  const n = text(value, "name", MAX_NAME);
  if (!n) throw errors.validationFailed([{ field: "name", reason: "required" }]);
  return n;
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw errors.validationFailed([{ field: "expectedVersion", reason: "required" }]);
  }
  return value;
}

function toApplicant(r: ApplicantRow): hr.Applicant {
  const { orgId: _o, archivedAt: _a, ...wire } = r;
  return wire;
}

export interface HrDeps extends Pick<AppDeps, "orgId" | "now" | "repo"> {
  hrRepo: HrRepo;
  newHrId: (prefix: "app" | "hre") => string;
}

export class HrService {
  constructor(
    private readonly deps: HrDeps,
    private readonly members: MemberService,
  ) {}

  private async load(id: string): Promise<ApplicantRow> {
    const row = await this.deps.hrRepo.getApplicant(id);
    if (!row || row.orgId !== this.deps.orgId || row.archivedAt !== null) throw errApplicantNotFound(id);
    return row;
  }

  private async event(
    ctx: ReqCtx,
    applicantId: string,
    kind: hr.ApplicantEventKind,
    fields: { fromStage?: hr.ApplicantStage | null; toStage?: hr.ApplicantStage | null; body?: string | null },
  ): Promise<void> {
    await this.deps.hrRepo.addEvent({
      id: this.deps.newHrId("hre"),
      applicantId,
      kind,
      fromStage: fields.fromStage ?? null,
      toStage: fields.toStage ?? null,
      body: fields.body ?? null,
      actorId: ctx.userId,
      createdAt: this.deps.now(),
    });
  }

  private async teamId(value: unknown): Promise<string | null> {
    const id = text(value, "desiredTeamId", 200);
    if (!id) return null;
    const t = await this.deps.repo.getTeam(id);
    if (!t || t.orgId !== this.deps.orgId) throw errors.validationFailed([{ field: "desiredTeamId", reason: "not_found" }]);
    return id;
  }

  async list(_ctx: ReqCtx): Promise<hr.ListApplicantsResponse> {
    const rows = await this.deps.hrRepo.listApplicants(this.deps.orgId);
    return { applicants: rows.map(toApplicant) };
  }

  async get(_ctx: ReqCtx, id: string): Promise<hr.ApplicantDetail> {
    const row = await this.load(id);
    return { applicant: toApplicant(row), events: await this.deps.hrRepo.listEvents(id) };
  }

  async create(ctx: ReqCtx, body: hr.CreateApplicantRequest): Promise<hr.ApplicantDetail> {
    const now = this.deps.now();
    const row: ApplicantRow = {
      id: this.deps.newHrId("app"),
      orgId: this.deps.orgId,
      name: requiredName(body.name),
      nameKana: text(body.nameKana, "nameKana", MAX_NAME),
      email: text(body.email, "email", 200),
      department: text(body.department, "department", MAX_NAME),
      grade: text(body.grade, "grade", 20),
      desiredTeamId: await this.teamId(body.desiredTeamId),
      source: text(body.source, "source", MAX_NAME),
      motivation: text(body.motivation, "motivation"),
      stage: "applied",
      memberId: null,
      participationId: text(body.participationId, "participationId", 200),
      version: 1,
      archivedAt: null,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.hrRepo.createApplicant(row);
    await this.event(ctx, row.id, "created", { toStage: "applied" });
    return this.get(ctx, row.id);
  }

  async update(ctx: ReqCtx, id: string, body: hr.UpdateApplicantRequest): Promise<hr.Applicant> {
    const cur = await this.load(id);
    const expected = version(body.expectedVersion);
    const next: ApplicantRow = {
      ...cur,
      ...(body.name !== undefined ? { name: requiredName(body.name) } : {}),
      ...(body.nameKana !== undefined ? { nameKana: text(body.nameKana, "nameKana", MAX_NAME) } : {}),
      ...(body.email !== undefined ? { email: text(body.email, "email", 200) } : {}),
      ...(body.department !== undefined ? { department: text(body.department, "department", MAX_NAME) } : {}),
      ...(body.grade !== undefined ? { grade: text(body.grade, "grade", 20) } : {}),
      ...(body.desiredTeamId !== undefined ? { desiredTeamId: await this.teamId(body.desiredTeamId) } : {}),
      ...(body.source !== undefined ? { source: text(body.source, "source", MAX_NAME) } : {}),
      ...(body.motivation !== undefined ? { motivation: text(body.motivation, "motivation") } : {}),
      version: cur.version + 1,
      updatedAt: this.deps.now(),
    };
    if (!(await this.deps.hrRepo.updateApplicant(next, expected))) throw errVersionConflict(id);
    void ctx;
    return toApplicant(next);
  }

  /** 段階移動。joined へは join() だけが進める (名簿への追加を伴うため)。 */
  async moveStage(ctx: ReqCtx, id: string, body: hr.MoveApplicantStageRequest): Promise<hr.ApplicantDetail> {
    const cur = await this.load(id);
    const expected = version(body.expectedVersion);
    if (!hr.isApplicantStage(body.stage)) throw errors.validationFailed([{ field: "stage", reason: "invalid" }]);
    if (!hr.canTransition(cur.stage, body.stage)) throw errBadTransition(cur.stage, body.stage);
    const next: ApplicantRow = { ...cur, stage: body.stage, version: cur.version + 1, updatedAt: this.deps.now() };
    if (!(await this.deps.hrRepo.updateApplicant(next, expected))) throw errVersionConflict(id);
    await this.event(ctx, id, "stage", { fromStage: cur.stage, toStage: body.stage, body: text(body.note, "note") });
    return this.get(ctx, id);
  }

  async addNote(ctx: ReqCtx, id: string, body: hr.AddApplicantNoteRequest): Promise<hr.ApplicantDetail> {
    await this.load(id);
    const note = text(body.body, "body");
    if (!note) throw errors.validationFailed([{ field: "body", reason: "required" }]);
    await this.event(ctx, id, "note", { body: note });
    return this.get(ctx, id);
  }

  /**
   * 参加確定 (内定 → 参加)。名簿に在籍メンバーとして入れる:
   *  - memberId 指定: 既存の名簿行 (招待中/検討中など) に結ぶ。招待中/検討中なら在籍に上げる。
   *  - 省略: 応募内容から在籍 (added) の名簿行を MemberService.createMember で作る。
   */
  async join(ctx: ReqCtx, id: string, body: hr.JoinApplicantRequest): Promise<hr.JoinApplicantResponse> {
    const cur = await this.load(id);
    const expected = version(body.expectedVersion);
    if (cur.stage !== "offered") throw errBadTransition(cur.stage, "joined");
    if (cur.version !== expected) throw errVersionConflict(id);

    let memberId: string;
    const linkTo = text(body.memberId, "memberId", 200);
    if (linkTo) {
      const person = await this.deps.repo.getPerson(linkTo);
      if (!person || person.orgId !== this.deps.orgId || person.archivedAt !== null) {
        throw errors.validationFailed([{ field: "memberId", reason: "not_found" }]);
      }
      if (person.status === "invited" || person.status === "considering") {
        const promoted = { ...person, status: "added" as const, version: person.version + 1, updatedAt: this.deps.now() };
        if (!(await this.deps.repo.updatePerson(promoted, person.version))) throw errVersionConflict(person.id);
      }
      memberId = person.id;
    } else {
      const grade = cur.grade ? member.normalizeGrade(cur.grade) : null;
      const created = await this.members.createMember(ctx, {
        name: cur.name,
        status: "added",
        teamIds: cur.desiredTeamId ? [cur.desiredTeamId] : [],
        contact: cur.email,
        ...(cur.department ? { department: cur.department } : {}),
        ...(grade ? { grade } : {}),
      });
      memberId = created.id;
    }

    const next: ApplicantRow = { ...cur, stage: "joined", memberId, version: cur.version + 1, updatedAt: this.deps.now() };
    if (!(await this.deps.hrRepo.updateApplicant(next, expected))) throw errVersionConflict(id);
    await this.event(ctx, id, "joined", { fromStage: cur.stage, toStage: "joined", body: linkTo ? "既存の名簿に紐付け" : "名簿に新規追加" });
    return { applicant: toApplicant(next), memberId };
  }

  /** 論理削除 (履歴は残す)。 */
  async remove(ctx: ReqCtx, id: string): Promise<void> {
    const cur = await this.load(id);
    const next: ApplicantRow = { ...cur, archivedAt: this.deps.now(), version: cur.version + 1, updatedAt: this.deps.now() };
    if (!(await this.deps.hrRepo.updateApplicant(next, cur.version))) throw errVersionConflict(id);
    void ctx;
  }

  /** 参加済み応募者ごとのオンボーディング進捗。項目は参加届アプリの案内項目。 */
  async onboarding(_ctx: ReqCtx): Promise<hr.ListOnboardingProgressResponse> {
    const orgId = this.deps.orgId;
    const [items, applicants] = await Promise.all([
      this.deps.repo.listOnboardingItems(orgId),
      this.deps.hrRepo.listApplicants(orgId),
    ]);
    const joined = applicants.filter((a) => a.stage === "joined" && a.memberId);
    const personIds = joined.map((a) => a.memberId as string);
    const checks = await this.deps.hrRepo.listOnboardingChecks(personIds);
    const itemIds = new Set(items.map((i) => i.id));
    const members: hr.OnboardingProgress[] = [];
    for (const a of joined) {
      const person = await this.deps.repo.getPerson(a.memberId as string);
      if (!person || person.archivedAt !== null) continue;
      const checked = checks.filter((c) => c.personId === person.id && itemIds.has(c.itemId)).map((c) => c.itemId);
      members.push({
        memberId: person.id,
        name: person.name,
        applicantId: a.id,
        joinedAt: a.updatedAt,
        checkedItemIds: checked,
        total: items.length,
        done: checked.length,
        completed: items.length > 0 && checked.length === items.length,
      });
    }
    return {
      items: items.map((i) => ({ id: i.id, title: i.title, description: i.description, url: i.url })),
      members,
    };
  }

  async setOnboardingCheck(
    ctx: ReqCtx,
    personId: string,
    itemId: string,
    body: hr.SetOnboardingCheckRequest,
  ): Promise<hr.OnboardingProgress> {
    if (typeof body.checked !== "boolean") throw errors.validationFailed([{ field: "checked", reason: "required" }]);
    const person = await this.deps.repo.getPerson(personId);
    if (!person || person.orgId !== this.deps.orgId || person.archivedAt !== null) {
      throw new DubError("MEMBER_NOT_FOUND", `Member not found: ${personId}`, { status: 404 });
    }
    const item = await this.deps.repo.getOnboardingItem(itemId);
    if (!item || item.orgId !== this.deps.orgId) {
      throw new DubError("MEMBER_ONBOARDING_ITEM_NOT_FOUND", `Onboarding item not found: ${itemId}`, { status: 404 });
    }
    await this.deps.hrRepo.setOnboardingCheck(
      { personId, itemId, checkedBy: ctx.userId, checkedAt: this.deps.now() },
      body.checked,
    );
    const progress = (await this.onboarding(ctx)).members.find((m) => m.memberId === personId);
    if (progress) return progress;
    // 人事経由でない名簿行にもチェックは付けられる (進捗一覧には出ない)。
    const items = await this.deps.repo.listOnboardingItems(this.deps.orgId);
    const checked = (await this.deps.hrRepo.listOnboardingChecks([personId])).map((c) => c.itemId);
    return {
      memberId: personId,
      name: person.name,
      applicantId: null,
      joinedAt: null,
      checkedItemIds: checked,
      total: items.length,
      done: checked.length,
      completed: items.length > 0 && checked.length === items.length,
    };
  }
}
