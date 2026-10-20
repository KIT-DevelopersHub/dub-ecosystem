// LP管理 → 登壇者募集。LP の /proposals ページ（登壇の応募フォーム）の公開状態・入力項目を設定し、
// 届いた応募を読んで選考状況（未対応 / 採択 / 見送り）を付ける。
//
// 設計メモ:
//  - 募集の公開/停止は本番の LP に効くので、スイッチは「本番公開」タブ（LpPublishScreen）に集約した。
//    ここは状態バッジとそのタブへの導線だけを出す。
//  - 公開前の見た目は「プレビュー」タブ（登壇者募集あり/なしを選んで開く・応募不可）で確かめる。
//  - 発表タイトル・概要・氏名・メールは固定項目。発表形式などは入力項目カードで足し引きする。
//  - 応募一覧は個人情報なので app:lp:edit のときだけ取得・表示する（閲覧者には件数だけ）。
//  - 読み込み中はセクションごとのスケルトン、失敗は再試行つき ErrorState、書き込みは楽観的 UI。
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  LoadMore,
  PageHeader,
  Select,
  SkeletonLoader,
  Stack,
} from "@dub/ui";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import type { LpProposal, LpProposalStatus, LpProposalsState } from "./lpApi.tsx";
import {
  useLpProposalSubmissions,
  useLpProposals,
  useSaveProposalFields,
  useSetProposalStatus,
} from "./lpProposalsHooks.ts";
import { TICKET_FIELDS_MAX, formatDateTime } from "./lpTickets.ts";
import { LpFieldsEditorCard } from "./LpTicketFields.tsx";
import { GotoPublishButton, LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

export const PROPOSAL_STATUS_LABELS: Record<LpProposalStatus, string> = {
  submitted: "未対応",
  accepted: "採択",
  rejected: "見送り",
};

const STATUS_OPTIONS = (Object.keys(PROPOSAL_STATUS_LABELS) as LpProposalStatus[]).map((v) => ({
  value: v,
  label: PROPOSAL_STATUS_LABELS[v],
}));

/** 固定項目（LP の応募フォームで必ず入力してもらう）。追加項目は発表内容と登壇者情報の間に並ぶ。 */
const LOCKED_TALK = ["発表タイトル", "発表の概要"] as const;
const LOCKED_SPEAKER = ["氏名", "メールアドレス"] as const;

export function LpProposalsScreen(): JSX.Element {
  const proposals = useLpProposals();
  const { canEdit } = useAppCapability("lp");
  const saveFields = useSaveProposalFields();

  let body: JSX.Element;
  if (proposals.isLoading) {
    body = (
      <Stack gap={6} testId="fe2-lp-proposals-loading">
        {["status", "summary", "fields", "list"].map((k) => (
          <Card key={k} testId={`fe2-lp-proposals-loading-${k}`}>
            <SkeletonLoader lines={k === "summary" ? 2 : 4} />
          </Card>
        ))}
      </Stack>
    );
  } else if (proposals.isError || !proposals.data) {
    body = (
      <ErrorState
        testId="fe2-lp-proposals-error"
        error={{ code: "INTERNAL", message: "登壇者募集の設定を読み込めませんでした。" }}
        onRetry={() => void proposals.refetch()}
      />
    );
  } else {
    const state = proposals.data;
    const open = state.totals.total - state.totals.accepted - state.totals.rejected;
    body = (
      <Stack gap={6}>
        <StatusCard state={state} />
        <div className={styles.kpiGrid}>
          <SummaryTile testId="fe2-lp-proposals-total" label="応募数" value={`${state.totals.total.toLocaleString("ja-JP")} 件`} />
          <SummaryTile testId="fe2-lp-proposals-open" label="未対応" value={`${open.toLocaleString("ja-JP")} 件`} />
          <SummaryTile
            testId="fe2-lp-proposals-accepted"
            label="採択"
            value={`${state.totals.accepted.toLocaleString("ja-JP")} 件`}
          />
        </div>
        <LpFieldsEditorCard
          fields={state.fields}
          canEdit={canEdit}
          save={saveFields}
          locked={LOCKED_TALK}
          lockedAfter={LOCKED_SPEAKER}
          note={
            <>
              応募ページのフォームに並ぶ項目です。発表タイトル・発表の概要・氏名・メールアドレスは選考と連絡に使うため必ず入力してもらいます。
              発表形式（セッション / LT など）や所属はここで変えられます。並びは応募ページと同じです。追加の項目は最大 {TICKET_FIELDS_MAX} 個まで。
            </>
          }
          testIdPrefix="fe2-lp-proposal-field"
        />
        {canEdit ? (
          <SubmissionsCard />
        ) : (
          <Card testId="fe2-lp-proposal-submissions-locked" header={<span className={styles.sectionTitle}>応募一覧</span>}>
            <span className={styles.note}>
              応募者の氏名・メールアドレスを含むため、一覧は LP管理 の編集権限がある人にだけ表示されます。
            </span>
          </Card>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-proposals-screen">
      <PageHeader
        testId="fe2-lp-proposals-header"
        title="LP管理"
        description="LP の登壇者募集ページの公開状態と入力項目を設定し、届いた応募を確認・選考します。"
      />
      <LpTabs active="proposals" />
      {body}
    </Stack>
  );
}

function SummaryTile({ testId, label, value }: { testId: string; label: string; value: string }): JSX.Element {
  return (
    <Card testId={testId}>
      <Stack gap={1}>
        <span className={styles.kpiLabel}>{label}</span>
        <span className={styles.kpiValue}>{value}</span>
      </Stack>
    </Card>
  );
}

function StatusCard({ state }: { state: LpProposalsState }): JSX.Element {
  return (
    <Card testId="fe2-lp-proposals-status" header={<span className={styles.sectionTitle}>登壇者募集</span>}>
      <Stack gap={5}>
        <div className={styles.gotoPublish}>
          <span className={styles.kpiLabel}>募集</span>
          <Badge tone={state.enabled ? "success" : "neutral"} testId="fe2-lp-proposals-enabled-state">
            {state.enabled ? "募集中" : "停止中"}
          </Badge>
          <GotoPublishButton testId="fe2-lp-proposals-goto-publish" />
        </div>
        <span className={styles.note} data-testid="fe2-lp-proposals-enabled-hint">
          {state.enabled
            ? "LP の「登壇に応募する」ボタンから応募ページ（/proposals）へ進めます。"
            : "停止中は LP の「登壇に応募する」ボタンが「準備中」のまま押せません。"}
          募集の公開・停止は「本番公開」タブで行います。
        </span>
        <div className={styles.statusRow}>
          <span className={styles.kpiLabel}>応募ページ</span>
          <a
            className={styles.urlOpen}
            href={state.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="fe2-lp-proposals-public-url"
          >
            {state.publicUrl}
          </a>
          <Icon name="external-link" />
        </div>
      </Stack>
    </Card>
  );
}

function SubmissionsCard(): JSX.Element {
  const submissions = useLpProposalSubmissions(true);
  const rows = useMemo(() => submissions.data?.pages.flatMap((p) => p.items) ?? [], [submissions.data]);

  let content: JSX.Element;
  if (submissions.isLoading) {
    content = <SkeletonLoader lines={5} />;
  } else if (submissions.isError) {
    content = (
      <ErrorState
        testId="fe2-lp-proposal-list-error"
        error={{ code: "INTERNAL", message: "応募を読み込めませんでした。" }}
        onRetry={() => void submissions.refetch()}
      />
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        testId="fe2-lp-proposal-list-empty"
        icon="users"
        title="まだ応募はありません"
        description="応募ページから応募があると、新しい順にここへ並びます。"
      />
    );
  } else {
    content = (
      <Stack gap={5}>
        <div className={styles.orderList} data-testid="fe2-lp-proposal-list">
          {rows.map((p) => (
            <ProposalRow key={p.id} proposal={p} />
          ))}
        </div>
        <LoadMore
          testId="fe2-lp-proposal-list-more"
          hasMore={submissions.hasNextPage}
          loading={submissions.isFetchingNextPage}
          onLoadMore={() => void submissions.fetchNextPage()}
        />
      </Stack>
    );
  }

  return (
    <Card testId="fe2-lp-proposal-submissions" header={<span className={styles.sectionTitle}>応募一覧</span>}>
      {content}
    </Card>
  );
}

function ProposalRow({ proposal: p }: { proposal: LpProposal }): JSX.Element {
  const [open, setOpen] = useState(false);
  const setStatus = useSetProposalStatus();
  const tid = `fe2-lp-proposal-${p.id}`;
  return (
    <div className={styles.orderRow} data-testid={tid}>
      <div className={styles.proposalLine}>
        <div className={styles.proposalMain}>
          <strong className={styles.proposalTitle}>{p.title}</strong>
          <span className={styles.orderEmail}>
            {p.speakerName}・{p.email}
          </span>
        </div>
        <div className={styles.proposalStatus}>
          <label className={styles.srOnly} htmlFor={`${tid}-status`}>
            「{p.title}」の選考状況
          </label>
          <Select<LpProposalStatus>
            id={`${tid}-status`}
            testId={`${tid}-status`}
            value={p.status}
          options={STATUS_OPTIONS}
            onChange={(next) => {
              if (next !== p.status) setStatus.mutate({ id: p.id, status: next });
            }}
          />
        </div>
        <small className={styles.versionDate}>{formatDateTime(p.createdAt)}</small>
        <Button
          variant="ghost"
          size="sm"
          iconRight={<Icon name={open ? "chevron-down" : "chevron-right"} />}
          onClick={() => setOpen((v) => !v)}
          testId={`${tid}-details`}
        >
          詳細
        </Button>
      </div>
      {open ? (
        <dl className={styles.orderAnswers} data-testid={`${tid}-answers`}>
          <div className={styles.orderAnswer}>
            <dt>発表の概要</dt>
            <dd className={styles.proposalAbstract}>{p.abstract}</dd>
          </div>
          {p.answers.map((a) => (
            <div key={a.fieldId} className={styles.orderAnswer}>
              <dt>{a.label}</dt>
              <dd>{a.value || "（未回答）"}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
