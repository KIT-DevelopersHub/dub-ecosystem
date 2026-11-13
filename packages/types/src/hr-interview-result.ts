// hrResult — 人事: 面談結果の登録 (合否 → メール → 合格ならアカウント発行) の wire 契約 (SoT)。
//
//   POST /api/v1/admin/hr/applicants/:applicantId/interview-result   (api-gateway・hr:write + members:onboard_mail)
//
// 応募者のステータスは手で変えず、面談確定 (予約で自動) → この登録 → 採用 / 不採用 で進む。
// 結果は応募者ごとに 1 件 (member_hr_interview_results.applicant_id UNIQUE)。同じ応募者への 2 回目の登録は
// 何もせず登録済みの結果を返すので、二度押ししてもアカウントもメールも 1 回だけ。
// メール本文はここの純粋関数が唯一の実体 (画面のプレビューと送信が同じ文面になる)。
import type { ISODateTime, UserId } from "./common";
import type { Applicant, ApplicantStage } from "./hr";

export const INTERVIEW_DECISIONS = ["pass", "fail"] as const;
export type InterviewDecision = (typeof INTERVIEW_DECISIONS)[number];

export const DECISION_LABELS: Record<InterviewDecision, string> = { pass: "合格", fail: "不合格" };

/** 結果を登録した後の応募者のステータス。 */
export const DECISION_STAGE: Record<InterviewDecision, ApplicantStage> = { pass: "hired", fail: "rejected" };

/** 結果を登録できるステータス (面談確定・面談済み)。 */
export const RESULT_STAGES: readonly ApplicantStage[] = ["interview_set", "interviewed"];

/**
 * 理由をメールに載せるかの既定値。理由は人事の社内メモとして書かれることが多く、そのまま応募者に届くと
 * 傷つけかねないので、合否とも既定は載せない (載せる時だけ人事がチェックする)。
 */
export const DEFAULT_INCLUDE_REASON: Record<InterviewDecision, boolean> = { pass: false, fail: false };

export const MAX_REASON_LENGTH = 2000;

/** processing = アカウント発行・メール送信の途中 / done = 完了。 */
export type InterviewResultStatus = "processing" | "done";

export interface InterviewResult {
  id: string;
  applicantId: string;
  decision: InterviewDecision;
  /** 社内の記録 (必須)。 */
  reason: string;
  includeReasonInMail: boolean;
  status: InterviewResultStatus;
  /** 合格で発行した @developershub.jp アドレス。 */
  issuedAddress: string | null;
  issuedIdentityUserId: string | null;
  /** 合格で作った名簿の行 (member_people.id)。 */
  issuedMemberId: string | null;
  /** 合否のメールを送った時刻。 */
  mailSentAt: ISODateTime | null;
  createdBy: UserId;
  createdAt: ISODateTime;
  completedAt: ISODateTime | null;
}

export interface RegisterInterviewResultRequest {
  decision: InterviewDecision;
  reason: string;
  includeReasonInMail?: boolean;
  /** 合格のとき必須: 発行する @developershub.jp の前の部分。 */
  localPart?: string;
}

export interface RegisterInterviewResultResponse {
  result: InterviewResult;
  applicant: Applicant;
  /** 既に登録済みで、この呼び出しでは何もしなかった。 */
  alreadyRegistered: boolean;
  /** 合格: 初期パスワードを載せたアカウント発行メール (既存の「アカウント発行のお知らせ」) を送れたか。 */
  accountMailSent: boolean;
}

// ---- api-gateway ⇄ member-service (INTERNAL) ----

/** POST /members/internal/hr/applicants/:id/interview-result/claim */
export interface ClaimInterviewResultRequest {
  decision: InterviewDecision;
  reason: string;
  includeReasonInMail?: boolean;
}

export interface ClaimInterviewResultResponse {
  result: InterviewResult;
  applicant: Applicant;
  /** false = 登録済み (何もしない)。true = この呼び出しが処理を進める。 */
  proceed: boolean;
}

/** POST /members/internal/hr/applicants/:id/interview-result/link (合格のみ) */
export interface LinkInterviewResultRequest {
  identityUserId: string;
  address: string;
}

/** POST /members/internal/hr/applicants/:id/interview-result/complete */
export interface CompleteInterviewResultRequest {
  accountMailSent?: boolean;
}

export interface CompleteInterviewResultResponse {
  result: InterviewResult;
  applicant: Applicant;
}

export function isInterviewDecision(v: unknown): v is InterviewDecision {
  return typeof v === "string" && (INTERVIEW_DECISIONS as readonly string[]).includes(v);
}

// ---- メール ----

export const RESULT_MAIL_SENDER = "DevelopersHub 人事チーム";

export interface ResultMailInput {
  decision: InterviewDecision;
  name: string;
  /** メールに載せる理由。載せない時は null。 */
  reason: string | null;
  /** 合格: 発行したアドレス。 */
  address?: string | null;
  /** 合格: アプリの URL (ログイン先)。 */
  appUrl?: string | null;
  /** 合格: 参加届の URL。 */
  participationUrl?: string | null;
  /** 合格: オンボーディングの URL。 */
  onboardingUrl?: string | null;
}

export interface ResultMail {
  subject: string;
  textBody: string;
}

/** 合否のメール (宛先は応募者の個人のメール)。合格の初期パスワードはここに載せず、既存のアカウント発行メールで別に届く。 */
export function renderResultMail(m: ResultMailInput): ResultMail {
  const reason = m.reason?.trim() ? m.reason.trim() : null;
  if (m.decision === "fail") {
    return {
      subject: "【DevelopersHub】面談結果のご連絡",
      textBody: [
        `${m.name} 様`,
        "",
        "先日は DevelopersHub の面談にお時間をいただき、ありがとうございました。",
        "慎重に検討を重ねました結果、誠に残念ながら、今回はご期待に沿いかねる結果となりました。",
        ...(reason ? ["", "【検討内容について】", reason] : []),
        "",
        "ご応募いただいたこと、そして面談でお話しくださったことに、心より感謝申し上げます。",
        "今後のイベントや活動でまたお会いできることがありましたら、とても嬉しく思います。",
        "",
        `${m.name} 様の今後のご活躍をお祈りしております。`,
        "",
        RESULT_MAIL_SENDER,
      ].join("\n"),
    };
  }
  return {
    subject: "【DevelopersHub】面談結果のご連絡（合格）",
    textBody: [
      `${m.name} 様`,
      "",
      "先日は DevelopersHub の面談にお時間をいただき、ありがとうございました。",
      "ぜひ一緒に活動していただきたく、合格のご連絡をいたします。",
      ...(reason ? ["", "【面談での評価】", reason] : []),
      "",
      "■ あなたの Dub アカウント",
      `メールアドレス: ${m.address ?? "（発行後にお知らせします）"}`,
      `ログイン URL: ${m.appUrl ?? ""}`,
      "初期パスワードは、別のメール「【Developers Hub】アカウント発行のお知らせ」でお送りしています。",
      "初回ログイン時にパスワードの変更をお願いします。",
      "",
      "■ 次にお願いしたいこと",
      "1. 参加届の提出（面談でお聞きした内容を入力済みです。確認して提出してください）",
      `   ${m.participationUrl ?? ""}`,
      "2. オンボーディング（最初にやっていただきたいことをまとめています）",
      `   ${m.onboardingUrl ?? ""}`,
      "",
      "参加届の URL にはあなたの氏名とメールアドレスが含まれています。他の方には共有しないでください。",
      "ご不明な点があれば、このメールに返信してください。これからどうぞよろしくお願いいたします。",
      "",
      RESULT_MAIL_SENDER,
    ].join("\n"),
  };
}

/** 公開のオンボーディング案内ページ (参加届アプリの PUBLIC_ONBOARDING_PATH と同じ)。 */
export const PUBLIC_ONBOARDING_PATH = "/onboarding";

export function absoluteUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
