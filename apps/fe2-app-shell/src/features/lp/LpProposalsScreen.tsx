// LP管理 → 登壇者募集。LP の /proposals ページ（登壇の応募フォーム）の公開状態・入力項目を設定し、
// 届いた応募を読んで選考状況（未対応 / 採択 / 見送り）を付ける。
//
// 設計メモ:
//  - 募集の公開/停止は LP 全体に効くので lp:publish 必須 + 確認ダイアログ（チケット販売と同じ扱い）。
//    公開すると LP の「登壇に応募する」ボタン（いまは「準備中」）が押せるようになり /proposals へ進む。
//  - 公開前の見た目は「プレビュー」タブ（登壇者募集あり/なしを選んで開く・応募不可）で確かめる。
//  - 発表タイトル・概要・氏名・メールは固定項目。発表形式などは入力項目カードで足し引きする。
//  - 応募一覧は個人情報なので app:lp:edit のときだけ取得・表示する（閲覧者には件数だけ）。
//  - 読み込み中はセクションごとのスケルトン、失敗は再試行つき ErrorState、書き込みは楽観的 UI。
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Icon,
  LoadMore,
  Modal,
  PageHeader,
  Select,
  SkeletonLoader,
  Stack,
  Switch,
} from "@dub/ui";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import type { LpProposal, LpProposalStatus, LpProposalsState } from "./lpApi.tsx";
import {
  useLpProposalSubmissions,
  useLpProposals,
  useSaveProposalFields,
  useSetProposalStatus,
  useSetProposalsEnabled,
} from "./lpProposalsHooks.ts";
import { TICKET_FIELDS_MAX, formatDateTime } from "./lpTickets.ts";
import { LpFieldsEditorCard } from "./LpTicketFields.tsx";
import { LpTabs } from "./LpTabs.tsx";
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

/** 固定項目（LP の応募フォームで必ず入力してもらう）。 */
const LOCKED_FIELDS = ["発表タイトル", "発表の概要", "氏名", "メールアドレス"] as const;

export function LpProposalsScreen(): JSX.Element {
  const proposals = useLpProposals();
  const { canEdit } = useAppCapability("lp");
  const { can } = usePermissions();
  const canToggle = canEdit && can("lp:publish");
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
        <StatusCard state={state} canToggle={canToggle} />
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
          locked={LOCKED_FIELDS}
          note={
            <>
              応募ページのフォームに並ぶ項目です。発表タイトル・発表の概要・氏名・メールアドレスは選考と連絡に使うため必ず入力してもらいます。
              発表形式（セッション / LT など）や所属はここで変えられます。追加の項目は最大 {TICKET_FIELDS_MAX} 個まで。
            </>
          }
          testIdPrefix="fe2-lp-proposal-field"
        />
        {canEdit ? <SubmissionsCard /> : null}
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

function StatusCard({ state, canToggle }: { state: LpProposalsState; canToggle: boolean }): JSX.Element {
  const setEnabled = useSetProposalsEnabled();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const openConfirm = (next: boolean): void => {
    setAcknowledged(false);
    setConfirming(next);
  };

  return (
    <Card testId="fe2-lp-proposals-status" header={<span className={styles.sectionTitle}>登壇者募集</span>}>
      <Stack gap={5}>
        <div className={styles.statusRow}>
          <Switch
            id="fe2-lp-proposals-enabled"
            testId="fe2-lp-proposals-enabled"
            checked={state.enabled}
            disabled={!canToggle || setEnabled.isPending}
            label="登壇者の募集を公開"
            onChange={openConfirm}
          />
          <Badge tone={state.enabled ? "success" : "neutral"} testId="fe2-lp-proposals-enabled-state">
            {state.enabled ? "募集中" : "停止中"}
          </Badge>
        </div>
        {!canToggle ? (
          <span className={styles.note} data-testid="fe2-lp-proposals-enabled-hint">
            切り替えには lp:publish 権限が必要です
          </span>
        ) : null}
        <span className={styles.note}>
          {state.enabled
            ? "LP の「登壇に応募する」ボタンから応募ページ（/proposals）へ進めます。"
            : "停止中は LP の「登壇に応募する」ボタンが「準備中」のまま押せません。公開前の見た目は「プレビュー」タブで確かめられます。"}
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
      {confirming !== null ? (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={confirming ? "登壇者の募集を全員に公開しますか？" : "登壇者の募集を停止します"}
          size="sm"
          testId="fe2-lp-proposals-enabled-dialog"
          footer={
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-3)" }}>
              <Button variant="secondary" onClick={() => setConfirming(null)} testId="fe2-lp-proposals-enabled-cancel">
                キャンセル
              </Button>
              <Button
                variant={confirming ? "primary" : "danger"}
                disabled={confirming && !acknowledged}
                onClick={() => {
                  const next = confirming;
                  setConfirming(null);
                  setEnabled.mutate({ enabled: next });
                }}
                testId="fe2-lp-proposals-enabled-confirm"
              >
                {confirming ? "公開する" : "停止する"}
              </Button>
            </div>
          }
        >
          {confirming ? (
            <p className={styles.publishWarning} role="alert" data-testid="fe2-lp-proposals-enabled-warning">
              {"本当に全ユーザーに公開されますがよろしいですか？公開すると、ログインしていない一般の方を含むインターネット上の誰でも、応募ページを開いて登壇に応募できるようになります。"}
            </p>
          ) : null}
          <ul style={{ margin: 0, paddingLeft: "var(--dub-space-5)", display: "grid", gap: "var(--dub-space-2)" }}>
            {confirming ? (
              <>
                <li>公開すると LP の「登壇に応募する」ボタンが押せるようになり、/proposals の応募ページが出ます。</li>
                <li>公開前の見た目は「プレビュー」タブで確かめられます。</li>
              </>
            ) : (
              <>
                <li>停止すると LP の「登壇に応募する」ボタンは「準備中」に戻り、/proposals ページは表示されなくなります。</li>
                <li>これまでの応募は消えません。</li>
              </>
            )}
            <li>反映まで最大 1 分ほどかかります。</li>
          </ul>
          {confirming ? (
            <div className={styles.publishAck}>
              <Checkbox
                id="fe2-lp-proposals-enabled-ack"
                testId="fe2-lp-proposals-enabled-ack"
                checked={acknowledged}
                label="全ユーザーに公開されることを理解しました"
                onChange={setAcknowledged}
              />
            </div>
          ) : null}
        </Modal>
      ) : null}
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
