// hrForm — 人事アプリの「面談申し込みフォーム」の wire 契約 (SoT)。
// 参加届より前の面談に申し込むための、Google フォーム風に項目を編集できるフォーム。回答すると
// 応募者 (hr.Applicant) が 面談日程調整中 で登録され、既存の人事フローに乗る。
//  - フォームの定義 (タイトル・説明・質問) は人事アプリで編集する (member-service /members/hr/interview-form)。
//  - 回答は本人が公開ページから (api-gateway /api/v1/public/hr-interview-form) 送るのが基本。
//    人事が代わりに入力することもできる (/members/hr/interview-form/responses)。
//  - 質問に binding を付けると、その回答が応募者の列 (氏名・メール・学科…) に入る。姓・名とメールは必須。
//    binding の無い質問の回答は回答 (JSON) として応募者に結びつき、詳細に表示される。
//  - 参加届と重なる項目 (姓/名・ふりがな・学年) は参加届 (member.PersonProfile) と同じ形に揃える。回答はそのまま
//    参加届の入力済みリンクに引き継げる (participationPrefill)。
// 検証 (validateFormDefinition / validateAnswers) はフロントとサービスで同じ関数を使う。
import type { ISODateTime, UserId } from "./common";
import type { Applicant, CreateApplicantRequest } from "./hr";
import { GRADES, GRADE_LABEL, PERSON_PROFILE_LABEL, normalizeGrade, splitDisplayName, type PersonProfile } from "./member";

export const FORM_QUESTION_TYPES = [
  "short_text",
  "long_text",
  "single_choice",
  "multiple_choice",
  "dropdown",
  "date",
  "email",
  "phone",
] as const;
export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number];

export const FORM_QUESTION_TYPE_LABELS: Record<FormQuestionType, string> = {
  short_text: "記述式（短文）",
  long_text: "段落（長文）",
  single_choice: "ラジオボタン（1つ選ぶ）",
  multiple_choice: "チェックボックス（複数選ぶ）",
  dropdown: "プルダウン",
  date: "日付",
  email: "メールアドレス",
  phone: "電話番号",
};

/** 選択肢を持つ形式。 */
export const CHOICE_TYPES: readonly FormQuestionType[] = ["single_choice", "multiple_choice", "dropdown"];

export function isFormQuestionType(v: unknown): v is FormQuestionType {
  return typeof v === "string" && (FORM_QUESTION_TYPES as readonly string[]).includes(v);
}

/** 回答を応募者のどの列に入れるか。 */
export const APPLICANT_BINDINGS = [
  "lastName",
  "firstName",
  "lastNameKana",
  "firstNameKana",
  "email",
  "department",
  "grade",
  "motivation",
] as const;
export type ApplicantBinding = (typeof APPLICANT_BINDINGS)[number];

export const APPLICANT_BINDING_LABELS: Record<ApplicantBinding, string> = {
  lastName: PERSON_PROFILE_LABEL.lastName,
  firstName: PERSON_PROFILE_LABEL.firstName,
  lastNameKana: PERSON_PROFILE_LABEL.lastNameKana,
  firstNameKana: PERSON_PROFILE_LABEL.firstNameKana,
  email: "メールアドレス",
  department: "学科",
  grade: "学年",
  motivation: "志望動機",
};

/** フォームに必ず含める binding (消せない・必須固定・形式固定)。 */
export const REQUIRED_BINDINGS: readonly ApplicantBinding[] = ["lastName", "firstName", "email"];

/** binding ごとに選べる質問の形式。 */
export const BINDING_TYPES: Record<ApplicantBinding, readonly FormQuestionType[]> = {
  lastName: ["short_text"],
  firstName: ["short_text"],
  lastNameKana: ["short_text"],
  firstNameKana: ["short_text"],
  email: ["email"],
  department: ["short_text", "dropdown", "single_choice"],
  grade: ["dropdown", "single_choice"],
  motivation: ["long_text", "short_text"],
};

/** 応募者の列の長さ上限 (member-service hr-service と同じ)。姓名は "姓 名" に合成して 100 文字以内に収める。 */
const BINDING_MAX: Record<ApplicantBinding, number> = {
  lastName: 50,
  firstName: 49,
  lastNameKana: 50,
  firstNameKana: 49,
  email: 200,
  department: 100,
  grade: 20,
  motivation: 2000,
};

export function isApplicantBinding(v: unknown): v is ApplicantBinding {
  return typeof v === "string" && (APPLICANT_BINDINGS as readonly string[]).includes(v);
}

export interface FormQuestion {
  /** フォーム内で一意 (英数字と _ - ・40 文字まで)。回答のキー。 */
  id: string;
  type: FormQuestionType;
  label: string;
  /** 補足説明 (任意)。 */
  description: string | null;
  required: boolean;
  /** 選択肢 (CHOICE_TYPES のときだけ・それ以外は空)。 */
  options: string[];
  /** 応募者の列に入れる場合のみ。過去の回答のスナップショットには旧 binding (氏名 1 欄) が残っている。 */
  binding: ApplicantBinding | null;
}

export interface InterviewForm {
  title: string;
  description: string | null;
  questions: FormQuestion[];
  /** false なら公開ページは「受付終了」を表示して回答を受け付けない。 */
  accepting: boolean;
  /** 楽観ロック。0 = まだ保存されていない (既定のフォーム)。 */
  version: number;
  updatedBy: UserId | null;
  updatedAt: ISODateTime | null;
}

/** 公開ページに返す形 (編集情報は含めない)。 */
export interface PublicInterviewForm {
  title: string;
  description: string | null;
  questions: FormQuestion[];
  accepting: boolean;
}

export interface SaveInterviewFormRequest {
  title: string;
  description?: string | null;
  questions: FormQuestion[];
  accepting: boolean;
  expectedVersion: number;
}

export type FormAnswerValue = string | string[];
/** 質問 id → 回答。テキスト系は文字列、チェックボックスは文字列の配列。 */
export type FormAnswers = Record<string, FormAnswerValue>;

export interface SubmitInterviewFormRequest {
  answers: FormAnswers;
}

/** 公開ページからの送信。turnstileToken は widget を出したときだけ・website は bot 用の囮 (空のまま送る)。 */
export interface PublicSubmitInterviewFormRequest extends SubmitInterviewFormRequest {
  turnstileToken?: string | null;
  website?: string | null;
}

/** 公開の応答は最小 (誰が応募済みかを漏らさない)。 */
export interface PublicSubmitInterviewFormResponse {
  accepted: true;
}

export type InterviewFormResponseVia = "public" | "staff";

export interface InterviewFormResponse {
  id: string;
  applicantId: string;
  answers: FormAnswers;
  /** 回答時点の質問 (あとでフォームを編集しても回答の見出しが崩れないように保存)。 */
  questions: FormQuestion[];
  via: InterviewFormResponseVia;
  submittedBy: UserId;
  createdAt: ISODateTime;
}

export interface InterviewFormResponseListItem extends InterviewFormResponse {
  /** 一覧表示用 (応募者が削除済みなら null)。 */
  applicantName: string | null;
}

export interface ListInterviewFormResponsesResponse {
  responses: InterviewFormResponseListItem[];
}

/** 人事による代理入力の結果。同じメールの応募者が選考中ならそこへ結び、二重登録しない (deduped)。 */
export interface StaffSubmitInterviewFormResponse {
  response: InterviewFormResponse;
  applicantId: string;
  deduped: boolean;
}

// ---- 上限 ----
export const FORM_LIMITS = {
  title: 200,
  description: 2000,
  questions: 50,
  label: 200,
  questionDescription: 1000,
  options: 50,
  option: 200,
  shortText: 200,
  longText: 5000,
  phone: 30,
} as const;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-() ]{6,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FormFieldError {
  field: string;
  reason: string;
}

/** 新しい質問 id (エディタで追加するとき)。 */
export function newQuestionId(rand: () => number = Math.random): string {
  return `q_${Math.floor(rand() * 36 ** 8).toString(36).padStart(8, "0")}`;
}

/** 学年の選択肢 (参加届と同じ表記)。 */
const GRADE_OPTIONS: string[] = GRADES.map((g) => GRADE_LABEL[g]);

/** 既定のフォーム (まだ保存されていないとき返す・編集の起点)。 */
export function defaultInterviewForm(): Omit<InterviewForm, "version" | "updatedBy" | "updatedAt"> {
  const q = (
    id: string,
    type: FormQuestionType,
    label: string,
    extra: Partial<FormQuestion> = {},
  ): FormQuestion => ({ id, type, label, description: null, required: false, options: [], binding: null, ...extra });
  return {
    title: "面談申し込みフォーム",
    description:
      "DevelopersHub の運営メンバーに興味を持っていただきありがとうございます。参加届の前に、まずは面談でお話ししましょう。以下を入力して送信してください。担当者から面談日程のご連絡をします。",
    accepting: true,
    questions: [
      ...splitQuestions("name", true),
      ...splitQuestions("nameKana", false),
      q("email", "email", "メールアドレス", { required: true, binding: "email", description: "面談日程の連絡に使います" }),
      q("department", "short_text", "学科", { binding: "department" }),
      q("grade", "dropdown", "学年", { binding: "grade", options: GRADE_OPTIONS }),
      q("interests", "multiple_choice", "興味のある活動", { options: ["イベント運営", "開発", "広報", "デザイン"] }),
      q("motivation", "long_text", "志望動機・聞いてみたいこと", { binding: "motivation" }),
      q("preferred_date", "date", "面談の希望日（あれば）"),
    ],
  };
}

/** 旧フォームの「氏名 1 欄」→ 参加届と同じ 姓/名 2 欄。 */
function splitQuestions(legacy: "name" | "nameKana", required: boolean): FormQuestion[] {
  const parts: [ApplicantBinding, string, string][] =
    legacy === "name"
      ? [
          ["lastName", "last_name", "例: 山田"],
          ["firstName", "first_name", "例: 太郎"],
        ]
      : [
          ["lastNameKana", "last_name_kana", "例: やまだ"],
          ["firstNameKana", "first_name_kana", "例: たろう"],
        ];
  return parts.map(([binding, id, description]) => ({
    id,
    type: "short_text",
    label: APPLICANT_BINDING_LABELS[binding],
    description,
    required,
    options: [],
    binding,
  }));
}

/**
 * 保存済みのフォームを参加届と同じ形に直す (D1 の行は書き換えず、読むたび・保存のたびに通す)。
 *  - 氏名 / フリガナの 1 欄 → 姓/名の 2 欄
 *  - 学年 → 参加届の選択肢で表せない形式・選択肢 (自由記述・「専攻科」など) なら参加届の選択肢に置き換える
 * 過去の回答はスナップショットを持っているので影響しない。PUT の検証前の入力も通るので、壊れた要素はそのまま
 * 返して validateFormDefinition に落とさせる。
 */
export function upgradeQuestions(questions: readonly FormQuestion[]): FormQuestion[] {
  return questions.flatMap((q): FormQuestion[] => {
    const binding: unknown = (q as Partial<FormQuestion> | null)?.binding;
    if (binding === "name") return splitQuestions("name", true);
    if (binding === "nameKana") return splitQuestions("nameKana", q.required);
    if (binding === "grade" && !isGradeQuestion(q)) return [{ ...q, type: "dropdown", options: GRADE_OPTIONS }];
    return [q];
  });
}

function isGradeQuestion(q: Pick<FormQuestion, "type" | "options">): boolean {
  return BINDING_TYPES.grade.includes(q.type) && Array.isArray(q.options) && q.options.every((o) => typeof o === "string" && !!normalizeGrade(o));
}

function strLen(v: unknown, max: number): boolean {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
}

/**
 * フォーム定義の検証。フロント (保存ボタン前) と member-service (PUT) が同じ関数を使う。
 * field は "title" / "questions" / "questions.<index>.<prop>" の形。
 */
export function validateFormDefinition(input: {
  title: unknown;
  description?: unknown;
  questions: unknown;
}): FormFieldError[] {
  const errs: FormFieldError[] = [];
  if (!strLen(input.title, FORM_LIMITS.title)) errs.push({ field: "title", reason: "invalid" });
  if (input.description != null && (typeof input.description !== "string" || input.description.length > FORM_LIMITS.description)) {
    errs.push({ field: "description", reason: "invalid" });
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > FORM_LIMITS.questions) {
    errs.push({ field: "questions", reason: "invalid" });
    return errs;
  }
  const ids = new Set<string>();
  const bindings = new Set<ApplicantBinding>();
  input.questions.forEach((raw, i) => {
    const q = (raw ?? {}) as Partial<FormQuestion>;
    const at = (p: string) => `questions.${i}.${p}`;
    if (typeof q.id !== "string" || !ID_RE.test(q.id) || ids.has(q.id)) errs.push({ field: at("id"), reason: "invalid" });
    else ids.add(q.id);
    if (!isFormQuestionType(q.type)) {
      errs.push({ field: at("type"), reason: "invalid" });
      return;
    }
    if (!strLen(q.label, FORM_LIMITS.label)) errs.push({ field: at("label"), reason: "required" });
    if (q.description != null && (typeof q.description !== "string" || q.description.length > FORM_LIMITS.questionDescription)) {
      errs.push({ field: at("description"), reason: "invalid" });
    }
    if (typeof q.required !== "boolean") errs.push({ field: at("required"), reason: "invalid" });
    const options = Array.isArray(q.options) ? q.options : null;
    if (CHOICE_TYPES.includes(q.type)) {
      const ok =
        options !== null &&
        options.length > 0 &&
        options.length <= FORM_LIMITS.options &&
        options.every((o) => strLen(o, FORM_LIMITS.option)) &&
        new Set(options.map((o) => (o as string).trim())).size === options.length;
      if (!ok) errs.push({ field: at("options"), reason: "invalid" });
    } else if (options !== null && options.length > 0) {
      errs.push({ field: at("options"), reason: "invalid" });
    }
    if (q.binding != null) {
      if (!isApplicantBinding(q.binding) || bindings.has(q.binding) || !BINDING_TYPES[q.binding].includes(q.type)) {
        errs.push({ field: at("binding"), reason: "invalid" });
      } else {
        bindings.add(q.binding);
        if (REQUIRED_BINDINGS.includes(q.binding) && q.required !== true) errs.push({ field: at("required"), reason: "required_binding" });
        if (q.binding === "grade" && options !== null && !isGradeQuestion({ type: q.type, options })) {
          errs.push({ field: at("options"), reason: "grade_options" });
        }
      }
    }
  });
  for (const b of REQUIRED_BINDINGS) {
    if (!bindings.has(b)) errs.push({ field: "questions", reason: `missing_${b}` });
  }
  return errs;
}

/** 保存前に余白を落とした正規形にする (検証を通った入力が前提)。 */
export function normalizeFormDefinition(input: SaveInterviewFormRequest): Omit<InterviewForm, "version" | "updatedBy" | "updatedAt"> {
  return {
    title: input.title.trim(),
    description: typeof input.description === "string" && input.description.trim() !== "" ? input.description.trim() : null,
    accepting: input.accepting !== false,
    questions: input.questions.map((q) => ({
      id: q.id,
      type: q.type,
      label: q.label.trim(),
      description: typeof q.description === "string" && q.description.trim() !== "" ? q.description.trim() : null,
      required: q.required === true,
      options: CHOICE_TYPES.includes(q.type) ? q.options.map((o) => o.trim()) : [],
      binding: q.binding ?? null,
    })),
  };
}

function textMax(q: FormQuestion): number {
  const base = q.type === "long_text" ? FORM_LIMITS.longText : q.type === "phone" ? FORM_LIMITS.phone : FORM_LIMITS.shortText;
  return q.binding ? Math.min(base, BINDING_MAX[q.binding]) : base;
}

/**
 * 回答の検証と正規化。未知の質問 id は捨て、空の回答は省く。field は "answers.<questionId>"。
 * フロント (送信前) と member-service (受付時) が同じ関数を使う。
 */
export function validateAnswers(
  questions: readonly FormQuestion[],
  raw: unknown,
): { value: FormAnswers; errors: FormFieldError[] } {
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const value: FormAnswers = {};
  const errors: FormFieldError[] = [];
  for (const q of questions) {
    const field = `answers.${q.id}`;
    const v = input[q.id];
    if (q.type === "multiple_choice") {
      const list = Array.isArray(v) ? v : v == null || v === "" ? [] : null;
      if (list === null || !list.every((x) => typeof x === "string" && q.options.includes(x))) {
        errors.push({ field, reason: "invalid" });
        continue;
      }
      const uniq = [...new Set(list as string[])];
      if (uniq.length === 0) {
        if (q.required) errors.push({ field, reason: "required" });
        continue;
      }
      value[q.id] = q.options.filter((o) => uniq.includes(o));
      continue;
    }
    if (v != null && typeof v !== "string") {
      errors.push({ field, reason: "invalid" });
      continue;
    }
    const t = (v ?? "").trim();
    if (t === "") {
      if (q.required) errors.push({ field, reason: "required" });
      continue;
    }
    if (t.length > textMax(q)) {
      errors.push({ field, reason: "too_long" });
      continue;
    }
    const ok =
      q.type === "email"
        ? EMAIL_RE.test(t)
        : q.type === "phone"
          ? PHONE_RE.test(t)
          : q.type === "date"
            ? DATE_RE.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`))
            : CHOICE_TYPES.includes(q.type)
              ? q.options.includes(t)
              : true;
    if (!ok) {
      errors.push({ field, reason: "invalid" });
      continue;
    }
    value[q.id] = q.type === "email" ? t.toLowerCase() : t;
  }
  return { value, errors };
}

function boundAnswers(questions: readonly FormQuestion[], answers: FormAnswers): Partial<Record<ApplicantBinding, string>> {
  const out: Partial<Record<ApplicantBinding, string>> = {};
  for (const q of questions) {
    if (!q.binding) continue;
    const v = answers[q.id];
    if (typeof v === "string" && v !== "") out[q.binding] = v;
  }
  return out;
}

const joinName = (a: string | undefined, b: string | undefined): string => [a, b].filter(Boolean).join(" ");

/** 検証済みの回答から応募者の列を取り出す (binding のある質問だけ)。姓/名は応募者の 1 列に合成する。応募経路は呼び出し側が入れる。 */
export function applicantFieldsFromAnswers(
  questions: readonly FormQuestion[],
  answers: FormAnswers,
): Pick<CreateApplicantRequest, "nameKana" | "email" | "department" | "grade" | "motivation"> & { name: string } {
  const out = boundAnswers(questions, answers);
  return {
    name: joinName(out.lastName, out.firstName),
    nameKana: joinName(out.lastNameKana, out.firstNameKana) || null,
    email: out.email ?? null,
    department: out.department ?? null,
    grade: out.grade ?? null,
    motivation: out.motivation ?? null,
  };
}

/** 参加届へ引き継ぐ項目。 */
export type ParticipationPrefill = Partial<
  Pick<
    PersonProfile,
    "lastName" | "firstName" | "lastNameKana" | "firstNameKana" | "schoolEmail" | "gmail" | "grade" | "department"
  >
>;

/**
 * 応募者 (と最新の回答) を参加届の項目に写す。正は応募者の列で (人事が直している場合があるため)、姓/名の境目だけ
 * 回答から取る。回答が無い・旧フォームの回答なら空白で分ける。メールは 1 欄なので Gmail か学校メールに振り分ける。
 */
export function participationPrefill(
  applicant: Pick<Applicant, "name" | "nameKana" | "email" | "department" | "grade">,
  response: Pick<InterviewFormResponse, "questions" | "answers"> | null,
): ParticipationPrefill {
  const out = response ? boundAnswers(response.questions, response.answers) : {};
  const split = (whole: string, last: string | undefined, first: string | undefined) =>
    last && first && joinName(last, first) === whole ? { lastName: last, firstName: first } : splitDisplayName(whole);
  const name = split(applicant.name, out.lastName, out.firstName);
  const kana = split(applicant.nameKana ?? "", out.lastNameKana, out.firstNameKana);
  const email = applicant.email?.trim() || null;
  const prefill: ParticipationPrefill = {
    lastName: name.lastName || null,
    firstName: name.firstName || null,
    lastNameKana: kana.lastName || null,
    firstNameKana: kana.firstName || null,
    ...(email ? (/@gmail\.com$/i.test(email) ? { gmail: email } : { schoolEmail: email }) : {}),
    grade: applicant.grade ? (normalizeGrade(applicant.grade) ?? null) : null,
    department: applicant.department?.trim() || null,
  };
  return Object.fromEntries(Object.entries(prefill).filter(([, v]) => v !== null)) as ParticipationPrefill;
}

/** 回答を表示用の文字列にする (チェックボックスは「、」区切り)。 */
export function formatAnswer(v: FormAnswerValue | undefined): string {
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join("、") : v;
}

/** 応募経路 (Applicant.source) に入れる文言。 */
export const SOURCE_PUBLIC = "面談申し込みフォーム";
export const SOURCE_STAFF = "面談申し込みフォーム（代理入力）";

/** 公開フォームのパス (シェルの外・ログイン不要)。 */
export const PUBLIC_INTERVIEW_FORM_PATH = "/interview-apply";
