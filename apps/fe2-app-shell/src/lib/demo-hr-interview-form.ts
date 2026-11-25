// demo transport: 人事の「面談申し込みフォーム」(member-service /members/hr/interview-form* と
// gateway /public/hr-interview-form の demo)。定義・回答の検証は本番と同じ @dub/types hrForm を使う。
// 回答は既存の人事 demo (POST /api/v1/members/hr/applicants) を通して応募者を作るので、応募者タブの
// 表・ステータス変更・採用までそのまま続けて試せる。seed: 既定フォーム + 本人回答 1 件 + 代理入力 1 件。
import { hrForm, type hr } from "@dub/types";

type CreateApplicant = (body: hr.CreateApplicantRequest) => Promise<hr.ApplicantDetail>;
type ListApplicants = () => Promise<hr.ListApplicantsResponse>;
type AddNote = (id: string, body: string) => Promise<void>;

const ME = "usr_demo";
const PUBLIC_ACTOR = "system:public-hr-interview-form";
const DEDUPE: readonly hr.ApplicantStage[] = ["scheduling", "interview_set", "interviewed"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function problem(code: string, status: number, details?: unknown): Response {
  return json({ error: { code, message: code, retryable: false, ...(details ? { details } : {}) } }, status);
}

const FORM_STORAGE_KEY = "dub-demo:hr-interview-form";

function loadForm(): hrForm.InterviewForm | null {
  try {
    const raw = globalThis.localStorage?.getItem(FORM_STORAGE_KEY);
    if (!raw) return null;
    const f = JSON.parse(raw) as hrForm.InterviewForm;
    return hrForm.validateFormDefinition(f).length === 0 ? f : null;
  } catch {
    return null;
  }
}

function saveForm(f: hrForm.InterviewForm): void {
  try {
    globalThis.localStorage?.setItem(FORM_STORAGE_KEY, JSON.stringify(f));
  } catch {
    // storage blocked: the edit still applies to this tab
  }
}

export function createHrInterviewFormDemoStore(deps: { createApplicant: CreateApplicant; listApplicants: ListApplicants; addNote: AddNote }) {
  // 定義だけは localStorage に残す: 編集してから「ページを開く」(別タブ = 別の demo 状態) でも公開ページに反映される。
  let form: hrForm.InterviewForm = loadForm() ?? { ...hrForm.defaultInterviewForm(), version: 1, updatedBy: ME, updatedAt: new Date().toISOString() };
  const responses: hrForm.InterviewFormResponse[] = [];
  const names = new Map<string, string>();
  let seq = 0;
  let seeding: Promise<void> | null = null;

  async function submit(answersRaw: unknown, via: hrForm.InterviewFormResponseVia, actor: string): Promise<Response> {
    if (via === "public" && !form.accepting) return problem("HR_FORM_CLOSED", 409);
    const { value: answers, errors } = hrForm.validateAnswers(form.questions, answersRaw);
    if (errors.length > 0) return problem("VALIDATION_FAILED", 400, errors);
    const fields = hrForm.applicantFieldsFromAnswers(form.questions, answers);
    const existing = fields.email
      ? (await deps.listApplicants()).applicants.find((a) => a.email?.toLowerCase() === fields.email && DEDUPE.includes(a.stage))
      : undefined;
    let applicantId: string;
    if (existing) {
      applicantId = existing.id;
      await deps.addNote(applicantId, via === "public" ? "面談申し込みフォームに再度回答がありました" : "面談申し込みフォームの回答を代理入力しました");
    } else {
      const created = await deps.createApplicant({ ...fields, source: via === "public" ? hrForm.SOURCE_PUBLIC : hrForm.SOURCE_STAFF });
      applicantId = created.applicant.id;
      names.set(applicantId, created.applicant.name);
    }
    const response: hrForm.InterviewFormResponse = {
      id: `hfr_demo_${++seq}`,
      applicantId,
      answers,
      questions: form.questions,
      via,
      submittedBy: actor,
      createdAt: new Date().toISOString(),
    };
    responses.unshift(response);
    return json({ response, applicantId, deduped: existing !== undefined }, 201);
  }

  function ensureSeeded(): Promise<void> {
    seeding ??= (async () => {
      await submit(
        {
          last_name: "森", first_name: "結菜", last_name_kana: "もり", first_name_kana: "ゆいな", email: "yuina@example.com", department: "情報工学科", grade: "1年",
          interests: ["イベント運営", "広報"], motivation: "先輩に誘われて興味を持ちました。イベントの裏側を見てみたいです。",
          preferred_date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
        },
        "public",
        PUBLIC_ACTOR,
      );
      await submit(
        { last_name: "林", first_name: "大翔", email: "hiroto@example.com", department: "機械工学科", grade: "2年", interests: ["開発"], motivation: "説明会で話を聞いて応募（電話で聞き取り）" },
        "staff",
        ME,
      );
    })();
    return seeding;
  }

  async function handle(method: string, pathname: string, body: any): Promise<Response | null> {
    const isHr = pathname.startsWith("/api/v1/members/hr/");
    const isPublic = pathname === "/api/v1/public/hr-interview-form";
    if (!isHr && !isPublic) return null;
    await ensureSeeded();
    if (isPublic) {
      if (method === "GET") return json({ title: form.title, description: form.description, questions: form.questions, accepting: form.accepting });
      if (method === "POST") {
        if (typeof body?.website === "string" && body.website.trim() !== "") return json({ accepted: true });
        const res = await submit(body?.answers, "public", PUBLIC_ACTOR);
        return res.ok ? json({ accepted: true }) : res;
      }
      return null;
    }
    if (pathname === "/api/v1/members/hr/interview-form") {
      if (method === "GET") return json(form);
      if (method === "PUT") {
        if (body?.expectedVersion !== form.version) return problem("HR_FORM_VERSION_CONFLICT", 409);
        const errors = hrForm.validateFormDefinition(body ?? {});
        if (errors.length > 0 || typeof body?.accepting !== "boolean") return problem("VALIDATION_FAILED", 400, errors);
        form = { ...hrForm.normalizeFormDefinition(body), version: form.version + 1, updatedBy: ME, updatedAt: new Date().toISOString() };
        saveForm(form);
        return json(form);
      }
      return null;
    }
    if (pathname === "/api/v1/members/hr/interview-form/responses") {
      if (method === "GET") {
        const applicantId = typeof body?.__applicantId === "string" ? body.__applicantId : null;
        const alive = new Map((await deps.listApplicants()).applicants.map((a) => [a.id, a.name]));
        return json({
          responses: responses
            .filter((r) => applicantId === null || r.applicantId === applicantId)
            .map((r) => ({ ...r, applicantName: alive.get(r.applicantId) ?? null })),
        });
      }
      if (method === "POST") return submit(body?.answers, "staff", ME);
    }
    return null;
  }

  return {
    /** url の ?applicantId= を受け取るため URL も渡す。 */
    handle: (method: string, pathname: string, url: URL, body: unknown) =>
      handle(method, pathname, method === "GET" ? { __applicantId: url.searchParams.get("applicantId") } : body),
  };
}
