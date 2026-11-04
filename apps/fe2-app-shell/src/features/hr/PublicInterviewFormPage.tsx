// 面談申し込みフォームの PUBLIC ページ (/interview-apply)。申し込む人はまだ Dub のアカウントを持って
// いないので、参加届 (/participate) と同じくシェルの外 (RequireAuth の外) に置く。質問は人事アプリで
// 編集したもの (GET /api/v1/public/hr-interview-form) をそのまま描く。送信すると応募者として
// 面談日程調整中 で登録され、人事から面談日程の連絡が届く。
// bot 対策: 人には見えない囮の欄 (website) を置き、gateway が埋まった送信を黙って捨てる。
import { useState } from "react";
import { Button, Card, EmptyState, ErrorState, SkeletonList } from "@dub/ui";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import type { hrForm } from "@dub/types";
import { InterviewFormProvider, messageFor, usePublicInterviewForm, useSubmitPublicInterviewForm } from "./interviewFormApi.tsx";
import { InterviewFormFields, toAnswerErrors, useAnswerDraft } from "./InterviewFormFields.tsx";
import styles from "./interview-form.module.css";

export function PublicInterviewFormPage({ api }: { api: ApiClient }): JSX.Element {
  return (
    <InterviewFormProvider api={api}>
      <div className={styles.publicPage} data-testid="interview-form-public-page">
        <div className={styles.publicInner}>
          <PublicFormBody />
        </div>
      </div>
    </InterviewFormProvider>
  );
}

function PublicFormBody(): JSX.Element {
  const form = usePublicInterviewForm();
  if (form.isLoading) return <SkeletonList rows={6} testId="interview-form-public-loading" />;
  if (form.isError || !form.data) {
    const display = ApiError.isApiError(form.error)
      ? toDisplayableError(form.error)
      : { code: "UNKNOWN", message: "フォームを読み込めませんでした" };
    return <ErrorState testId="interview-form-public-error" error={display} onRetry={() => void form.refetch()} />;
  }
  return <PublicForm form={form.data} />;
}

function PublicForm({ form }: { form: hrForm.PublicInterviewForm }): JSX.Element {
  const draft = useAnswerDraft(form.questions);
  const submit = useSubmitPublicInterviewForm();
  const [website, setWebsite] = useState("");
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const hero = (
    <Card testId="interview-form-public-hero">
      <div className={styles.publicHero}>
        <h1 className={styles.publicTitle}>{form.title}</h1>
        {form.description ? <p className={styles.publicLead}>{form.description}</p> : null}
        {form.accepting && !done ? <p className={styles.requiredNote}>* は必須の項目です</p> : null}
      </div>
    </Card>
  );

  if (!form.accepting) {
    return (
      <>
        {hero}
        <EmptyState
          testId="interview-form-public-closed"
          icon="clock"
          title="現在、面談の申し込みは受け付けていません"
          description="受付を再開したら、このページから申し込めるようになります。"
        />
      </>
    );
  }

  if (done) {
    return (
      <>
        {hero}
        <Card testId="interview-form-public-thanks">
          <div className={styles.thanks}>
            <p className={styles.thanksLead}>送信しました。ありがとうございます！</p>
            <p className={styles.muted}>入力いただいたメールアドレスに、担当者から面談日程のご連絡をします。</p>
            <Button
              variant="secondary"
              testId="interview-form-public-again"
              onClick={() => {
                draft.reset();
                setDone(false);
              }}
            >
              別の回答を送る
            </Button>
          </div>
        </Card>
      </>
    );
  }

  const onSubmit = () => {
    setFailure(null);
    const answers = draft.validate();
    if (!answers) return;
    submit.mutate(
      { answers, website },
      {
        onSuccess: () => setDone(true),
        onError: (err) => {
          // 400 の項目エラーは各欄に出す (サービスと同じ検証なので通常は起きない)。
          if (ApiError.isApiError(err) && Array.isArray(err.details)) {
            const mapped = toAnswerErrors(form.questions, err.details as { field: string; reason: string }[]);
            if (Object.keys(mapped).length > 0) {
              draft.setErrors(mapped);
              return;
            }
          }
          setFailure(messageFor(err, "送信できませんでした。時間をおいてもう一度お試しください。"));
        },
      },
    );
  };

  return (
    <>
      {hero}
      <Card testId="interview-form-public-card">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <InterviewFormFields
            questions={form.questions}
            answers={draft.answers}
            errors={draft.errors}
            onChange={draft.setAnswer}
            idPrefix="interview-form-public"
          />
          {/* 囮: 人には見えない (スクリーンリーダーからも隠す)。bot だけが埋める。 */}
          <div className={styles.honeypot} aria-hidden="true">
            <label htmlFor="interview-form-website">Website</label>
            <input
              id="interview-form-website"
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          {failure ? (
            <p className={styles.errorSummary} role="alert" data-testid="interview-form-public-failure">
              {failure}
            </p>
          ) : null}
          <div className={styles.submitRow}>
            <Button type="submit" testId="interview-form-public-submit" loading={submit.isPending}>
              送信する
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
