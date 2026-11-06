// スポンサーのメール連携。Dub のメールで営業先とやり取りしたら、営業進捗の日付とステータスを自動で進める。
// 照合と更新の決まりは @dub/types sponsor (buildLeadMatcher / applyMailContacts) が唯一の正本で、ここは
// 「どのメールを・どの営業先に・どう保存するか」だけを持つ。
//
// - 送受信のたび (live): mail-gateway が /members/internal/sponsor/mail-activity を呼ぶ (best-effort)。
// - 画面で紐付けた時 (link): そのアドレスとの既存メールを mail-gateway から集計して当てる。
// - 管理者の一括補完 (backfill): 営業先を offset/limit で区切って同じことをする (1 回の呼び出しで D1 と
//   mail-gateway を合わせて十数回以内 = Workers 無料プランの 50 subrequest に収まる)。
// どの経路も決まりが単調 (日付は min/max・ステータスは前にだけ) なので、何度当てても結果は同じ。
//
// 楽観ロック: 自動更新は手入力の編集を上書きしない。version が合わなければ最新を読み直して決まりを
// 当て直し、最大 3 回まで試す (手入力の値はそのまま残り、その上にメールの日付が足される)。
import { DubError, errors } from "@dub/errors";
import { sponsor } from "@dub/types";
import type { ReqCtx } from "./service";
import type { LeadRow, SponsorLeadRepo } from "./sponsor-lead-repo";
import type { ActivityRow, LeadAutoUpdate, MailLinkRow, SponsorMailRepo } from "./sponsor-mail-repo";
import type { AppDeps } from "./types";

/** mail-gateway の集計 (POST /internal/sponsor/contacts)。未結線なら undefined。 */
export interface MailContactsSource {
  query(ctx: { requestId: string }, q: sponsor.MailContactsQuery): Promise<sponsor.MailContactSummary[]>;
}

export interface SponsorMailDeps extends Pick<AppDeps, "orgId" | "now" | "repo"> {
  sponsorLeadRepo: SponsorLeadRepo;
  sponsorMailRepo: SponsorMailRepo;
  newSponsorMailId: (prefix: "mlink" | "lact") => string;
  mailContacts?: MailContactsSource;
}

/** 楽観ロックに負けた時に読み直して当て直す回数。 */
const MAX_ATTEMPTS = 3;

/** 1 通 (または集計の端) のメール。 */
interface Evidence {
  direction: sponsor.MailDirection;
  at: string;
  counterpart: string;
  matchedBy: sponsor.MailMatchBy;
  mailbox: string | null;
}

interface Plan {
  leadId: string;
  evidence: Evidence[];
}

interface Outcome {
  lead: LeadRow;
  plan: Plan;
  changes: sponsor.LeadFieldChange[];
  applied: boolean;
}

const MATCH_RANK: Record<sponsor.MailMatchBy, number> = { link: 0, email: 1, domain: 2 };

const invalid = (field: string, reason = "invalid"): DubError => errors.validationFailed([{ field, reason }]);
const errLeadNotFound = (id: string): DubError => new DubError("SPONSOR_LEAD_NOT_FOUND", `Sponsor lead not found: ${id}`, { status: 404 });
const errLinkNotFound = (id: string): DubError => new DubError("SPONSOR_MAIL_LINK_NOT_FOUND", `Mail link not found: ${id}`, { status: 404 });

const contactsOf = (evidence: readonly Evidence[]): sponsor.MailContact[] =>
  evidence.map((e) => ({ direction: e.direction, on: sponsor.jstDate(e.at) }));

/** 履歴に残す「根拠のメール」: 初回連絡日を決めた送信、無ければ一番新しいメール。 */
function primaryEvidence(evidence: readonly Evidence[], changes: readonly sponsor.LeadFieldChange[]): Evidence {
  const first = changes.find((c) => c.field === "firstContactOn")?.to;
  const sent = first ? evidence.find((e) => e.direction === "sent" && sponsor.jstDate(e.at) === first) : undefined;
  return sent ?? [...evidence].sort((a, b) => b.at.localeCompare(a.at))[0]!;
}

function bestMatch(evidence: readonly Evidence[]): sponsor.MailMatchBy {
  return evidence.reduce<sponsor.MailMatchBy>((m, e) => (MATCH_RANK[e.matchedBy] < MATCH_RANK[m] ? e.matchedBy : m), "domain");
}

export class SponsorMailService {
  constructor(private readonly deps: SponsorMailDeps) {}

  private async matcher(): Promise<{ leads: LeadRow[]; links: MailLinkRow[]; match: (a: string) => sponsor.LeadMatch | null }> {
    const [leads, links] = await Promise.all([
      this.deps.sponsorLeadRepo.listLeads(this.deps.orgId),
      this.deps.sponsorMailRepo.listLinks(this.deps.orgId),
    ]);
    return { leads, links, match: sponsor.buildLeadMatcher(leads, links) };
  }

  /**
   * 決まりを当てて保存する。version 競合した営業先は読み直して当て直す。変化が無い営業先は保存しない。
   * dryRun なら保存せず、今の値に当てた結果だけ返す。
   */
  private async commit(
    leads: readonly LeadRow[],
    plans: readonly Plan[],
    source: sponsor.MailSyncSource,
    dryRun: boolean,
  ): Promise<Outcome[]> {
    const byId = new Map(leads.map((l) => [l.id, l]));
    const outcomes = new Map<string, Outcome>();
    let pending = plans.filter((p) => byId.has(p.leadId));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length > 0; attempt++) {
      const updates: (LeadAutoUpdate & { plan: Plan })[] = [];
      const now = this.deps.now();
      for (const plan of pending) {
        const cur = byId.get(plan.leadId)!;
        const { next, changes } = sponsor.applyMailContacts(cur, contactsOf(plan.evidence));
        outcomes.set(plan.leadId, { lead: cur, plan, changes, applied: false });
        if (changes.length === 0 || dryRun) continue;
        const ev = primaryEvidence(plan.evidence, changes);
        const activity: ActivityRow = {
          id: this.deps.newSponsorMailId("lact"),
          orgId: this.deps.orgId,
          leadId: cur.id,
          source,
          direction: ev.direction,
          mailAt: ev.at,
          counterpart: ev.counterpart,
          matchedBy: bestMatch(plan.evidence),
          mailbox: ev.mailbox,
          changes,
          createdAt: now,
        };
        updates.push({ next: { ...next, version: cur.version + 1, updatedAt: now }, expectedVersion: cur.version, activity, plan });
      }
      if (updates.length === 0) break;
      const saved = await this.deps.sponsorMailRepo.applyAutoUpdates(updates);
      const conflicted: Plan[] = [];
      updates.forEach((u, i) => {
        if (saved[i]) outcomes.set(u.plan.leadId, { ...outcomes.get(u.plan.leadId)!, lead: u.next, applied: true });
        else conflicted.push(u.plan);
      });
      if (conflicted.length === 0) break;
      // 他の人が先に保存した: 最新を読み直して (消された行は外して) 当て直す。
      const fresh = await this.deps.sponsorLeadRepo.listLeads(this.deps.orgId);
      byId.clear();
      for (const l of fresh) byId.set(l.id, l);
      pending = conflicted.filter((p) => byId.has(p.leadId));
    }
    return [...outcomes.values()];
  }

  // ── live: mail-gateway からの通知 ──────────────────────────

  async recordMailActivity(body: sponsor.MailActivityNotice): Promise<sponsor.MailActivityResult> {
    const b = (body ?? {}) as Partial<sponsor.MailActivityNotice>;
    if (b.direction !== "sent" && b.direction !== "received") throw invalid("direction");
    if (typeof b.at !== "string" || Number.isNaN(Date.parse(b.at))) throw invalid("at");
    if (!Array.isArray(b.counterparts)) throw invalid("counterparts");
    const at = new Date(b.at).toISOString();
    const mailbox = typeof b.mailbox === "string" ? b.mailbox : null;
    const counterparts = b.counterparts.filter((v): v is string => typeof v === "string").slice(0, sponsor.MAIL_CONTACTS_QUERY_MAX);
    if (counterparts.length === 0) return { updated: 0 };

    const { leads, match } = await this.matcher();
    const plans = new Map<string, Plan>();
    for (const raw of counterparts) {
      const m = match(raw);
      const address = sponsor.normalizeAddress(raw);
      if (!m || !address) continue;
      const plan = plans.get(m.leadId) ?? { leadId: m.leadId, evidence: [] };
      plan.evidence.push({ direction: b.direction, at, counterpart: address, matchedBy: m.by, mailbox });
      plans.set(m.leadId, plan);
    }
    const outcomes = await this.commit(leads, [...plans.values()], "live", false);
    return { updated: outcomes.filter((o) => o.applied).length };
  }

  // ── 集計を営業先ごとの計画に ──────────────────────────────

  /** mail-gateway の集計を、照合できた営業先ごとの根拠に分ける (onlyLeads に入る営業先だけ)。 */
  private plansFrom(
    summaries: readonly sponsor.MailContactSummary[],
    match: (a: string) => sponsor.LeadMatch | null,
    onlyLeads: ReadonlySet<string>,
  ): Plan[] {
    const plans = new Map<string, Plan>();
    for (const s of summaries) {
      const m = match(s.address);
      if (!m || !onlyLeads.has(m.leadId)) continue;
      const plan = plans.get(m.leadId) ?? { leadId: m.leadId, evidence: [] };
      const ev = (at: string): Evidence => ({ direction: s.direction, at, counterpart: s.address, matchedBy: m.by, mailbox: null });
      // 送信は最初 (初回連絡日) と最後 (最終接触日)、受信は最後だけで決まりの結果は全件と同じになる。
      if (s.direction === "sent") plan.evidence.push(ev(s.firstAt));
      if (s.direction === "received" || s.lastAt !== s.firstAt) plan.evidence.push(ev(s.lastAt));
      plans.set(m.leadId, plan);
    }
    return [...plans.values()];
  }

  /** 営業先の担当者メールと紐付けから、mail-gateway に聞くアドレスとドメインを作る。 */
  private queryFor(leads: readonly LeadRow[], links: readonly MailLinkRow[]): sponsor.MailContactsQuery {
    const ids = new Set(leads.map((l) => l.id));
    const addresses = new Set<string>();
    for (const l of leads) for (const a of sponsor.parseContactEmails(l.contactEmail)) addresses.add(a);
    for (const k of links) if (ids.has(k.leadId)) addresses.add(k.address);
    const domains = new Set([...addresses].map(sponsor.mailDomain).filter(sponsor.isCompanyDomain));
    return {
      addresses: [...addresses].slice(0, sponsor.MAIL_CONTACTS_QUERY_MAX),
      domains: [...domains].slice(0, sponsor.MAIL_CONTACTS_QUERY_MAX),
    };
  }

  // ── 画面: 紐付け ──────────────────────────────────────────

  async listLinks(_ctx: ReqCtx): Promise<sponsor.ListMailLinksResponse> {
    const links = await this.deps.sponsorMailRepo.listLinks(this.deps.orgId);
    return { links: links.map(({ orgId: _o, ...l }) => l) };
  }

  /**
   * アドレスを営業先に紐付ける。担当者メールが空なら入れ、そのアドレスとの既存メールをすぐ当てる
   * (mail-gateway が使えない時は紐付けだけ保存して、次のメールから効く)。
   */
  async createLink(ctx: ReqCtx, leadId: string, body: sponsor.CreateMailLinkRequest): Promise<sponsor.CreateMailLinkResponse> {
    const b = (body ?? {}) as Partial<sponsor.CreateMailLinkRequest>;
    const address = sponsor.normalizeAddress(typeof b.address === "string" ? b.address : null);
    if (!address) throw invalid("address");
    if (sponsor.OWN_MAIL_DOMAINS.includes(sponsor.mailDomain(address))) throw invalid("address", "internal");
    const threadId = typeof b.threadId === "string" && b.threadId.trim() !== "" ? b.threadId.trim().slice(0, 500) : null;

    let lead = await this.deps.sponsorLeadRepo.getLead(leadId);
    if (!lead || lead.orgId !== this.deps.orgId || lead.archivedAt !== null) throw errLeadNotFound(leadId);
    const person = await this.deps.repo.getPersonByIdentityUserId(this.deps.orgId, ctx.userId);
    const link = await this.deps.sponsorMailRepo.upsertLink({
      id: this.deps.newSponsorMailId("mlink"),
      orgId: this.deps.orgId,
      leadId,
      address,
      threadId,
      createdBy: ctx.userId,
      createdByName: person?.name ?? null,
      createdAt: this.deps.now(),
    });

    // 担当者メールが空なら入れる (手入力と同じく version を進める。競合したら読み直して、まだ空なら入れる)。
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && lead && lead.contactEmail === null; attempt++) {
      const next: LeadRow = { ...lead, contactEmail: address, version: lead.version + 1, updatedAt: this.deps.now() };
      if (await this.deps.sponsorLeadRepo.updateLead(next, lead.version)) lead = next;
      else lead = await this.deps.sponsorLeadRepo.getLead(leadId);
    }

    if (this.deps.mailContacts && lead) {
      try {
        const summaries = await this.deps.mailContacts.query(ctx, { addresses: [address], domains: [] });
        const { leads, match } = await this.matcher();
        const [outcome] = await this.commit(leads, this.plansFrom(summaries, match, new Set([leadId])), "link", false);
        if (outcome) lead = outcome.lead;
      } catch {
        // 集計できなくても紐付けは保存済み。次の送受信から効く。
      }
    }
    if (!lead) throw errLeadNotFound(leadId);
    const { orgId: _o, ...savedLink } = link;
    const { orgId: _lo, archivedAt: _a, ...savedLead } = lead;
    return { link: savedLink, lead: savedLead };
  }

  async deleteLink(_ctx: ReqCtx, id: string): Promise<void> {
    if (!(await this.deps.sponsorMailRepo.deleteLink(this.deps.orgId, id))) throw errLinkNotFound(id);
  }

  async listActivity(_ctx: ReqCtx, leadId: string): Promise<sponsor.ListLeadActivityResponse> {
    const lead = await this.deps.sponsorLeadRepo.getLead(leadId);
    if (!lead || lead.orgId !== this.deps.orgId || lead.archivedAt !== null) throw errLeadNotFound(leadId);
    return { activity: await this.deps.sponsorMailRepo.listActivity(this.deps.orgId, leadId) };
  }

  // ── 管理者: 既存メールからの一括補完 ──────────────────────

  async backfill(ctx: ReqCtx, body: sponsor.MailBackfillRequest): Promise<sponsor.MailBackfillResponse> {
    const b = (body ?? {}) as Partial<sponsor.MailBackfillRequest>;
    if (typeof b.dryRun !== "boolean") throw invalid("dryRun", "required");
    const offset = b.offset ?? 0;
    const limit = b.limit ?? sponsor.MAIL_BACKFILL_DEFAULT_LIMIT;
    if (!Number.isInteger(offset) || offset < 0) throw invalid("offset");
    if (!Number.isInteger(limit) || limit < 1 || limit > sponsor.MAIL_BACKFILL_MAX_LIMIT) throw invalid("limit");
    if (!this.deps.mailContacts) throw new DubError("SPONSOR_MAIL_UNAVAILABLE", "mail-gateway binding is not configured", { status: 503 });

    // 照合 (曖昧さの判定) は全社で、更新はこのページの営業先だけ。id 順で区切るので並びが変わってもずれない。
    const { leads, links, match } = await this.matcher();
    const ordered = [...leads].sort((a, x) => a.id.localeCompare(x.id));
    const page = ordered.slice(offset, offset + limit);
    const nextOffset = offset + limit < ordered.length ? offset + limit : null;
    const base = { dryRun: b.dryRun, offset, limit, total: ordered.length, nextOffset };

    const q = this.queryFor(page, links);
    if (q.addresses.length === 0) return { ...base, proposals: [] };
    const summaries = await this.deps.mailContacts.query(ctx, q);
    const plans = this.plansFrom(summaries, match, new Set(page.map((l) => l.id)));
    const outcomes = await this.commit(leads, plans, "backfill", b.dryRun);
    const proposals = outcomes
      .filter((o) => o.changes.length > 0)
      .map((o) => ({
        leadId: o.lead.id,
        companyName: o.lead.companyName,
        matchedBy: bestMatch(o.plan.evidence),
        changes: o.changes,
        evidence: o.plan.evidence.map((e) => ({ direction: e.direction, at: e.at, counterpart: e.counterpart })),
        ...(b.dryRun ? {} : { applied: o.applied }),
      }))
      .sort((a, x) => a.companyName.localeCompare(x.companyName, "ja"));
    return { ...base, proposals };
  }
}
