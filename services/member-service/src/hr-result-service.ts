// 面談結果の登録 (HTTP 非依存)。api-gateway の POST /api/v1/admin/hr/applicants/:id/interview-result が
// claim → (合格のみ: アドレス・アカウント発行 → link) → complete の順に呼ぶ。
//
//  - claim:    応募者ごとに 1 行 (UNIQUE) を作って占有する。完了済みなら proceed=false (何もしない)。
//              占有中の 2 本目は 409。途中で落ちた分は占有が切れるか release で再開できる。
//  - link:     合格。発行したアカウントを結んだ名簿の行を作り (再試行では作り直さない)、応募者を 採用 にする。
//  - complete: 不合格なら 不合格 にする。合否のメールを 1 通送り (冪等キーは結果の id)、完了にする。
import { DubError, errors } from "@dub/errors";
import { hr, hrForm, hrResult } from "@dub/types";
import type { ApplicantRow } from "./hr-repo";
import type { HrService } from "./hr-service";
import type { HrResultRepo, ResultRow } from "./hr-result-repo";
import { INTERVIEW_FORM_KEY } from "./hr-form-service";
import type { MemberService, ReqCtx } from "./service";
import type { AppDeps } from "./types";

/** 発行 (mail-gateway 25 秒 × 数回) が収まる長さ。これより長く止まった分は次の登録で再開できる。 */
const LEASE_MS = 2 * 60_000;

const errNotFound = (id: string): DubError => new DubError("HR_APPLICANT_NOT_FOUND", `Applicant not found: ${id}`, { status: 404 });
const errNotEligible = (stage: string): DubError =>
  new DubError("HR_RESULT_NOT_ELIGIBLE", `Interview result can be registered only for 面談確定/面談済み (now: ${stage})`, { status: 409 });
const errNoEmail = (): DubError => new DubError("HR_RESULT_NO_EMAIL", "応募者のメールアドレスが無いため結果を送れません", { status: 409 });
const errInProgress = (): DubError => new DubError("HR_RESULT_IN_PROGRESS", "この応募者の結果を登録している途中です", { status: 409, retryable: true });
const errNoResult = (): DubError => new DubError("HR_RESULT_NOT_CLAIMED", "Interview result is not being registered", { status: 409 });
const errMailUnavailable = (): DubError => new DubError("HR_RESULT_MAIL_FAILED", "結果のメールを送れませんでした", { status: 502, retryable: true });

export type HrResultDeps = Pick<AppDeps, "orgId" | "now" | "repo" | "hrRepo" | "hrFormRepo" | "newHrId" | "sendHrMail" | "appBaseUrl"> & {
  hrResultRepo: HrResultRepo;
};

function toResult(r: ResultRow): hrResult.InterviewResult {
  const { orgId: _o, leaseUntil: _l, ...wire } = r;
  return wire;
}

function toApplicant(r: ApplicantRow): hr.Applicant {
  const { orgId: _o, archivedAt: _a, ...wire } = r;
  return wire;
}

/** 合格の所属を確かめたもの。teamIds = undefined は「希望チーム」(従来どおり)。 */
interface Placement {
  teamIds: string[] | undefined;
  leaderId: string | null;
}

function reasonOf(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw errors.validationFailed([{ field: "reason", reason: "required" }]);
  if (v.trim().length > hrResult.MAX_REASON_LENGTH) throw errors.validationFailed([{ field: "reason", reason: "too_long" }]);
  return v.trim();
}

export class HrResultService {
  constructor(
    private readonly deps: HrResultDeps,
    private readonly hrSvc: HrService,
    private readonly members: MemberService,
  ) {}

  private async applicant(id: string): Promise<ApplicantRow> {
    const a = await this.deps.hrRepo.getApplicant(id);
    if (!a || a.orgId !== this.deps.orgId || a.archivedAt !== null) throw errNotFound(id);
    return a;
  }

  /**
   * 合格の所属 (チーム・上長) を確かめる。チームは組織に在ること、上長は組織の在籍中 (アーカイブされていない)
   * メンバーであること。違えば 400 (claim はアカウント発行より前なので、何も発行せずに止まる)。
   */
  private async placement(body: hrResult.PassPlacement | null | undefined): Promise<Placement> {
    const rawTeams = body?.teamIds;
    let teamIds: string[] | undefined;
    if (rawTeams !== undefined) {
      if (!Array.isArray(rawTeams) || rawTeams.some((t) => typeof t !== "string" || t.trim() === "")) {
        throw errors.validationFailed([{ field: "teamIds", reason: "invalid" }]);
      }
      teamIds = [...new Set(rawTeams.map((t) => t.trim()))];
      if (teamIds.length > 0) {
        const known = new Set((await this.deps.repo.listTeams(this.deps.orgId)).map((t) => t.id));
        const unknown = teamIds.find((t) => !known.has(t));
        if (unknown !== undefined) throw errors.validationFailed([{ field: "teamIds", reason: "unknown_team", message: unknown }]);
      }
    }
    const rawLeader = body?.leaderId;
    let leaderId: string | null = null;
    if (rawLeader !== undefined && rawLeader !== null) {
      if (typeof rawLeader !== "string") throw errors.validationFailed([{ field: "leaderId", reason: "invalid" }]);
      const id = rawLeader.trim();
      if (id !== "") {
        const leader = await this.deps.repo.getPerson(id);
        if (!leader || leader.orgId !== this.deps.orgId || leader.archivedAt !== null) {
          throw errors.validationFailed([{ field: "leaderId", reason: "unknown_member", message: id }]);
        }
        leaderId = id;
      }
    }
    return { teamIds, leaderId };
  }

  private leaseUntil(): string {
    return new Date(Date.parse(this.deps.now()) + LEASE_MS).toISOString();
  }

  async claim(ctx: ReqCtx, applicantId: string, body: hrResult.ClaimInterviewResultRequest | null): Promise<hrResult.ClaimInterviewResultResponse> {
    const decision = body?.decision;
    if (!hrResult.isInterviewDecision(decision)) throw errors.validationFailed([{ field: "decision", reason: "invalid" }]);
    const reason = reasonOf(body?.reason);
    const includeReasonInMail = body?.includeReasonInMail === true;
    const a = await this.applicant(applicantId);
    const existing = await this.deps.hrResultRepo.get(applicantId);
    if (existing?.status === "done") return { result: toResult(existing), applicant: toApplicant(a), proceed: false };
    if (decision === "pass") await this.placement(body);
    if (existing) {
      const patch = { decision, reason, includeReasonInMail, createdBy: ctx.userId };
      if (!(await this.deps.hrResultRepo.reclaim(applicantId, patch, this.deps.now(), this.leaseUntil()))) throw errInProgress();
    } else {
      if (!hrResult.RESULT_STAGES.includes(a.stage)) throw errNotEligible(a.stage);
      if (!a.email) throw errNoEmail();
      const inserted = await this.deps.hrResultRepo.insert({
        id: this.deps.newHrId("hir"),
        orgId: this.deps.orgId,
        applicantId,
        decision,
        reason,
        includeReasonInMail,
        status: "processing",
        issuedAddress: null,
        issuedIdentityUserId: null,
        issuedMemberId: null,
        mailSentAt: null,
        leaseUntil: this.leaseUntil(),
        createdBy: ctx.userId,
        createdAt: this.deps.now(),
        completedAt: null,
      });
      if (!inserted) {
        // 同時の 2 本目。先の 1 本が完了していればその結果を返す。
        const other = await this.deps.hrResultRepo.get(applicantId);
        if (other?.status === "done") return { result: toResult(other), applicant: toApplicant(a), proceed: false };
        throw errInProgress();
      }
    }
    const row = (await this.deps.hrResultRepo.get(applicantId)) as ResultRow;
    return { result: toResult(row), applicant: toApplicant(a), proceed: true };
  }

  private async processing(applicantId: string): Promise<ResultRow> {
    const r = await this.deps.hrResultRepo.get(applicantId);
    if (!r || r.status !== "processing") throw errNoResult();
    return r;
  }

  /** 合格: 発行したアカウントを結んだ名簿の行を作り、応募者を 採用 にする。同じアカウントでの再試行は冪等。 */
  async link(ctx: ReqCtx, applicantId: string, body: hrResult.LinkInterviewResultRequest | null): Promise<hr.Applicant> {
    const identityUserId = typeof body?.identityUserId === "string" ? body.identityUserId.trim() : "";
    const address = typeof body?.address === "string" ? body.address.trim().toLowerCase() : "";
    if (!identityUserId) throw errors.validationFailed([{ field: "identityUserId", reason: "required" }]);
    if (!address) throw errors.validationFailed([{ field: "address", reason: "required" }]);
    const r = await this.processing(applicantId);
    if (r.decision !== "pass") throw errNoResult();
    const a = await this.applicant(applicantId);
    // 名簿の行を作るのは 1 回だけなので、所属もその時の 1 回だけ書く (再試行でチームの結び付きを重ねない)。
    const place = (r.issuedMemberId ?? a.memberId) ? null : await this.placement(body);
    await this.deps.hrResultRepo.recordIssued(applicantId, { issuedAddress: address, issuedIdentityUserId: identityUserId });

    let memberId = r.issuedMemberId ?? a.memberId;
    if (!memberId) {
      const prefill = hrForm.participationPrefill(a, await this.latestResponse(applicantId));
      const created = await this.members.createMember(ctx, {
        ...prefill,
        name: a.name,
        status: "added",
        teamIds: place?.teamIds ?? (a.desiredTeamId ? [a.desiredTeamId] : []),
        leaderId: place?.leaderId ?? null,
        contact: a.email,
      });
      memberId = created.id;
      // 名簿の行を先に記録する: 結ぶ前に落ちても、再試行で行を作り直さない。
      await this.deps.hrResultRepo.recordIssued(applicantId, { issuedMemberId: memberId });
    }
    const person = await this.deps.repo.getPerson(memberId);
    if (!person || person.orgId !== this.deps.orgId) throw errNotFound(memberId);
    if (person.identityUserId !== identityUserId) {
      await this.members.linkIdentity(ctx, memberId, { identityUserId, version: person.version });
    }
    return this.hrSvc.applyResult(ctx, applicantId, "hired", `面談結果: 合格（${address} を発行）`, memberId);
  }

  private async latestResponse(applicantId: string): Promise<hrForm.InterviewFormResponse | null> {
    const list = await this.deps.hrFormRepo.listResponses(this.deps.orgId, INTERVIEW_FORM_KEY, applicantId);
    return list[0] ?? null;
  }

  /** 合格で作った名簿の行の所属チーム名 (メールに載せる)。 */
  private async teamNamesOf(memberId: string | null): Promise<string[]> {
    if (!memberId) return [];
    const [links, teams] = await Promise.all([this.deps.repo.teamLinksForOrg(this.deps.orgId), this.deps.repo.listTeams(this.deps.orgId)]);
    const ids = new Set(links.filter((l) => l.personId === memberId).map((l) => l.teamId));
    return teams.filter((t) => ids.has(t.id)).map((t) => t.name);
  }

  /** 合否のメールを組み立てる (宛先・件名・本文)。プレビューと同じ hrResult.renderResultMail。 */
  async buildMail(applicantId: string, r: ResultRow, a: ApplicantRow): Promise<{ to: string; subject: string; textBody: string }> {
    const base = this.deps.appBaseUrl ?? "";
    const prefill = hrForm.participationPrefill(a, await this.latestResponse(applicantId));
    const mail = hrResult.renderResultMail({
      decision: r.decision,
      name: a.name,
      reason: r.includeReasonInMail ? r.reason : null,
      address: r.issuedAddress,
      teamNames: r.decision === "pass" ? await this.teamNamesOf(r.issuedMemberId) : null,
      appUrl: base ? hrResult.absoluteUrl(base, "/") : null,
      participationUrl: base ? hrResult.absoluteUrl(base, hrForm.participationPrefillPath(prefill)) : null,
      onboardingUrl: base ? hrResult.absoluteUrl(base, hrResult.PUBLIC_ONBOARDING_PATH) : null,
    });
    return { to: a.email ?? "", ...mail };
  }

  async complete(ctx: ReqCtx, applicantId: string): Promise<hrResult.CompleteInterviewResultResponse> {
    const existing = await this.deps.hrResultRepo.get(applicantId);
    if (existing?.status === "done") {
      return { result: toResult(existing), applicant: toApplicant(await this.applicant(applicantId)) };
    }
    const r = await this.processing(applicantId);
    if (r.decision === "pass" && !r.issuedMemberId && !r.issuedIdentityUserId) throw errNoResult(); // 発行前に完了させない
    if (r.decision === "fail") {
      await this.hrSvc.applyResult(ctx, applicantId, "rejected", `面談結果: 不合格（${r.reason}）`);
    }
    const a = await this.applicant(applicantId);
    let mailSentAt = r.mailSentAt;
    if (mailSentAt === null) {
      if (!this.deps.sendHrMail || !a.email) {
        await this.deps.hrResultRepo.releaseLease(applicantId);
        throw errMailUnavailable();
      }
      const m = await this.buildMail(applicantId, r, a);
      try {
        // 冪等キーは結果ごとに 1 つ: 応答が失われた再試行でも mail-gateway が 1 通に畳む。
        await this.deps.sendHrMail(ctx.requestId, m, `hr-interview-result:${r.id}`);
      } catch {
        await this.deps.hrResultRepo.releaseLease(applicantId);
        throw errMailUnavailable();
      }
      mailSentAt = this.deps.now();
    }
    await this.deps.hrResultRepo.complete(applicantId, mailSentAt, this.deps.now());
    const done = (await this.deps.hrResultRepo.get(applicantId)) as ResultRow;
    return { result: toResult(done), applicant: toApplicant(a) };
  }

  /** gateway の途中失敗: 占有を手放す (発行済みの記録は残すので、再試行は続きから)。 */
  async release(applicantId: string): Promise<{ ok: true }> {
    await this.deps.hrResultRepo.releaseLease(applicantId);
    return { ok: true };
  }
}
