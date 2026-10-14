// LP 登壇者募集: validation + ProposalService (settings / fields / submissions / public submit).
// The custom-field vocabulary and answer validation are shared with tickets.
import { errors, type FieldError } from "@dub/errors";
import { lp } from "@dub/types";
import { BUYER_EMAIL_MAX, BUYER_NAME_MAX, EMAIL_RE, jstDayStartIso, parseAnswers, parseFields } from "./tickets";
import type {
  AppDeps,
  LpProposal,
  LpProposalStatus,
  LpProposalsPage,
  LpProposalsState,
  LpTicketField,
  ProposalRow,
  ReqCtx,
} from "./types";

export const PROPOSAL_SITE = lp.LP_PUBLISH_SITE;
export const PROPOSAL_TITLE_MAX = 100;
export const PROPOSAL_ABSTRACT_MAX = 2000;
/** 氏名・メール・タイトル・概要は固定項目なのでカスタム項目の id に使わせない。 */
const RESERVED_PROPOSAL_FIELD_IDS: ReadonlySet<string> = new Set(["name", "email", "title", "abstract"]);
const STATUSES: ReadonlySet<LpProposalStatus> = new Set(["submitted", "accepted", "rejected"]);

/** Fields shown until LP管理 saves its own list (fields_json NULL). */
export const DEFAULT_PROPOSAL_FIELDS: readonly LpTicketField[] = [
  { id: "format", label: "発表形式", type: "select", required: true, options: ["セッション（30分）", "LT（5分）"] },
  { id: "affiliation", label: "所属", type: "text", required: false, options: [] },
  { id: "bio", label: "自己紹介", type: "textarea", required: false, options: [] },
];

/** 同じ送信元（IP ハッシュ）から 1 日 (JST) に受け付ける応募数。全体上限をボット 1 台で使い切らせない。
 *  学内 NAT など 1 つの IP を共有する応募者を弾かない程度に緩める。 */
export const PER_CLIENT_DAILY_CAP = 20;
const CLIENT_KEY_RE = /^[a-f0-9]{16,64}$/;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export interface ProposalInput {
  name: string;
  email: string;
  title: string;
  abstract: string;
  answers: LpProposal["answers"];
}

/** Validates the public form against the configured fields. Throws 400 with per-field reasons. */
export function parseProposal(body: unknown, fields: readonly LpTicketField[]): ProposalInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad: FieldError[] = [];
  const text = (k: string, max: number): string => {
    const v = typeof b[k] === "string" ? (b[k] as string).trim() : "";
    if (!v) bad.push({ field: k, reason: "required" });
    else if (v.length > max) bad.push({ field: k, reason: "too_long" });
    return v;
  };
  const name = text("name", BUYER_NAME_MAX);
  const email = text("email", BUYER_EMAIL_MAX);
  if (email && email.length <= BUYER_EMAIL_MAX && !EMAIL_RE.test(email)) bad.push({ field: "email", reason: "invalid" });
  const title = text("title", PROPOSAL_TITLE_MAX);
  const abstract = text("abstract", PROPOSAL_ABSTRACT_MAX);
  const answers = parseAnswers(b.answers, fields, bad);
  if (bad.length > 0) throw errors.validationFailed(bad);
  return { name, email, title, abstract, answers };
}

export function proposalCursor(p: { createdAt: string; id: string }): string {
  return `${p.createdAt}~${p.id}`;
}

const toProposal = ({ site: _s, clientKey: _c, ...p }: ProposalRow): LpProposal => p;

export class ProposalService {
  constructor(private readonly deps: AppDeps) {}

  private get repo() {
    return this.deps.repo;
  }

  private async fields(): Promise<LpTicketField[]> {
    return (await this.repo.getProposalSettings(PROPOSAL_SITE))?.fields ?? [...DEFAULT_PROPOSAL_FIELDS];
  }

  async getState(): Promise<LpProposalsState> {
    const [settings, totals] = await Promise.all([
      this.repo.getProposalSettings(PROPOSAL_SITE),
      this.repo.proposalTotals(PROPOSAL_SITE),
    ]);
    return {
      site: PROPOSAL_SITE,
      enabled: settings?.enabled ?? false,
      publicUrl: `${this.deps.lpBaseUrl.replace(/\/+$/, "")}/proposals`,
      fields: settings?.fields ?? [...DEFAULT_PROPOSAL_FIELDS],
      totals,
      updatedAt: settings?.updatedAt ?? null,
      updatedBy: settings?.updatedBy ?? null,
    };
  }

  async setEnabled(ctx: ReqCtx, body: unknown): Promise<LpProposalsState> {
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") throw errors.validationFailed([{ field: "enabled", reason: "required" }]);
    await this.repo.setProposalEnabled(PROPOSAL_SITE, enabled, ctx.userId, this.deps.now());
    return this.getState();
  }

  async setFields(ctx: ReqCtx, body: unknown): Promise<LpProposalsState> {
    const fields = parseFields(body, RESERVED_PROPOSAL_FIELD_IDS);
    await this.repo.setProposalFields(PROPOSAL_SITE, fields, ctx.userId, this.deps.now());
    return this.getState();
  }

  async list(q: { cursor?: string; limit?: string }): Promise<LpProposalsPage> {
    const parsed = Number(q.limit ?? DEFAULT_PAGE);
    const limit = Number.isFinite(parsed) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(parsed))) : DEFAULT_PAGE;
    const rows = await this.repo.listProposals(PROPOSAL_SITE, q.cursor || null, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toProposal),
      nextCursor: rows.length > limit && page.length > 0 ? proposalCursor(page[page.length - 1]!) : null,
    };
  }

  async setStatus(ctx: ReqCtx, id: string, body: unknown): Promise<LpProposal> {
    const status = (body as { status?: unknown } | null)?.status;
    if (typeof status !== "string" || !STATUSES.has(status as LpProposalStatus)) {
      throw errors.validationFailed([{ field: "status", reason: "invalid" }]);
    }
    const ok = await this.repo.setProposalStatus(PROPOSAL_SITE, id, status as LpProposalStatus, ctx.userId, this.deps.now());
    if (!ok) throw errors.notFound("lp_proposal", id);
    return toProposal((await this.repo.getProposal(PROPOSAL_SITE, id))!);
  }

  // ---- internal (public LP Worker) ----

  async getPublic(): Promise<{ enabled: boolean; fields: LpTicketField[] }> {
    const settings = await this.repo.getProposalSettings(PROPOSAL_SITE);
    return { enabled: settings?.enabled ?? false, fields: settings?.fields ?? [...DEFAULT_PROPOSAL_FIELDS] };
  }

  async submit(body: unknown): Promise<{ id: string }> {
    const settings = await this.repo.getProposalSettings(PROPOSAL_SITE);
    if (!settings?.enabled) throw errors.notFound("lp_proposals");
    const input = parseProposal(body, settings.fields ?? DEFAULT_PROPOSAL_FIELDS);
    const raw = (body as { clientKey?: unknown } | null)?.clientKey;
    const clientKey = typeof raw === "string" && CLIENT_KEY_RE.test(raw) ? raw : null;
    const now = this.deps.now();
    const since = jstDayStartIso(now);
    if (clientKey && (await this.repo.countProposalsSince(PROPOSAL_SITE, since, clientKey)) >= PER_CLIENT_DAILY_CAP) {
      throw errors.rateLimited(3600);
    }
    if ((await this.repo.countProposalsSince(PROPOSAL_SITE, since)) >= this.deps.dailyProposalCap) {
      throw errors.rateLimited(60);
    }
    const row: ProposalRow = {
      id: this.deps.newProposalId(),
      site: PROPOSAL_SITE,
      speakerName: input.name,
      email: input.email,
      title: input.title,
      abstract: input.abstract,
      answers: input.answers,
      status: "submitted",
      reviewedBy: null,
      clientKey,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertProposal(row);
    return { id: row.id };
  }
}
