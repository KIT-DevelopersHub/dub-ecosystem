// 管理者向け「メールから日付を補完」: Dub に残っている送受信メールから、初回連絡日・最終接触日・ステータスを
// まとめて埋める。開くとまず確認 (保存しない) → 変わる企業と項目を一覧 → 「N 社に反映する」で保存。
// 1 回の呼び出しでは数十社ずつ見る (サーバの 1 回あたりの上限) ので、ページを最後まで順に送る。
import { useEffect, useState } from "react";
import { Button, DataTable, EmptyState, Modal, SkeletonTable, Stack, useToast, type ColumnDef } from "@dub/ui";
import { DialogActions, FormError } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { formatOn } from "./leads.ts";
import { useMailBackfill } from "./mailSyncHooks.ts";
import styles from "./sponsor.module.css";

type Proposal = sponsor.MailBackfillProposal;

const FIELD_LABEL: Record<sponsor.MailSyncField, string> = { status: "ステータス", firstContactOn: "初回連絡日", lastContactOn: "最終接触日" };
const MATCH_LABEL: Record<sponsor.MailMatchBy, string> = { link: "紐付け", email: "担当者メール", domain: "同じドメイン" };
const show = (c: sponsor.LeadFieldChange, v: string | null) => (v === null ? "—" : c.field === "status" ? v : formatOn(v));

const columns: ColumnDef<Proposal>[] = [
  { key: "company", header: "企業名", minWidth: "10rem", cell: (p) => <span data-testid="fe2-sponsor-backfill-company">{p.companyName}</span> },
  {
    key: "changes",
    header: "変わる項目",
    minWidth: "14rem",
    cell: (p) => (
      <ul className={styles.backfillChanges}>
        {p.changes.map((c) => (
          <li key={c.field}>
            {FIELD_LABEL[c.field]}: {show(c, c.from)} → <strong>{show(c, c.to)}</strong>
          </li>
        ))}
      </ul>
    ),
  },
  {
    key: "evidence",
    header: "根拠のメール",
    minWidth: "14rem",
    cell: (p) => (
      <span className={styles.note}>
        {MATCH_LABEL[p.matchedBy]}で一致・
        {p.evidence
          .slice(0, 2)
          .map((e) => `${formatOn(sponsor.jstDate(e.at))} ${e.direction === "sent" ? "送信" : "受信"} ${e.counterpart}`)
          .join(" / ")}
      </span>
    ),
  },
];

export function MailBackfillDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const preview = useMailBackfill();
  const apply = useMailBackfill();
  const toast = useToast();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setProgress(null);
    apply.reset();
    preview.mutate({ dryRun: true, onPage: (done, total) => setProgress({ done, total }) });
    // 開くたびに 1 回だけ確認し直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const proposals = preview.data ?? [];
  const error = preview.error ?? apply.error;
  const errorText = error ? (ApiError.isApiError(error) ? toDisplayableError(error).message : "メールを確認できませんでした。") : "";

  const submit = () =>
    apply.mutate(
      { dryRun: false },
      {
        onSuccess: (done) => {
          const saved = done.filter((p) => p.applied).length;
          const missed = done.length - saved;
          toast.show({
            kind: "success",
            title: `${saved} 社の日付を補完しました`,
            ...(missed > 0 ? { description: `${missed} 社は他の人の編集と重なったので、もう一度お試しください。` } : {}),
          });
          onClose();
        },
      },
    );

  let body: JSX.Element;
  if (preview.isPending) {
    body = (
      <div aria-busy="true" aria-label="メールを確認中" data-testid="fe2-sponsor-backfill-loading">
        <p className={styles.note}>{progress ? `${progress.done} / ${progress.total} 社を確認しました…` : "メールを確認しています…"}</p>
        <SkeletonTable rows={4} columns={3} />
      </div>
    );
  } else if (preview.isError) {
    body = <span />;
  } else if (proposals.length === 0) {
    body = (
      <EmptyState
        testId="fe2-sponsor-backfill-empty"
        icon="search"
        title="補完できる日付はありません"
        description="担当者メールが空の企業は、メール画面の「スポンサー企業に紐付け」で相手のアドレスを紐付けると、そのメールから日付が入ります。"
      />
    );
  } else {
    body = (
      <DataTable<Proposal> testId="fe2-sponsor-backfill-table" columns={columns} rows={proposals} rowKey={(p) => p.leadId} />
    );
  }

  return (
    <Modal testId="fe2-sponsor-backfill" open={open} onClose={onClose} title="メールから日付を補完" size="lg">
      <Stack gap={4}>
        <p className={styles.note}>
          Dub のメールで営業先と送受信した記録から、初回連絡日・最終接触日とステータス（未接触→初回連絡・初回連絡→返信あり）を埋めます。
          入っている日付は、メールの方が早い (初回連絡日) / 遅い (最終接触日) 時だけ置き換えます。見送りのステータスは変えません。
        </p>
        <FormError testId="fe2-sponsor-backfill-error">{errorText}</FormError>
        {body}
        <DialogActions>
          <Button variant="secondary" size="lg" testId="fe2-sponsor-backfill-cancel" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            size="lg"
            testId="fe2-sponsor-backfill-apply"
            disabled={preview.isPending || proposals.length === 0 || apply.isPending}
            onClick={submit}
          >
            {apply.isPending ? "反映中…" : `${proposals.length} 社に反映する`}
          </Button>
        </DialogActions>
      </Stack>
    </Modal>
  );
}
