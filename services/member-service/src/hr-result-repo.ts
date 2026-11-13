// 面談結果 (member_hr_interview_results) の永続化。応募者ごとに 1 行 (applicant_id UNIQUE)。
// lease_until は処理中の占有: 二度押し・同時の登録は 1 つだけが進み、途中で落ちた分は期限が切れたら再開できる。
import type { DbClient } from "@dub/db";
import type { common, hrResult } from "@dub/types";

export interface ResultRow {
  id: string;
  orgId: common.OrgId;
  applicantId: string;
  decision: hrResult.InterviewDecision;
  reason: string;
  includeReasonInMail: boolean;
  status: hrResult.InterviewResultStatus;
  issuedAddress: string | null;
  issuedIdentityUserId: string | null;
  issuedMemberId: string | null;
  mailSentAt: common.ISODateTime | null;
  leaseUntil: common.ISODateTime | null;
  createdBy: common.UserId;
  createdAt: common.ISODateTime;
  completedAt: common.ISODateTime | null;
}

export interface HrResultRepo {
  get(applicantId: string): Promise<ResultRow | null>;
  /** 行が無ければ作って true。既にあれば何もせず false。 */
  insert(row: ResultRow): Promise<boolean>;
  /**
   * 処理中で占有の切れた行を取り直す (合否・理由は差し替え。発行済みの項目は残す)。取れたら true。
   * 完了した行・占有中の行は取れない。
   */
  reclaim(applicantId: string, patch: Pick<ResultRow, "decision" | "reason" | "includeReasonInMail" | "createdBy">, now: string, leaseUntil: string): Promise<boolean>;
  /** 発行した分を記録する (null の項目は上書きしない)。 */
  recordIssued(applicantId: string, patch: Partial<Pick<ResultRow, "issuedAddress" | "issuedIdentityUserId" | "issuedMemberId">>): Promise<void>;
  /** 占有を手放す (失敗時。すぐ再試行できる)。 */
  releaseLease(applicantId: string): Promise<void>;
  /** メール送信の記録と完了。 */
  complete(applicantId: string, mailSentAt: string | null, completedAt: string): Promise<void>;
}

export class InMemoryHrResultRepo implements HrResultRepo {
  private rows = new Map<string, ResultRow>();
  async get(applicantId: string): Promise<ResultRow | null> {
    const r = this.rows.get(applicantId);
    return r ? { ...r } : null;
  }
  async insert(row: ResultRow): Promise<boolean> {
    if (this.rows.has(row.applicantId)) return false;
    this.rows.set(row.applicantId, { ...row });
    return true;
  }
  async reclaim(applicantId: string, patch: Pick<ResultRow, "decision" | "reason" | "includeReasonInMail" | "createdBy">, now: string, leaseUntil: string): Promise<boolean> {
    const r = this.rows.get(applicantId);
    if (!r || r.status !== "processing" || (r.leaseUntil !== null && r.leaseUntil > now)) return false;
    const keepDecision = r.issuedIdentityUserId !== null; // 発行済みなら合格のまま
    this.rows.set(applicantId, { ...r, ...patch, decision: keepDecision ? r.decision : patch.decision, leaseUntil });
    return true;
  }
  async recordIssued(applicantId: string, patch: Partial<Pick<ResultRow, "issuedAddress" | "issuedIdentityUserId" | "issuedMemberId">>): Promise<void> {
    const r = this.rows.get(applicantId);
    if (!r) return;
    this.rows.set(applicantId, {
      ...r,
      issuedAddress: patch.issuedAddress ?? r.issuedAddress,
      issuedIdentityUserId: patch.issuedIdentityUserId ?? r.issuedIdentityUserId,
      issuedMemberId: patch.issuedMemberId ?? r.issuedMemberId,
    });
  }
  async releaseLease(applicantId: string): Promise<void> {
    const r = this.rows.get(applicantId);
    if (r && r.status === "processing") this.rows.set(applicantId, { ...r, leaseUntil: null });
  }
  async complete(applicantId: string, mailSentAt: string | null, completedAt: string): Promise<void> {
    const r = this.rows.get(applicantId);
    if (r) this.rows.set(applicantId, { ...r, status: "done", mailSentAt: mailSentAt ?? r.mailSentAt, completedAt, leaseUntil: null });
  }
}

interface ResultDbRow {
  id: string;
  org_id: string;
  applicant_id: string;
  decision: string;
  reason: string;
  include_reason: number;
  status: string;
  issued_address: string | null;
  issued_identity_user_id: string | null;
  issued_member_id: string | null;
  mail_sent_at: string | null;
  lease_until: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

const toRow = (r: ResultDbRow): ResultRow => ({
  id: r.id,
  orgId: r.org_id,
  applicantId: r.applicant_id,
  decision: r.decision as hrResult.InterviewDecision,
  reason: r.reason,
  includeReasonInMail: r.include_reason === 1,
  status: r.status as hrResult.InterviewResultStatus,
  issuedAddress: r.issued_address,
  issuedIdentityUserId: r.issued_identity_user_id,
  issuedMemberId: r.issued_member_id,
  mailSentAt: r.mail_sent_at,
  leaseUntil: r.lease_until,
  createdBy: r.created_by,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

export function createD1HrResultRepo(db: DbClient): HrResultRepo {
  return {
    async get(applicantId) {
      const r = await db.first<ResultDbRow>(`SELECT * FROM member_hr_interview_results WHERE applicant_id = ?`, applicantId);
      return r ? toRow(r) : null;
    },
    async insert(row) {
      const res = await db.run(
        `INSERT OR IGNORE INTO member_hr_interview_results
           (id, org_id, applicant_id, decision, reason, include_reason, status, lease_until, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.orgId, row.applicantId, row.decision, row.reason, row.includeReasonInMail ? 1 : 0, row.status,
        row.leaseUntil, row.createdBy, row.createdAt,
      );
      return res.meta.changes > 0;
    },
    async reclaim(applicantId, patch, now, leaseUntil) {
      // 1 文で判定して原子的にする (同時の再試行は 1 つだけが取れる)。発行済みなら合否は変えない。
      const res = await db.run(
        `UPDATE member_hr_interview_results
         SET decision = CASE WHEN issued_identity_user_id IS NULL THEN ? ELSE decision END,
             reason = ?, include_reason = ?, created_by = ?, lease_until = ?
         WHERE applicant_id = ? AND status = 'processing' AND (lease_until IS NULL OR lease_until <= ?)`,
        patch.decision, patch.reason, patch.includeReasonInMail ? 1 : 0, patch.createdBy, leaseUntil, applicantId, now,
      );
      return res.meta.changes > 0;
    },
    async recordIssued(applicantId, patch) {
      await db.run(
        `UPDATE member_hr_interview_results
         SET issued_address = COALESCE(?, issued_address),
             issued_identity_user_id = COALESCE(?, issued_identity_user_id),
             issued_member_id = COALESCE(?, issued_member_id)
         WHERE applicant_id = ?`,
        patch.issuedAddress ?? null, patch.issuedIdentityUserId ?? null, patch.issuedMemberId ?? null, applicantId,
      );
    },
    async releaseLease(applicantId) {
      await db.run(`UPDATE member_hr_interview_results SET lease_until = NULL WHERE applicant_id = ? AND status = 'processing'`, applicantId);
    },
    async complete(applicantId, mailSentAt, completedAt) {
      await db.run(
        `UPDATE member_hr_interview_results
         SET status = 'done', mail_sent_at = COALESCE(?, mail_sent_at), completed_at = ?, lease_until = NULL
         WHERE applicant_id = ?`,
        mailSentAt, completedAt, applicantId,
      );
    },
  };
}
