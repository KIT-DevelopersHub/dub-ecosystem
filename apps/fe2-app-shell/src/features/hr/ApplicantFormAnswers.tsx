// 面談申し込みフォームの回答の表示。応募者の詳細ドロワー (ApplicantFormAnswers) と回答一覧の詳細
// (FormResponseView) で共有する。見出しは回答時点の質問 (スナップショット) を使うので、あとでフォームを
// 編集しても過去の回答は崩れない。
import { SkeletonLoader } from "@dub/ui";
import { hrForm } from "@dub/types";
import { useApplicantFormResponses } from "./interviewFormApi.tsx";
import styles from "./interview-form.module.css";

// HrShared と循環 import にならないよう日時の整形はここに持つ。
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export const VIA_LABELS: Record<hrForm.InterviewFormResponseVia, string> = {
  public: "本人が回答",
  staff: "人事が代理入力",
};

export function FormResponseView({
  response,
  hideBound = false,
}: {
  response: hrForm.InterviewFormResponse;
  /** 応募者の列 (氏名・メール…) に入った回答を省く (詳細ドロワーでは上に出ているので)。 */
  hideBound?: boolean;
}): JSX.Element {
  const answered = response.questions.filter((q) => response.answers[q.id] !== undefined && !(hideBound && q.binding));
  return (
    <div className={styles.responseBlock} data-testid={`fe2-hr-form-response-${response.id}`}>
      <p className={styles.responseMeta}>
        {formatDateTime(response.createdAt)}・{VIA_LABELS[response.via]}
      </p>
      {answered.length === 0 ? (
        <span className={styles.muted}>{hideBound ? "ほかの回答はありません" : "回答はありません"}</span>
      ) : (
        <dl className={styles.answers}>
          {answered.map((q) => (
            <div key={q.id} className={styles.answerPair}>
              <dt>{q.label}</dt>
              <dd>{hrForm.formatAnswer(response.answers[q.id])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** 応募者の詳細ドロワーに出す「面談申し込みフォームの回答」。回答が無い人 (手で登録) には何も出さない。 */
export function ApplicantFormAnswers({ applicantId }: { applicantId: string }): JSX.Element | null {
  const q = useApplicantFormResponses(applicantId);
  if (q.fetchStatus === "idle" && q.isPending) return null; // provider の外 (旧テスト等)
  if (q.isLoading) return <SkeletonLoader lines={4} testId="fe2-hr-detail-answers-loading" />;
  const responses = q.data?.responses ?? [];
  if (q.isError || responses.length === 0) return null;
  return (
    <div data-testid="fe2-hr-detail-answers">
      <div className={styles.answersTitle}>面談申し込みフォームの回答</div>
      {responses.map((r) => (
        <FormResponseView key={r.id} response={r} hideBound />
      ))}
    </div>
  );
}
