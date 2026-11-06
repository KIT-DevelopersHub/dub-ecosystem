// スポンサー営業進捗と月間目標のビジネスロジック。HTTP 非依存。項目と選択肢は @dub/types sponsor が SoT。
//
// - 企業名だけ必須。ほかは trim して空なら null。
// - 取り込みは全行を検証してからまとめて登録する (1 行でも不正なら何も入らない)。
//   登録済みの企業 (companyKey が同じ) は飛ばすので、同じ表を貼り直しても重複しない。
// - ステータスが進むと節目の日付 (初回連絡日・提案日・内諾日) を日本時間の今日で埋める。
import { DubError, errors } from "@dub/errors";
import { sponsor } from "@dub/types";
import type { LeadRow, SponsorLeadRepo } from "./sponsor-lead-repo";
import type { ReqCtx } from "./service";
import type { AppDeps } from "./types";

const errLeadNotFound = (id: string): DubError =>
  new DubError("SPONSOR_LEAD_NOT_FOUND", `Sponsor lead not found: ${id}`, { status: 404 });
const errVersionConflict = (id: string): DubError =>
  new DubError("SPONSOR_VERSION_CONFLICT", `Version conflict for ${id}`, { status: 409 });

type Fields = sponsor.LeadFields;

const TEXT_FIELDS = [
  "industry", "owner", "contactName", "contactRole", "contactEmail", "source", "contactType", "nextAction", "budgetPeriod", "decisionPeriod",
] as const;
const LONG_TEXT_FIELDS = ["evidence", "note"] as const;
const DATE_FIELDS = ["firstContactOn", "lastContactOn", "proposedOn", "agreedOn", "nextActionOn"] as const;

function invalid(field: string, reason = "invalid"): DubError {
  return errors.validationFailed([{ field, reason }]);
}

function text(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(field);
  const t = value.trim();
  if (t.length > max) throw invalid(field, "too_long");
  return t === "" ? null : t;
}

function companyName(value: unknown): string {
  const t = text(value, "companyName", sponsor.CARD_FIELD_MAX);
  if (t === null) throw invalid("companyName", "required");
  return t;
}

function choice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (value === undefined || value === null || value === "") return null;
  if (!(allowed as readonly unknown[]).includes(value)) throw invalid(field);
  return value as T;
}

function status(value: unknown): sponsor.LeadStatus {
  const s = choice(value, "status", sponsor.LEAD_STATUSES);
  if (s === null) throw invalid("status", "required");
  return s;
}

function date(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(field);
  // 2026-02-31 のような存在しない日は Date が繰り上げるので往復で弾く。
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

function amount(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > sponsor.LEAD_AMOUNT_MAX) {
    throw invalid("expectedAmount");
  }
  return value;
}

/** 目標値。空 = 目標なし。0 は無意味 (達成率が出ない) なので受け付けない。 */
function target(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > sponsor.LEAD_AMOUNT_MAX) throw invalid(field);
  return value;
}

/** 検証して正規化した 1 項目。b に無い項目は呼ばない。 */
function parseField(b: Record<string, unknown>, f: keyof Fields): Fields[keyof Fields] {
  const v = b[f];
  switch (f) {
    case "companyName":
      return companyName(v);
    case "status":
      return status(v);
    case "priority":
      return choice(v, f, sponsor.LEAD_PRIORITIES);
    case "plan":
      return choice(v, f, sponsor.LEAD_PLANS);
    case "confidence":
      return choice(v, f, sponsor.LEAD_CONFIDENCES);
    case "expectedAmount":
      return amount(v);
    case "firstContactOn":
    case "lastContactOn":
    case "proposedOn":
    case "agreedOn":
    case "nextActionOn":
      return date(v, f);
    case "evidence":
    case "note":
      return text(v, f, sponsor.CARD_NOTE_MAX);
    default:
      return text(v, f, sponsor.CARD_FIELD_MAX);
  }
}

const ALL_FIELDS: readonly (keyof Fields)[] = [
  "companyName", "status", "priority", "plan", "confidence", "expectedAmount", ...TEXT_FIELDS, ...LONG_TEXT_FIELDS, ...DATE_FIELDS,
];

function parseFields(body: unknown): Fields {
  const b = { status: "未接触", ...((body ?? {}) as Record<string, unknown>) };
  return Object.fromEntries(ALL_FIELDS.map((f) => [f, parseField(b, f)])) as unknown as Fields;
}

function toLead(r: LeadRow): sponsor.SponsorLead {
  const { orgId: _o, archivedAt: _a, ...rest } = r;
  return rest;
}

export interface SponsorLeadDeps extends Pick<AppDeps, "orgId" | "now" | "repo"> {
  sponsorLeadRepo: SponsorLeadRepo;
  newSponsorLeadId: () => string;
}

export class SponsorLeadService {
  constructor(private readonly deps: SponsorLeadDeps) {}

  private async load(id: string): Promise<LeadRow> {
    const row = await this.deps.sponsorLeadRepo.getLead(id);
    if (!row || row.orgId !== this.deps.orgId || row.archivedAt !== null) throw errLeadNotFound(id);
    return row;
  }

  /** 登録者 (名簿の氏名) と現在時刻を付けて行を作る。 */
  private async toRows(ctx: ReqCtx, fields: readonly Fields[]): Promise<LeadRow[]> {
    const now = this.deps.now();
    const person = await this.deps.repo.getPersonByIdentityUserId(this.deps.orgId, ctx.userId);
    return fields.map((f) => ({
      ...f,
      id: this.deps.newSponsorLeadId(),
      orgId: this.deps.orgId,
      version: 1,
      createdBy: ctx.userId,
      createdByName: person?.name ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }));
  }

  async list(_ctx: ReqCtx): Promise<sponsor.ListLeadsResponse> {
    const rows = await this.deps.sponsorLeadRepo.listLeads(this.deps.orgId);
    return { leads: rows.map(toLead) };
  }

  async get(_ctx: ReqCtx, id: string): Promise<sponsor.SponsorLead> {
    return toLead(await this.load(id));
  }

  async create(ctx: ReqCtx, body: sponsor.CreateLeadRequest): Promise<sponsor.SponsorLead> {
    // 手で追加した行は今の出来事として日付を入れる (取り込みは過去分なので入れない)。
    const fields = sponsor.applyLeadMilestones("未接触", parseFields(body), [], sponsor.jstDate(this.deps.now()));
    const [row] = await this.toRows(ctx, [fields]);
    await this.deps.sponsorLeadRepo.createLeads([row!]);
    return toLead(row!);
  }

  async importLeads(ctx: ReqCtx, body: sponsor.ImportLeadsRequest): Promise<sponsor.ImportLeadsResponse> {
    const input = (body as { leads?: unknown } | null)?.leads;
    if (!Array.isArray(input) || input.length === 0) throw invalid("leads", "required");
    if (input.length > sponsor.LEAD_IMPORT_MAX) throw invalid("leads", "too_long");
    const parsed = input.map(parseFields);

    const seen = new Set((await this.deps.sponsorLeadRepo.listLeads(this.deps.orgId)).map((l) => sponsor.companyKey(l.companyName)));
    const fresh = parsed.filter((f) => {
      const key = sponsor.companyKey(f.companyName);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const rows = await this.toRows(ctx, fresh);
    await this.deps.sponsorLeadRepo.createLeads(rows);
    return { leads: rows.map(toLead), skipped: parsed.length - fresh.length };
  }

  /** 送られた項目だけ更新 (undefined = そのまま / null・空文字 = 消す)。 */
  async update(_ctx: ReqCtx, id: string, body: sponsor.UpdateLeadRequest): Promise<sponsor.SponsorLead> {
    const b = (body ?? {}) as unknown as Record<string, unknown>;
    if (typeof b.expectedVersion !== "number" || !Number.isInteger(b.expectedVersion)) throw invalid("expectedVersion", "required");
    const cur = await this.load(id);
    const next: LeadRow = { ...cur, version: cur.version + 1, updatedAt: this.deps.now() };
    const patch: Partial<Record<keyof Fields, unknown>> = {};
    for (const f of ALL_FIELDS) {
      if (b[f] !== undefined) patch[f] = parseField(b, f);
    }
    Object.assign(next, patch);
    const stamped = sponsor.applyLeadMilestones(cur.status, next, Object.keys(patch), sponsor.jstDate(next.updatedAt));
    if (!(await this.deps.sponsorLeadRepo.updateLead(stamped, b.expectedVersion))) throw errVersionConflict(id);
    return toLead(stamped);
  }

  async remove(_ctx: ReqCtx, id: string): Promise<void> {
    const cur = await this.load(id);
    const now = this.deps.now();
    const next: LeadRow = { ...cur, archivedAt: now, version: cur.version + 1, updatedAt: now };
    if (!(await this.deps.sponsorLeadRepo.updateLead(next, cur.version))) throw errVersionConflict(id);
  }

  async listGoals(_ctx: ReqCtx): Promise<sponsor.ListGoalsResponse> {
    return { goals: await this.deps.sponsorLeadRepo.listGoals(this.deps.orgId) };
  }

  async putGoal(ctx: ReqCtx, month: string, body: sponsor.PutGoalRequest): Promise<sponsor.MonthlyGoal> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw invalid("month");
    const b = (body ?? {}) as unknown as Record<string, unknown>;
    if (typeof b.expectedVersion !== "number" || !Number.isInteger(b.expectedVersion)) throw invalid("expectedVersion", "required");
    const targets = Object.fromEntries(sponsor.GOAL_METRICS.map((m) => [m, target(b[m], m)])) as sponsor.GoalTargets;
    const person = await this.deps.repo.getPersonByIdentityUserId(this.deps.orgId, ctx.userId);
    const goal: sponsor.MonthlyGoal = {
      ...targets,
      month,
      version: b.expectedVersion + 1,
      updatedBy: ctx.userId,
      updatedByName: person?.name ?? null,
      updatedAt: this.deps.now(),
    };
    if (!(await this.deps.sponsorLeadRepo.putGoal(this.deps.orgId, goal, b.expectedVersion))) throw errVersionConflict(month);
    return goal;
  }
}
