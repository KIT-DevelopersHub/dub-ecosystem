// 人事 → 申し込みフォーム。参加届より前の面談に申し込んでもらう公開フォームを管理する。
//  - 公開リンク (コピー / 開く): 応募したい人に送る。ログイン不要。
//  - フォームの編集 (InterviewFormEditor): Google フォーム風に質問を追加・並べ替え・必須・選択肢・応募者の項目。
//  - 回答: 届いた回答の一覧 (行を押すと回答の中身)。回答した人は応募者タブに 面談日程調整中 で入っている。
//  - 代理入力: 電話や対面で聞き取った内容を人事が代わりに入力する (同じく応募者として登録)。
import { useMemo, useState } from "react";
import {
  Button,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Modal,
  SkeletonCard,
  SkeletonTable,
  Stack,
  type ColumnDef,
} from "@dub/ui";
import { hrForm } from "@dub/types";
import { PublicUrlCard } from "../participation/PublicUrlCard.tsx";
import { HrFrame } from "./HrApplicantsScreen.tsx";
import { useHrCapability } from "./HrShared.tsx";
import { InterviewFormEditor } from "./InterviewFormEditor.tsx";
import { InterviewFormFields, useAnswerDraft } from "./InterviewFormFields.tsx";
import { FormResponseView, VIA_LABELS, formatDateTime } from "./ApplicantFormAnswers.tsx";
import { useInterviewForm, useInterviewFormResponses, useSubmitOnBehalf } from "./interviewFormApi.tsx";
import styles from "./interview-form.module.css";

export function HrInterviewFormScreen(): JSX.Element {
  const form = useInterviewForm();
  const { canWrite } = useHrCapability();

  let editor: JSX.Element;
  if (form.isLoading) {
    editor = <SkeletonCard testId="fe2-hr-form-loading" />;
  } else if (form.isError || !form.data) {
    editor = (
      <ErrorState
        testId="fe2-hr-form-error"
        error={{ code: "INTERNAL", message: "フォームを読み込めませんでした。" }}
        onRetry={() => void form.refetch()}
      />
    );
  } else {
    editor = <InterviewFormEditor form={form.data} canWrite={canWrite} />;
  }

  return (
    <HrFrame active="form">
      <Stack gap={6}>
        <PublicUrlCard
          title="公開フォームの URL"
          hint="面談を希望する人にこの URL を送ってください。ログインは不要です。回答すると応募者タブに「面談日程調整中」で登録されます。"
          path={hrForm.PUBLIC_INTERVIEW_FORM_PATH}
          testId="fe2-hr-form-share"
        />
        {editor}
        <ResponsesCard form={form.data ?? null} canWrite={canWrite} />
      </Stack>
    </HrFrame>
  );
}

function ResponsesCard({ form, canWrite }: { form: hrForm.InterviewForm | null; canWrite: boolean }): JSX.Element {
  const list = useInterviewFormResponses();
  const [openId, setOpenId] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const rows = list.data?.responses ?? [];
  const open = rows.find((r) => r.id === openId) ?? null;

  const columns: ColumnDef<hrForm.InterviewFormResponseListItem>[] = useMemo(
    () => [
      { key: "at", header: "回答日時", noWrap: true, cell: (r) => formatDateTime(r.createdAt) },
      {
        key: "name",
        header: "氏名",
        noWrap: true,
        cell: (r) => <span data-testid={`fe2-hr-form-row-${r.id}`}>{r.applicantName ?? "（削除済みの応募者）"}</span>,
      },
      { key: "email", header: "メール", cell: (r) => emailOf(r) || "—" },
      { key: "via", header: "入力", noWrap: true, cell: (r) => VIA_LABELS[r.via] },
    ],
    [],
  );

  let body: JSX.Element;
  if (list.isLoading) body = <SkeletonTable rows={4} columns={4} />;
  else if (list.isError)
    body = (
      <ErrorState
        testId="fe2-hr-form-responses-error"
        error={{ code: "INTERNAL", message: "回答を読み込めませんでした。" }}
        onRetry={() => void list.refetch()}
      />
    );
  else if (rows.length === 0)
    body = (
      <EmptyState
        testId="fe2-hr-form-responses-empty"
        icon="inbox"
        title="まだ回答はありません"
        description="公開フォームの URL を送ると、ここに回答が届きます。"
      />
    );
  else
    body = (
      <DataTable<hrForm.InterviewFormResponseListItem>
        testId="fe2-hr-form-responses"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpenId(r.id)}
      />
    );

  return (
    <Card
      testId="fe2-hr-form-responses-card"
      header={
        <div className={styles.responseHead}>
          <span>回答{list.data ? `（${rows.length} 件）` : ""}</span>
          <Button size="sm" variant="secondary" testId="fe2-hr-form-enter" disabled={!canWrite || !form} onClick={() => setEntering(true)}>
            代わりに入力する
          </Button>
        </div>
      }
      padded={rows.length === 0 || list.isLoading || list.isError}
    >
      {body}
      <Drawer
        testId="fe2-hr-form-response-drawer"
        open={open !== null}
        onClose={() => setOpenId(null)}
        title={open?.applicantName ?? "回答"}
      >
        {open ? <FormResponseView response={open} /> : <span />}
      </Drawer>
      {form ? <OnBehalfModal form={form} open={entering} onClose={() => setEntering(false)} /> : null}
    </Card>
  );
}

function emailOf(r: hrForm.InterviewFormResponse): string {
  const q = r.questions.find((x) => x.binding === "email");
  const v = q ? r.answers[q.id] : undefined;
  return typeof v === "string" ? v : "";
}

/** 人事が代わりに入力 (電話・対面で聞き取った内容)。送った瞬間に応募者の表へ仮の行が入る (楽観的)。 */
function OnBehalfModal({ form, open, onClose }: { form: hrForm.InterviewForm; open: boolean; onClose: () => void }): JSX.Element {
  const draft = useAnswerDraft(form.questions);
  const submit = useSubmitOnBehalf();
  const close = () => {
    draft.reset();
    onClose();
  };
  const onSubmit = () => {
    const answers = draft.validate();
    if (!answers) return;
    const fields = hrForm.applicantFieldsFromAnswers(form.questions, answers);
    // 楽観的: すぐ閉じて表に反映。失敗時はトースト + 行を戻す (hooks)。
    submit.mutate({ answers, preview: { name: fields.name, email: fields.email ?? null } });
    close();
  };
  return (
    <Modal
      testId="fe2-hr-form-enter-modal"
      open={open}
      onClose={close}
      title="面談申し込みを代わりに入力"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            キャンセル
          </Button>
          <Button testId="fe2-hr-form-enter-submit" onClick={onSubmit}>
            登録する
          </Button>
        </>
      }
    >
      <p className={styles.hint}>
        受付を停止していても入力できます。同じメールアドレスの人が選考中なら、新しく登録せずその人に回答を追加します。
      </p>
      <InterviewFormFields
        questions={form.questions}
        answers={draft.answers}
        errors={draft.errors}
        onChange={draft.setAnswer}
        idPrefix="fe2-hr-form-enter"
      />
    </Modal>
  );
}
