// スポンサーのメール連携の永続化: 自動更新の履歴 (member_sponsor_lead_activity)。
// 営業先の更新と履歴の追加は 1 つのトランザクション (D1 batch) で行い、
// 楽観ロックに負けた (他の人が先に保存した) 営業先には履歴も残さない。
import type { DbClient } from "@dub/db";
import type { common, sponsor } from "@dub/types";
import { fieldValues, UPDATE_SQL, type InMemorySponsorLeadRepo, type LeadRow } from "./sponsor-lead-repo";

export interface ActivityRow extends sponsor.LeadActivity {
  orgId: common.OrgId;
}

/** 営業先 1 社の自動更新 (version が expectedVersion のときだけ保存し、その時だけ履歴を足す)。 */
export interface LeadAutoUpdate {
  next: LeadRow;
  expectedVersion: number;
  activity: ActivityRow;
}

export interface SponsorMailRepo {
  /** 新しい順。 */
  listActivity(orgId: common.OrgId, leadId: string): Promise<sponsor.LeadActivity[]>;
  /** まとめて保存。戻り値は各更新が保存できたか (false = version 競合)。 */
  applyAutoUpdates(updates: readonly LeadAutoUpdate[]): Promise<boolean[]>;
}

const toActivity = ({ orgId: _o, ...a }: ActivityRow): sponsor.LeadActivity => a;
const byCreatedDesc = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export class InMemorySponsorMailRepo implements SponsorMailRepo {
  activity: ActivityRow[] = [];
  constructor(private readonly leads: InMemorySponsorLeadRepo) {}

  async listActivity(orgId: common.OrgId, leadId: string): Promise<sponsor.LeadActivity[]> {
    return this.activity.filter((a) => a.orgId === orgId && a.leadId === leadId).sort(byCreatedDesc).map(toActivity);
  }
  async applyAutoUpdates(updates: readonly LeadAutoUpdate[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (const u of updates) {
      const ok = await this.leads.updateLead(u.next, u.expectedVersion);
      if (ok) this.activity.push({ ...u.activity });
      out.push(ok);
    }
    return out;
  }
}

interface ActivityDbRow {
  id: string;
  org_id: string;
  lead_id: string;
  source: string;
  direction: string;
  mail_at: string;
  counterpart: string;
  matched_by: string;
  mailbox: string | null;
  changes_json: string;
  created_at: string;
}

function parseChanges(json: string): sponsor.LeadFieldChange[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as sponsor.LeadFieldChange[]) : [];
  } catch {
    return [];
  }
}

const toActivityFromDb = (r: ActivityDbRow): sponsor.LeadActivity => ({
  id: r.id,
  leadId: r.lead_id,
  source: r.source as sponsor.MailSyncSource,
  direction: r.direction as sponsor.MailDirection,
  mailAt: r.mail_at,
  counterpart: r.counterpart,
  matchedBy: r.matched_by as sponsor.MailMatchBy,
  mailbox: r.mailbox,
  changes: parseChanges(r.changes_json),
  createdAt: r.created_at,
});

// 直前の文 (営業先の UPDATE か、同じ更新の 1 つ前の履歴 INSERT) が 1 行変えた時だけ入る。
// batch は 1 接続で順に実行されるトランザクションなので changes() は同じ更新の直前の文を指す。
const INSERT_ACTIVITY_SQL = `INSERT INTO member_sponsor_lead_activity
    (id, org_id, lead_id, source, direction, mail_at, counterpart, matched_by, mailbox, changes_json, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`;

export function createD1SponsorMailRepo(db: DbClient): SponsorMailRepo {
  return {
    async listActivity(orgId, leadId) {
      const rows = await db.all<ActivityDbRow>(
        `SELECT * FROM member_sponsor_lead_activity WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
        orgId,
        leadId,
      );
      return rows.map(toActivityFromDb);
    },
    async applyAutoUpdates(updates) {
      if (updates.length === 0) return [];
      const stmts = updates.flatMap(({ next: l, expectedVersion, activity: a }) => [
        { sql: UPDATE_SQL, binds: [...fieldValues(l), l.version, l.updatedAt, l.archivedAt, l.id, expectedVersion] },
        {
          sql: INSERT_ACTIVITY_SQL,
          binds: [a.id, a.orgId, a.leadId, a.source, a.direction, a.mailAt, a.counterpart, a.matchedBy, a.mailbox, JSON.stringify(a.changes), a.createdAt],
        },
      ]);
      const results = await db.batch(stmts);
      return updates.map((_, i) => (results[i * 2]?.meta.changes ?? 0) > 0);
    },
  };
}
