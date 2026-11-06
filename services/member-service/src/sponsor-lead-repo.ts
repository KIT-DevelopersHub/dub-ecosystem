// スポンサー営業進捗 (member_sponsor_leads) の永続化。名刺のリポジトリとは分け、同じ D1 `member` namespace を共有する。
import type { DbClient } from "@dub/db";
import type { common, sponsor } from "@dub/types";

export interface LeadRow extends sponsor.SponsorLead {
  orgId: common.OrgId;
  archivedAt: common.ISODateTime | null;
}

export interface SponsorLeadRepo {
  /** まとめて登録 (全件成功 or 全件失敗)。 */
  createLeads(rows: readonly LeadRow[]): Promise<void>;
  getLead(id: string): Promise<LeadRow | null>;
  /** 論理削除済みを除く。更新日時の新しい順。 */
  listLeads(orgId: common.OrgId): Promise<LeadRow[]>;
  /** 楽観ロック: version が expectedVersion のときだけ更新し true。 */
  updateLead(next: LeadRow, expectedVersion: number): Promise<boolean>;
}

const byUpdatedDesc = (a: LeadRow, b: LeadRow): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1;

export class InMemorySponsorLeadRepo implements SponsorLeadRepo {
  private leads = new Map<string, LeadRow>();

  async createLeads(rows: readonly LeadRow[]): Promise<void> {
    for (const r of rows) this.leads.set(r.id, { ...r });
  }
  async getLead(id: string): Promise<LeadRow | null> {
    const r = this.leads.get(id);
    return r ? { ...r } : null;
  }
  async listLeads(orgId: common.OrgId): Promise<LeadRow[]> {
    return [...this.leads.values()]
      .filter((l) => l.orgId === orgId && l.archivedAt === null)
      .sort(byUpdatedDesc)
      .map((l) => ({ ...l }));
  }
  async updateLead(next: LeadRow, expectedVersion: number): Promise<boolean> {
    const cur = this.leads.get(next.id);
    if (!cur || cur.version !== expectedVersion) return false;
    this.leads.set(next.id, { ...next });
    return true;
  }
}

interface LeadDbRow {
  id: string;
  org_id: string;
  company_name: string;
  industry: string | null;
  owner: string | null;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  source: string | null;
  contact_type: string | null;
  evidence: string | null;
  priority: string | null;
  plan: string | null;
  status: string;
  first_contact_on: string | null;
  last_contact_on: string | null;
  proposed_on: string | null;
  agreed_on: string | null;
  next_action: string | null;
  next_action_on: string | null;
  expected_amount: number | null;
  confidence: string | null;
  budget_period: string | null;
  decision_period: string | null;
  note: string | null;
  version: number;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toLeadRow(r: LeadDbRow): LeadRow {
  return {
    id: r.id,
    orgId: r.org_id,
    companyName: r.company_name,
    industry: r.industry,
    owner: r.owner,
    contactName: r.contact_name,
    contactRole: r.contact_role,
    contactEmail: r.contact_email,
    source: r.source,
    contactType: r.contact_type,
    evidence: r.evidence,
    priority: r.priority as sponsor.LeadPriority | null,
    plan: r.plan as sponsor.LeadPlan | null,
    status: r.status as sponsor.LeadStatus,
    firstContactOn: r.first_contact_on,
    lastContactOn: r.last_contact_on,
    proposedOn: r.proposed_on,
    agreedOn: r.agreed_on,
    nextAction: r.next_action,
    nextActionOn: r.next_action_on,
    expectedAmount: r.expected_amount,
    confidence: r.confidence as sponsor.LeadConfidence | null,
    budgetPeriod: r.budget_period,
    decisionPeriod: r.decision_period,
    note: r.note,
    version: r.version,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

/** 作成と更新で共通の業務項目 (列名と値の順を 1 か所に揃える)。 */
const FIELD_COLUMNS = [
  "company_name", "industry", "owner", "contact_name", "contact_role", "contact_email", "source", "contact_type", "evidence",
  "priority", "plan", "status", "first_contact_on", "last_contact_on", "proposed_on", "agreed_on", "next_action", "next_action_on", "expected_amount",
  "confidence", "budget_period", "decision_period", "note",
] as const;

const fieldValues = (l: LeadRow): unknown[] => [
  l.companyName, l.industry, l.owner, l.contactName, l.contactRole, l.contactEmail, l.source, l.contactType, l.evidence,
  l.priority, l.plan, l.status, l.firstContactOn, l.lastContactOn, l.proposedOn, l.agreedOn, l.nextAction, l.nextActionOn, l.expectedAmount,
  l.confidence, l.budgetPeriod, l.decisionPeriod, l.note,
];

const INSERT_COLUMNS = ["id", "org_id", ...FIELD_COLUMNS, "version", "created_by", "created_by_name", "created_at", "updated_at", "archived_at"];
const INSERT_SQL = `INSERT INTO member_sponsor_leads (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`;
const UPDATE_SQL = `UPDATE member_sponsor_leads SET ${FIELD_COLUMNS.map((c) => `${c} = ?`).join(", ")}, version = ?, updated_at = ?, archived_at = ? WHERE id = ? AND version = ?`;

export function createD1SponsorLeadRepo(db: DbClient): SponsorLeadRepo {
  return {
    async createLeads(rows) {
      if (rows.length === 0) return;
      await db.batch(
        rows.map((l) => ({
          sql: INSERT_SQL,
          binds: [l.id, l.orgId, ...fieldValues(l), l.version, l.createdBy, l.createdByName, l.createdAt, l.updatedAt, l.archivedAt],
        })),
      );
    },
    async getLead(id) {
      const r = await db.first<LeadDbRow>(`SELECT * FROM member_sponsor_leads WHERE id = ?`, id);
      return r ? toLeadRow(r) : null;
    },
    async listLeads(orgId) {
      const rows = await db.all<LeadDbRow>(
        `SELECT * FROM member_sponsor_leads WHERE org_id = ? AND archived_at IS NULL ORDER BY updated_at DESC, id DESC`,
        orgId,
      );
      return rows.map(toLeadRow);
    },
    async updateLead(l, expectedVersion) {
      const res = await db.run(UPDATE_SQL, ...fieldValues(l), l.version, l.updatedAt, l.archivedAt, l.id, expectedVersion);
      return res.meta.changes > 0;
    },
  };
}
