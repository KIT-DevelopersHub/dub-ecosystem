// 会計のビジネスロジック。HTTP 非依存。入力の検査と正規化は @dub/types accounting が SoT。
import { DubError, errors } from "@dub/errors";
import { accounting, privacyPolicy } from "@dub/types";
import type { IssuerRow, PrivacyPolicyRow } from "./accounting-repo";
import type { ReqCtx } from "./service";
import type { AppDeps } from "./types";

const errVersionConflict = (): DubError =>
  new DubError("ACCOUNTING_VERSION_CONFLICT", "Issuer settings were changed by someone else", { status: 409 });

const errPolicyConflict = (): DubError =>
  new DubError("ACCOUNTING_PRIVACY_POLICY_VERSION_CONFLICT", "The privacy policy was changed by someone else", { status: 409 });

const toPolicy = ({ orgId: _org, ...rest }: PrivacyPolicyRow): accounting.PrivacyPolicy => rest;

const toIssuer = ({ orgId: _org, ...rest }: IssuerRow): accounting.AccountingIssuer => rest;

export class AccountingService {
  constructor(private readonly deps: AppDeps) {}

  async getIssuer(): Promise<accounting.GetIssuerResponse> {
    const row = await this.deps.accountingRepo.getIssuer(this.deps.orgId);
    return { issuer: row ? toIssuer(row) : null };
  }

  async putIssuer(ctx: ReqCtx, body: accounting.PutIssuerRequest): Promise<accounting.PutIssuerResponse> {
    const { accountingRepo, orgId, repo, now } = this.deps;
    const expected = (body as { expectedVersion?: unknown } | null)?.expectedVersion;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
      throw errors.validationFailed([{ field: "expectedVersion", reason: "required" }]);
    }
    const parsed = accounting.parseIssuerInput(body);
    if (!parsed.ok) throw errors.validationFailed(parsed.errors);
    const person = await repo.getPersonByIdentityUserId(orgId, ctx.userId);
    const row: IssuerRow = {
      orgId,
      ...parsed.value,
      version: expected + 1,
      updatedBy: ctx.userId,
      updatedByName: person?.name ?? null,
      updatedAt: now(),
    };
    if (!(await accountingRepo.saveIssuer(row, expected))) throw errVersionConflict();
    return { ...toIssuer(row), warnings: parsed.warnings };
  }

  async getPrivacyPolicy(): Promise<accounting.GetPrivacyPolicyResponse> {
    const { accountingRepo, orgId } = this.deps;
    const [row, history] = await Promise.all([
      accountingRepo.getPrivacyPolicy(orgId),
      accountingRepo.listPrivacyPolicyHistory(orgId, accounting.PRIVACY_POLICY_HISTORY_LIMIT),
    ]);
    return { policy: row ? toPolicy(row) : null, history };
  }

  /** LP Worker 用。本文と更新日時だけ (更新者は公開しない)。 */
  async getPublicPrivacyPolicy(): Promise<accounting.GetPublicPrivacyPolicyResponse> {
    const row = await this.deps.accountingRepo.getPrivacyPolicy(this.deps.orgId);
    return { policy: row ? { body: row.body, updatedAt: row.updatedAt } : null };
  }

  async putPrivacyPolicy(ctx: ReqCtx, body: accounting.PutPrivacyPolicyRequest): Promise<accounting.PutPrivacyPolicyResponse> {
    const { accountingRepo, orgId, repo, now } = this.deps;
    const b = (body ?? {}) as { expectedVersion?: unknown; body?: unknown };
    const expected = b.expectedVersion;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
      throw errors.validationFailed([{ field: "expectedVersion", reason: "required" }]);
    }
    const parsed = privacyPolicy.parsePrivacyPolicyBody(b.body);
    if (!parsed.ok) throw errors.validationFailed([{ field: "body", reason: parsed.reason }]);
    const person = await repo.getPersonByIdentityUserId(orgId, ctx.userId);
    const row: PrivacyPolicyRow = {
      orgId,
      body: parsed.value,
      version: expected + 1,
      updatedBy: ctx.userId,
      updatedByName: person?.name ?? null,
      updatedAt: now(),
    };
    if (!(await accountingRepo.addPrivacyPolicy(row, expected))) throw errPolicyConflict();
    return toPolicy(row);
  }
}
