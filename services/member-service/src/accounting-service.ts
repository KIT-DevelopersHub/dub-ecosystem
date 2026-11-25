// 会計のビジネスロジック。HTTP 非依存。入力の検査と正規化は @dub/types accounting が SoT。
import { DubError, errors } from "@dub/errors";
import { accounting } from "@dub/types";
import type { IssuerRow } from "./accounting-repo";
import type { ReqCtx } from "./service";
import type { AppDeps } from "./types";

const errVersionConflict = (): DubError =>
  new DubError("ACCOUNTING_VERSION_CONFLICT", "Issuer settings were changed by someone else", { status: 409 });

const toIssuer = ({ orgId: _org, ...rest }: IssuerRow): accounting.AccountingIssuer => rest;

export class AccountingService {
  constructor(private readonly deps: AppDeps) {}

  async getIssuer(): Promise<accounting.GetIssuerResponse> {
    const row = await this.deps.accountingRepo.getIssuer(this.deps.orgId);
    return { issuer: row ? toIssuer(row) : null };
  }

  async putIssuer(ctx: ReqCtx, body: accounting.PutIssuerRequest): Promise<accounting.AccountingIssuer> {
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
    return toIssuer(row);
  }
}
