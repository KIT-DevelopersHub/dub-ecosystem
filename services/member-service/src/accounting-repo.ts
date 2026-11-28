// 会計: 団体の発行者情報 (member_accounting_issuer, 1 団体 1 行) と
// 公式サイトのプライバシーポリシー (member_accounting_privacy_policy, 1 保存 1 行 = 版ごとに残す) の永続化。
import type { DbClient } from "@dub/db";
import type { accounting, common } from "@dub/types";

export interface IssuerRow extends accounting.AccountingIssuer {
  orgId: common.OrgId;
}

export interface PrivacyPolicyRow extends accounting.PrivacyPolicy {
  orgId: common.OrgId;
}

export interface AccountingRepo {
  getIssuer(orgId: common.OrgId): Promise<IssuerRow | null>;
  /** 新規 = expectedVersion 0。楽観ロックに負けたら false。 */
  saveIssuer(row: IssuerRow, expectedVersion: number): Promise<boolean>;
  /** 最新の版。 */
  getPrivacyPolicy(orgId: common.OrgId): Promise<PrivacyPolicyRow | null>;
  /** 版の一覧 (本文なし・新しい順)。 */
  listPrivacyPolicyHistory(orgId: common.OrgId, limit: number): Promise<accounting.PrivacyPolicyRevision[]>;
  /** row.version = expectedVersion + 1 の版を足す。最新の版が expectedVersion でなければ false (楽観ロック)。 */
  addPrivacyPolicy(row: PrivacyPolicyRow, expectedVersion: number): Promise<boolean>;
}

interface PolicyDbRow {
  org_id: string;
  version: number;
  body: string;
  updated_by: string;
  updated_by_name: string | null;
  updated_at: string;
}

const toPolicyRow = (r: PolicyDbRow): PrivacyPolicyRow => ({
  orgId: r.org_id,
  body: r.body,
  version: r.version,
  updatedBy: r.updated_by as PrivacyPolicyRow["updatedBy"],
  updatedByName: r.updated_by_name,
  updatedAt: r.updated_at,
});

interface DbRow {
  org_id: string;
  name: string;
  office_name: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  url: string | null;
  invoice_registration_no: string | null;
  tax_rate_percent: number;
  version: number;
  updated_by: string;
  updated_by_name: string | null;
  updated_at: string;
}

const toRow = (r: DbRow): IssuerRow => ({
  orgId: r.org_id,
  name: r.name,
  officeName: r.office_name,
  postalCode: r.postal_code,
  address: r.address,
  phone: r.phone,
  email: r.email,
  url: r.url,
  invoiceRegistrationNo: r.invoice_registration_no,
  taxRatePercent: r.tax_rate_percent as accounting.TaxRatePercent,
  version: r.version,
  updatedBy: r.updated_by as IssuerRow["updatedBy"],
  updatedByName: r.updated_by_name,
  updatedAt: r.updated_at,
});

export function createD1AccountingRepo(db: DbClient): AccountingRepo {
  return {
    async getIssuer(orgId) {
      const r = await db.first<DbRow>(`SELECT * FROM member_accounting_issuer WHERE org_id = ?`, orgId);
      return r ? toRow(r) : null;
    },
    async saveIssuer(row, expectedVersion) {
      const fields = [
        row.name, row.officeName, row.postalCode, row.address, row.phone, row.email, row.url,
        row.invoiceRegistrationNo, row.taxRatePercent, row.version, row.updatedBy, row.updatedByName, row.updatedAt,
      ] as const;
      if (expectedVersion === 0) {
        const res = await db.run(
          `INSERT OR IGNORE INTO member_accounting_issuer
             (name, office_name, postal_code, address, phone, email, url, invoice_registration_no, tax_rate_percent,
              version, updated_by, updated_by_name, updated_at, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ...fields, row.orgId,
        );
        return res.meta.changes > 0;
      }
      const res = await db.run(
        `UPDATE member_accounting_issuer SET
           name = ?, office_name = ?, postal_code = ?, address = ?, phone = ?, email = ?, url = ?,
           invoice_registration_no = ?, tax_rate_percent = ?, version = ?, updated_by = ?, updated_by_name = ?, updated_at = ?
         WHERE org_id = ? AND version = ?`,
        ...fields, row.orgId, expectedVersion,
      );
      return res.meta.changes > 0;
    },
    async getPrivacyPolicy(orgId) {
      const r = await db.first<PolicyDbRow>(
        `SELECT * FROM member_accounting_privacy_policy WHERE org_id = ? ORDER BY version DESC LIMIT 1`,
        orgId,
      );
      return r ? toPolicyRow(r) : null;
    },
    async listPrivacyPolicyHistory(orgId, limit) {
      const rows = await db.all<Pick<PolicyDbRow, "version" | "updated_by_name" | "updated_at">>(
        `SELECT version, updated_by_name, updated_at FROM member_accounting_privacy_policy
         WHERE org_id = ? ORDER BY version DESC LIMIT ?`,
        orgId, limit,
      );
      return rows.map((r) => ({ version: r.version, updatedByName: r.updated_by_name, updatedAt: r.updated_at }));
    },
    async addPrivacyPolicy(row, expectedVersion) {
      // 1 文で「最新が expectedVersion の時だけ足す」。同時保存は PK (org_id, version) の衝突でも負ける。
      const res = await db.run(
        `INSERT OR IGNORE INTO member_accounting_privacy_policy
           (org_id, version, body, updated_by, updated_by_name, updated_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE COALESCE((SELECT MAX(version) FROM member_accounting_privacy_policy WHERE org_id = ?), 0) = ?`,
        row.orgId, row.version, row.body, row.updatedBy, row.updatedByName, row.updatedAt, row.orgId, expectedVersion,
      );
      return res.meta.changes > 0;
    },
  };
}

/** テスト用。 */
export class InMemoryAccountingRepo implements AccountingRepo {
  private readonly rows = new Map<string, IssuerRow>();
  async getIssuer(orgId: common.OrgId): Promise<IssuerRow | null> {
    const r = this.rows.get(orgId);
    return r ? { ...r } : null;
  }
  async saveIssuer(row: IssuerRow, expectedVersion: number): Promise<boolean> {
    if ((this.rows.get(row.orgId)?.version ?? 0) !== expectedVersion) return false;
    this.rows.set(row.orgId, { ...row });
    return true;
  }
  private readonly policies = new Map<string, PrivacyPolicyRow[]>();
  async getPrivacyPolicy(orgId: common.OrgId): Promise<PrivacyPolicyRow | null> {
    const list = this.policies.get(orgId) ?? [];
    const last = list[list.length - 1];
    return last ? { ...last } : null;
  }
  async listPrivacyPolicyHistory(orgId: common.OrgId, limit: number): Promise<accounting.PrivacyPolicyRevision[]> {
    return (this.policies.get(orgId) ?? [])
      .slice()
      .reverse()
      .slice(0, limit)
      .map((r) => ({ version: r.version, updatedByName: r.updatedByName, updatedAt: r.updatedAt }));
  }
  async addPrivacyPolicy(row: PrivacyPolicyRow, expectedVersion: number): Promise<boolean> {
    const list = this.policies.get(row.orgId) ?? [];
    if ((list[list.length - 1]?.version ?? 0) !== expectedVersion) return false;
    this.policies.set(row.orgId, [...list, { ...row }]);
    return true;
  }
}
