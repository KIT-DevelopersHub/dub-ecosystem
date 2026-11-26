// LP管理 → スポンサー募集。LP の JOIN スポンサーカード → /sponsors（資料請求フォーム）の公開を切り替え、
// 資料請求の通知（Dub 通知は app:sponsor:edit を持つ人へ固定・追加のメールは任意）を決め、届いた請求の対応状況を付ける。
//
// 設計メモ:
//  - 公開 on/off と通知先は lp:publish（サーバーの表で判定。持っていなければ 403 のトーストで戻る）。
//  - 一覧は個人情報なので app:lp:edit のときだけ取得・表示する（閲覧者には件数だけ）。
//  - 読み込み中はセクションごとのスケルトン、失敗は再試行つき ErrorState、書き込みは楽観的 UI。
import { useEffect, useMemo, useState } from "react";
import type { lpSponsor } from "@dub/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  Icon,
  LoadMore,
  PageHeader,
  Select,
  SkeletonLoader,
  Stack,
  Switch,
  TextField,
} from "@dub/ui";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import {
  useLpSponsor,
  useLpSponsorItems,
  useSetSponsorEnabled,
  useSetSponsorInquiryStatus,
  useSetSponsorNotify,
} from "./lpSponsorHooks.ts";
import { formatDateTime } from "./lpTickets.ts";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

type State = lpSponsor.LpSponsorInquiriesState;
type Status = lpSponsor.LpSponsorInquiryStatus;

export const SPONSOR_STATUS_LABELS: Record<Status, string> = { new: "未対応", sent: "資料送付済み", closed: "対応終了" };
const STATUS_OPTIONS = (Object.keys(SPONSOR_STATUS_LABELS) as Status[]).map((v) => ({ value: v, label: SPONSOR_STATUS_LABELS[v] }));
const NOTIFIED_LABELS: Record<lpSponsor.LpSponsorInquiry["notifiedVia"], string> = {
  both: "Dub 通知・メールで通知済み",
  app: "Dub 通知で通知済み",
  mail: "メールで通知済み",
  none: "通知が届いていません",
};

export function LpSponsorScreen(): JSX.Element {
  const q = useLpSponsor();
  const { canEdit } = useAppCapability("lp");

  let body: JSX.Element;
  if (q.isLoading) {
    body = (
      <Stack gap={6} testId="fe2-lp-sponsor-loading">
        {["status", "notify", "list"].map((k) => (
          <Card key={k} testId={`fe2-lp-sponsor-loading-${k}`}>
            <SkeletonLoader lines={4} />
          </Card>
        ))}
      </Stack>
    );
  } else if (q.isError || !q.data) {
    body = (
      <ErrorState
        testId="fe2-lp-sponsor-error"
        error={{ code: "INTERNAL", message: "スポンサー募集の設定を読み込めませんでした。" }}
        onRetry={() => void q.refetch()}
      />
    );
  } else {
    const state = q.data;
    body = (
      <Stack gap={6}>
        <StatusCard state={state} canEdit={canEdit} />
        <NotifyCard state={state} canEdit={canEdit} />
        {canEdit ? (
          <ItemsCard />
        ) : (
          <Card testId="fe2-lp-sponsor-items-locked" header={<span className={styles.sectionTitle}>資料請求の一覧</span>}>
            <span className={styles.note}>
              請求者の氏名・メールアドレスを含むため、一覧は LP管理 の編集権限がある人にだけ表示されます（届いた件数:{" "}
              {state.totals.total.toLocaleString("ja-JP")} 件）。
            </span>
          </Card>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-sponsor-screen">
      <PageHeader
        testId="fe2-lp-sponsor-header"
        title="LP管理"
        description="LP のスポンサー募集（資料請求フォーム）の公開と通知先を設定し、届いた資料請求に対応します。"
      />
      <LpTabs active="sponsors" />
      {body}
    </Stack>
  );
}

function StatusCard({ state, canEdit }: { state: State; canEdit: boolean }): JSX.Element {
  const setEnabled = useSetSponsorEnabled();
  return (
    <Card testId="fe2-lp-sponsor-status" header={<span className={styles.sectionTitle}>スポンサー募集</span>}>
      <Stack gap={5}>
        <div className={styles.statusRow}>
          <span className={styles.kpiLabel}>公開</span>
          <Switch
            id="fe2-lp-sponsor-enabled"
            testId="fe2-lp-sponsor-enabled"
            checked={state.enabled}
            disabled={!canEdit || setEnabled.isPending}
            label={state.enabled ? "公開中" : "準備中"}
            onChange={(v) => setEnabled.mutate({ enabled: v })}
          />
          <Badge tone={state.totals.open > 0 ? "warning" : "neutral"} testId="fe2-lp-sponsor-open">
            未対応 {state.totals.open.toLocaleString("ja-JP")} 件
          </Badge>
        </div>
        <span className={styles.note} data-testid="fe2-lp-sponsor-enabled-hint">
          {state.enabled
            ? "LP の JOIN にあるスポンサーカードから資料請求ページへ進めます。"
            : "準備中は LP の JOIN にあるスポンサーカードが「準備中」のまま押せません。"}
          公開/停止には lp:publish 権限が必要です。
        </span>
        <div className={styles.statusRow}>
          <span className={styles.kpiLabel}>資料請求ページ</span>
          <a
            className={styles.urlOpen}
            href={state.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="fe2-lp-sponsor-public-url"
          >
            {state.publicUrl}
          </a>
          <Icon name="external-link" />
        </div>
      </Stack>
    </Card>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function NotifyCard({ state, canEdit }: { state: State; canEdit: boolean }): JSX.Element {
  const save = useSetSponsorNotify();
  const [email, setEmail] = useState(state.notifyEmail ?? "");
  useEffect(() => setEmail(state.notifyEmail ?? ""), [state.notifyEmail]);
  const emailError = email.trim() && !EMAIL_RE.test(email.trim()) ? "メールアドレスの形式が正しくありません" : null;
  const dirty = email.trim() !== (state.notifyEmail ?? "");
  return (
    <Card testId="fe2-lp-sponsor-notify" header={<span className={styles.sectionTitle}>通知先</span>}>
      <Stack gap={5}>
        <span className={styles.note} data-testid="fe2-lp-sponsor-notify-app">
          資料請求が届くと、「スポンサー」アプリを編集できる人に Dub の通知（通知の受信箱とスマホのプッシュ）で
          「スポンサーの資料請求が届きました」と知らせます。受け取る人はロール管理で「スポンサー」アプリの編集を持つロールで決まり、
          各自の通知設定でメールでも受け取れます。
        </span>
        <span className={styles.note}>
          請求者には受付完了のメールを自動で送ります。資料そのものはチームから手で送ってください。
        </span>
        <FormField
          label="追加で通知するメールアドレス（任意）"
          htmlFor="fe2-lp-sponsor-email"
          help={
            state.defaultNotifyEmail
              ? `Dub のアカウントが無い共有アドレス向け。空欄のときは既定の ${state.defaultNotifyEmail} に送ります`
              : "Dub のアカウントが無い共有アドレス向け。空欄 = メールでは送らない"
          }
          {...(emailError ? { error: emailError } : {})}
        >
          <TextField
            id="fe2-lp-sponsor-email"
            testId="fe2-lp-sponsor-email"
            value={email}
            placeholder="sponsor@example.com"
            disabled={!canEdit}
            onChange={setEmail}
          />
        </FormField>
        <div className={styles.statusRow}>
          <Button
            variant="primary"
            size="sm"
            testId="fe2-lp-sponsor-notify-save"
            disabled={!canEdit || !dirty || !!emailError || save.isPending}
            onClick={() => save.mutate({ notifyEmail: email.trim() || null })}
          >
            保存
          </Button>
        </div>
      </Stack>
    </Card>
  );
}

function ItemsCard(): JSX.Element {
  const items = useLpSponsorItems(true);
  const rows = useMemo(() => items.data?.pages.flatMap((p) => p.items) ?? [], [items.data]);

  let content: JSX.Element;
  if (items.isLoading) {
    content = <SkeletonLoader lines={5} />;
  } else if (items.isError) {
    content = (
      <ErrorState
        testId="fe2-lp-sponsor-list-error"
        error={{ code: "INTERNAL", message: "資料請求を読み込めませんでした。" }}
        onRetry={() => void items.refetch()}
      />
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        testId="fe2-lp-sponsor-list-empty"
        icon="users"
        title="まだ資料請求はありません"
        description="資料請求ページから送信があると、新しい順にここへ並びます。"
      />
    );
  } else {
    content = (
      <Stack gap={5}>
        <div className={styles.orderList} data-testid="fe2-lp-sponsor-list">
          {rows.map((r) => (
            <InquiryRow key={r.id} item={r} />
          ))}
        </div>
        <LoadMore
          testId="fe2-lp-sponsor-list-more"
          hasMore={items.hasNextPage}
          loading={items.isFetchingNextPage}
          onLoadMore={() => void items.fetchNextPage()}
        />
      </Stack>
    );
  }
  return (
    <Card testId="fe2-lp-sponsor-items" header={<span className={styles.sectionTitle}>資料請求の一覧</span>}>
      {content}
    </Card>
  );
}

function InquiryRow({ item: r }: { item: lpSponsor.LpSponsorInquiry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const setStatus = useSetSponsorInquiryStatus();
  const tid = `fe2-lp-sponsor-${r.id}`;
  const who = r.companyName || r.contactName || r.email;
  return (
    <div className={styles.orderRow} data-testid={tid}>
      <div className={styles.proposalLine}>
        <div className={styles.proposalMain}>
          <strong className={styles.proposalTitle}>{r.companyName || "（会社名なし）"}</strong>
          <span className={styles.orderEmail}>
            {r.contactName ? `${r.contactName}・` : ""}
            {r.email}
          </span>
        </div>
        <div className={styles.proposalStatus}>
          <label className={styles.srOnly} htmlFor={`${tid}-status`}>
            「{who}」の対応状況
          </label>
          <Select<Status>
            id={`${tid}-status`}
            testId={`${tid}-status`}
            value={r.status}
            options={STATUS_OPTIONS}
            onChange={(next) => {
              if (next !== r.status) setStatus.mutate({ id: r.id, status: next });
            }}
          />
        </div>
        <small className={styles.versionDate}>{formatDateTime(r.createdAt)}</small>
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
            <dt>ひとこと</dt>
            <dd className={styles.proposalAbstract}>{r.message || "（未記入）"}</dd>
          </div>
          <div className={styles.orderAnswer}>
            <dt>スポンサーチームへの通知</dt>
            <dd>{NOTIFIED_LABELS[r.notifiedVia]}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
