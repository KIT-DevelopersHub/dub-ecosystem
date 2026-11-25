// 面談申し込みフォームのビジネスロジック (HTTP 非依存)。定義・回答の検証は @dub/types hrForm が SoT。
//
// 既存の人事フローとの関係:
//  - 回答 = 応募者の登録。HrService.create をそのまま通すので、応募者は 面談日程調整中 で入り、
//    履歴 (created)・一覧・ステータス変更・採用 (名簿へ) は手で登録した人と全く同じに動く。
//  - binding のある質問は応募者の列 (氏名・メール・学科…) に入り、残りは回答 (JSON) として応募者に結ぶ。
//  - 同じメールの応募者がまだ選考前 (面談日程調整中 / 面談確定 / 面談済み) なら新しく作らず、その人に
//    回答を足して履歴に残す (二重登録・連打の防止)。
import { DubError, errors } from "@dub/errors";
import { hr, hrForm } from "@dub/types";
import type { HrFormRepo, HrFormRow } from "./hr-form-repo";
import type { HrService } from "./hr-service";
import type { ReqCtx } from "./service";
import type { AppDeps } from "./types";

export const INTERVIEW_FORM_KEY = "interview";

/** 公開ページ経由の回答に付ける system principal (gateway も同じ値で転送する)。 */
export const PUBLIC_INTERVIEW_FORM_ACTOR = "system:public-hr-interview-form";

/** 同じメールなら新規登録せず結ぶステータス (まだ選考の結果が出ていない人)。 */
const DEDUPE_STAGES: readonly hr.ApplicantStage[] = ["scheduling", "interview_set", "interviewed"];

const errVersionConflict = (): DubError =>
  new DubError("HR_FORM_VERSION_CONFLICT", "The form was changed by someone else; reload and try again", { status: 409 });
const errClosed = (): DubError => new DubError("HR_FORM_CLOSED", "This form is not accepting responses", { status: 409 });

export interface HrFormDeps extends Pick<AppDeps, "orgId" | "now" | "hrRepo" | "newHrId"> {
  hrFormRepo: HrFormRepo;
}

function toForm(row: HrFormRow | null): hrForm.InterviewForm {
  if (!row) return { ...hrForm.defaultInterviewForm(), version: 0, updatedBy: null, updatedAt: null };
  return {
    title: row.title,
    description: row.description,
    questions: hrForm.upgradeQuestions(row.questions),
    accepting: row.accepting,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export class HrFormService {
  constructor(
    private readonly deps: HrFormDeps,
    private readonly hrSvc: HrService,
    /** 回答が応募者に結ばれたあと (面談の案内メール)。失敗しても回答は受け付ける。 */
    private readonly onApplied: (ctx: ReqCtx, applicantId: string) => Promise<void> = async () => {},
  ) {}

  async getForm(): Promise<hrForm.InterviewForm> {
    return toForm(await this.deps.hrFormRepo.getForm(this.deps.orgId, INTERVIEW_FORM_KEY));
  }

  async getPublicForm(): Promise<hrForm.PublicInterviewForm> {
    const f = await this.getForm();
    return { title: f.title, description: f.description, questions: f.questions, accepting: f.accepting };
  }

  async saveForm(ctx: ReqCtx, body: hrForm.SaveInterviewFormRequest): Promise<hrForm.InterviewForm> {
    const b = (body ?? {}) as Partial<hrForm.SaveInterviewFormRequest>;
    if (typeof b.expectedVersion !== "number" || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 0) {
      throw errors.validationFailed([{ field: "expectedVersion", reason: "required" }]);
    }
    if (typeof b.accepting !== "boolean") throw errors.validationFailed([{ field: "accepting", reason: "required" }]);
    // 旧形式を開いたままのタブからの保存も通す。
    const questions = Array.isArray(b.questions) ? hrForm.upgradeQuestions(b.questions) : b.questions;
    const bad = hrForm.validateFormDefinition({ title: b.title, description: b.description, questions });
    if (bad.length > 0) throw errors.validationFailed(bad);
    const normalized = hrForm.normalizeFormDefinition({ ...b, questions } as hrForm.SaveInterviewFormRequest);
    const now = this.deps.now();
    const cur = await this.deps.hrFormRepo.getForm(this.deps.orgId, INTERVIEW_FORM_KEY);
    const expected = b.expectedVersion;
    const row: HrFormRow = {
      orgId: this.deps.orgId,
      formKey: INTERVIEW_FORM_KEY,
      ...normalized,
      version: expected + 1,
      updatedBy: ctx.userId,
      createdAt: cur?.createdAt ?? now,
      updatedAt: now,
    };
    const ok = expected === 0 && !cur
      ? await this.deps.hrFormRepo.insertForm(row)
      : await this.deps.hrFormRepo.updateForm(row, expected);
    if (!ok) throw errVersionConflict();
    return toForm(row);
  }

  /** 回答を受け付けて応募者に結ぶ。public は受付終了なら 409、staff (代理入力) は受付終了でも入れられる。 */
  async submit(
    ctx: ReqCtx,
    body: hrForm.SubmitInterviewFormRequest,
    via: hrForm.InterviewFormResponseVia,
  ): Promise<hrForm.StaffSubmitInterviewFormResponse> {
    const form = await this.getForm();
    if (via === "public" && !form.accepting) throw errClosed();
    const { value: answers, errors: bad } = hrForm.validateAnswers(form.questions, (body ?? {}).answers);
    if (bad.length > 0) throw errors.validationFailed(bad);
    const fields = hrForm.applicantFieldsFromAnswers(form.questions, answers);
    if (!fields.name) throw errors.validationFailed([{ field: "answers.name", reason: "required" }]);

    const existing = fields.email
      ? (await this.deps.hrRepo.listApplicants(this.deps.orgId)).find(
          (a) => a.email?.toLowerCase() === fields.email && DEDUPE_STAGES.includes(a.stage),
        ) ?? null
      : null;

    let applicantId: string;
    if (existing) {
      applicantId = existing.id;
      await this.deps.hrRepo.addEvent({
        id: this.deps.newHrId("hre"),
        applicantId,
        kind: "note",
        fromStage: null,
        toStage: null,
        body: via === "public" ? "面談申し込みフォームに再度回答がありました" : "面談申し込みフォームの回答を代理入力しました",
        actorId: ctx.userId,
        createdAt: this.deps.now(),
      });
    } else {
      const created = await this.hrSvc.create(ctx, {
        ...fields,
        source: via === "public" ? hrForm.SOURCE_PUBLIC : hrForm.SOURCE_STAFF,
      });
      applicantId = created.applicant.id;
    }

    const response: hrForm.InterviewFormResponse = {
      id: this.deps.newHrId("hfr"),
      applicantId,
      answers,
      questions: form.questions,
      via,
      submittedBy: ctx.userId,
      createdAt: this.deps.now(),
    };
    await this.deps.hrFormRepo.addResponse({ ...response, orgId: this.deps.orgId, formKey: INTERVIEW_FORM_KEY });
    await this.onApplied(ctx, applicantId);
    return { response, applicantId, deduped: existing !== null };
  }

  async listResponses(applicantId?: string): Promise<hrForm.ListInterviewFormResponsesResponse> {
    const rows = await this.deps.hrFormRepo.listResponses(this.deps.orgId, INTERVIEW_FORM_KEY, applicantId);
    const names = new Map<string, string | null>();
    for (const r of rows) {
      if (names.has(r.applicantId)) continue;
      const a = await this.deps.hrRepo.getApplicant(r.applicantId);
      names.set(r.applicantId, a && a.orgId === this.deps.orgId && a.archivedAt === null ? a.name : null);
    }
    return {
      responses: rows.map(({ orgId: _o, formKey: _k, ...r }) => ({ ...r, applicantName: names.get(r.applicantId) ?? null })),
    };
  }
}
