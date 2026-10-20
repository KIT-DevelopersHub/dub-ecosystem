// LP管理 → 本番公開。一般の人が見る本番 LP に「どの版を出すか」「チケット販売・登壇者募集を出すか」を
// 1 か所で切り替える（本番を変えるスイッチはこのタブだけに置く）。
//
// 設計メモ:
//  - 既存 API だけを使う（GET/POST /lp/publish・/lp/tickets/enabled・/lp/tickets/cta・/lp/proposals/enabled）。
//  - どの操作も本番に即反映されるので確認ダイアログを挟む。公開する側（販売・募集の公開）は
//    「全員に公開される」ことへの同意チェックを押すまで実行できない（以前の各タブと同じ扱い）。
//  - 書き込みは楽観的 UI（lpHooks / lpTicketsHooks / lpProposalsHooks の mutation が失敗でロールバック）。
//  - 切り替えには app:lp:edit + lp:publish が要る。無い人・サーバーが 403 を返した人は読み取り専用。
//  - 下部には ?version=live で今の本番 LP を埋め込む（プレビュー用 cookie を消して素の見え方にする）。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorState,
  FormField,
  Icon,
  Modal,
  PageHeader,
  Select,
  SkeletonLoader,
  Stack,
  Switch,
} from "@dub/ui";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import { ApiError } from "../../lib/api-client.tsx";
import { listLpVersions, type LpVersion } from "./lpVersions.ts";
import type { LpProposalsState, LpPublishState, LpTicketsState } from "./lpApi.tsx";
import { useLpPublish, useSetLpPublish } from "./lpHooks.ts";
import { useLpTickets, useSetTicketsCta, useSetTicketsEnabled } from "./lpTicketsHooks.ts";
import { useLpProposals, useSetProposalsEnabled } from "./lpProposalsHooks.ts";
import { formatSwitchedAt, LP_FLAG_CACHE_SECONDS, lpLiveUrl, PUBLISH_SUCCESS_MARKER } from "./lpPublish.ts";
import { LpViewer } from "./LpViewer.tsx";
import { LpTabs } from "./LpTabs.tsx";
import { ctaBadge } from "./lpTickets.ts";
import styles from "./lp.module.css";

/** mutate の onError に渡す。403 なら以後この画面を読み取り専用にする。 */
type OnError = (err: unknown) => void;

export function LpPublishScreen(): JSX.Element {
  const { canEdit } = useAppCapability("lp");
  const { can } = usePermissions();
  const [forbidden, setForbidden] = useState(false);
  const readOnly = !(canEdit && can("lp:publish")) || forbidden;
  const onError: OnError = (err) => {
    if (ApiError.isApiError(err) && err.status === 403) setForbidden(true);
  };

  return (
    <Stack gap={6} testId="fe2-lp-publish-screen">
      <PageHeader
        testId="fe2-lp-publish-header"
        title="LP管理"
        description="一般の人が見る本番の LP に、どの版を出すか・チケット販売や登壇者募集を出すかを切り替えます。"
      />
      <LpTabs active="publish" />
      <p className={styles.liveNotice} data-testid="fe2-lp-publish-notice">
        <Icon name="alert-triangle" />
        <span>
          ここでの切り替えは本番の LP（一般公開中のページ）にすぐ反映されます。公開前の見た目は「プレビュー」タブで確かめられます。
        </span>
      </p>
      {readOnly ? (
        <p className={styles.previewNotice} data-testid="fe2-lp-publish-readonly">
          <Icon name="lock" />
          <span>
            閲覧のみです。切り替えるには LP管理 の編集権限と lp:publish 権限が必要です。
          </span>
        </p>
      ) : null}
      <VersionCard readOnly={readOnly} onError={onError} />
      <TicketsCard readOnly={readOnly} onError={onError} />
      <ProposalsCard readOnly={readOnly} onError={onError} />
      <LiveCard />
    </Stack>
  );
}

function SectionError({ testId, message, onRetry }: { testId: string; message: string; onRetry: () => void }): JSX.Element {
  return <ErrorState testId={testId} error={{ code: "INTERNAL", message }} onRetry={onRetry} />;
}

// ── 公開する版 ────────────────────────────────────────────────────────────────

function VersionCard({ readOnly, onError }: { readOnly: boolean; onError: OnError }): JSX.Element {
  const versionsQuery = useQuery({ queryKey: ["lp", "versions"], queryFn: listLpVersions });
  const publishQuery = useLpPublish();
  const setPublish = useSetLpPublish();
  const publish = publishQuery.data;
  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<LpVersion | null>(null);
  const [announce, setAnnounce] = useState("");

  const nameOf = (id: string): string => versionsQuery.data?.find((v) => v.id === id)?.name ?? id;
  // 選べるのは LP Worker に同梱された版（公開フラグの versions）だけ。
  const options = useMemo(
    () =>
      (versionsQuery.data ?? [])
        .filter((v) => publish?.versions.includes(v.id))
        .map((v) => ({ value: v.id, label: `${v.name}${v.id === publish?.versionId ? "（公開中）" : ""}` })),
    [versionsQuery.data, publish],
  );
  const selected = picked ?? publish?.versionId ?? null;
  const target = versionsQuery.data?.find((v) => v.id === selected) ?? null;
  const unchanged = !target || target.id === publish?.versionId;

  const confirm = (): void => {
    if (!confirming) return;
    const next = confirming;
    setConfirming(null);
    setAnnounce("");
    setPublish.mutate(
      { versionId: next.id, name: next.name },
      {
        onSuccess: () => {
          setPicked(null);
          setAnnounce(PUBLISH_SUCCESS_MARKER);
        },
        onError,
      },
    );
  };

  let content: JSX.Element;
  if (versionsQuery.isLoading || publishQuery.isLoading) {
    content = (
      <div role="status" aria-label="公開中の版を読み込み中" data-testid="fe2-lp-publish-version-loading">
        <SkeletonLoader lines={3} />
      </div>
    );
  } else if (versionsQuery.isError || publishQuery.isError || !publish) {
    content = (
      <SectionError
        testId="fe2-lp-publish-version-error"
        message="公開中の版を読み込めませんでした。"
        onRetry={() => {
          void versionsQuery.refetch();
          void publishQuery.refetch();
        }}
      />
    );
  } else {
    content = (
      <Stack gap={5}>
        <div className={styles.statusRow} data-testid="fe2-lp-publish-current">
          <span className={styles.kpiLabel}>いま公開中</span>
          <Badge tone="success" testId="fe2-lp-publish-current-version">
            {nameOf(publish.versionId)}
          </Badge>
          {publish.updatedAt ? (
            <span className={styles.note}>{formatSwitchedAt(publish.updatedAt)} に切り替え</span>
          ) : null}
        </div>
        <div className={styles.publishPicker}>
          <FormField
            label="公開する版"
            htmlFor="fe2-lp-publish-version"
            help="選べるのは本番の LP に入っている版だけです。"
          >
            <Select
              id="fe2-lp-publish-version"
              testId="fe2-lp-publish-version"
              value={selected}
              onChange={setPicked}
              options={options}
              disabled={readOnly || setPublish.isPending}
            />
          </FormField>
          <Button
            variant="primary"
            disabled={readOnly || unchanged || setPublish.isPending}
            onClick={() => target && setConfirming(target)}
            testId="fe2-lp-publish-version-apply"
          >
            この版を公開する
          </Button>
        </div>
      </Stack>
    );
  }

  return (
    <Card testId="fe2-lp-publish-version-card" header={<span className={styles.sectionTitle}>公開する版</span>}>
      {content}
      {confirming && publish ? (
        <PublishConfirmDialog
          site={publish.site}
          currentName={nameOf(publish.versionId)}
          target={confirming}
          onConfirm={confirm}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      {/* 読み上げ用。切り替え完了をスクリーンリーダーにも伝える。 */}
      <span className={styles.srOnly} role="status" aria-live="polite" data-testid="fe2-lp-publish-live">
        {announce}
      </span>
    </Card>
  );
}

/** 版の切り替え前の確認。Modal は body へ portal されるので、ボタンは @dub/ui の variant だけで描く。 */
function PublishConfirmDialog({
  site,
  currentName,
  target,
  onConfirm,
  onCancel,
}: {
  site: string;
  currentName: string;
  target: LpVersion;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Modal
      open
      onClose={onCancel}
      title="公開する版を切り替えます"
      size="sm"
      testId="fe2-lp-publish-dialog"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-3)" }}>
          <Button variant="secondary" onClick={onCancel} testId="fe2-lp-publish-cancel">
            キャンセル
          </Button>
          <Button variant="primary" onClick={onConfirm} testId="fe2-lp-publish-confirm">
            切り替える
          </Button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: "var(--dub-space-4)" }}>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            gap: "var(--dub-space-2) var(--dub-space-4)",
            margin: 0,
          }}
          data-testid="fe2-lp-publish-diff"
        >
          <dt>現在</dt>
          <dd style={{ margin: 0 }}>{currentName}</dd>
          <dt>切り替え後</dt>
          <dd style={{ margin: 0 }}>
            <strong>{target.name}</strong>
          </dd>
        </dl>
        <ul style={{ margin: 0, paddingLeft: "var(--dub-space-5)", display: "grid", gap: "var(--dub-space-2)" }}>
          <li>
            {site} を開いた全員に「{target.name}」が表示されます。
          </li>
          <li>ビルドやデプロイは行いません。反映まで最大 1 分ほどかかります。</li>
          <li>いつでも元の版に戻せます。</li>
        </ul>
      </div>
    </Modal>
  );
}

// ── チケット販売 ──────────────────────────────────────────────────────────────

function TicketsCard({ readOnly, onError }: { readOnly: boolean; onError: OnError }): JSX.Element {
  const tickets = useLpTickets();
  let content: JSX.Element;
  if (tickets.isLoading) {
    content = (
      <div role="status" aria-label="チケット販売の状態を読み込み中" data-testid="fe2-lp-publish-tickets-loading">
        <SkeletonLoader lines={4} />
      </div>
    );
  } else if (tickets.isError || !tickets.data) {
    content = (
      <SectionError
        testId="fe2-lp-publish-tickets-error"
        message="チケット販売の状態を読み込めませんでした。"
        onRetry={() => void tickets.refetch()}
      />
    );
  } else {
    content = <TicketsControls state={tickets.data} readOnly={readOnly} onError={onError} />;
  }
  return (
    <Card testId="fe2-lp-tickets-status" header={<span className={styles.sectionTitle}>チケット販売</span>}>
      {content}
    </Card>
  );
}

function TicketsControls({
  state,
  readOnly,
  onError,
}: {
  state: LpTicketsState;
  readOnly: boolean;
  onError: OnError;
}): JSX.Element {
  const setEnabled = useSetTicketsEnabled();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const openConfirm = (next: boolean): void => {
    setAcknowledged(false);
    setConfirming(next);
  };

  return (
    <Stack gap={5}>
      <div className={styles.statusRow}>
        <Switch
          id="fe2-lp-tickets-enabled"
          testId="fe2-lp-tickets-enabled"
          checked={state.enabled}
          disabled={readOnly || setEnabled.isPending}
          label="チケット販売を公開"
          onChange={openConfirm}
        />
        <Badge tone={state.enabled ? "success" : "neutral"} testId="fe2-lp-tickets-enabled-state">
          {state.enabled ? "公開中" : "停止中"}
        </Badge>
      </div>
      <span className={styles.note}>
        {state.enabled
          ? "LP に「チケットを購入」ボタンと購入ページ（/tickets）が出ています。"
          : "停止中は LP にチケットの表示が出ません。券種や入力項目は「チケット」タブで設定します。"}
      </span>
      {!state.paymentReady ? (
        <span className={styles.note} data-testid="fe2-lp-tickets-payment-note">
          決済（Stripe）が未設定のため、有料のチケットは「準備中」と表示されます（無料のチケットは申し込めます）。
        </span>
      ) : null}
      <CtaSetting state={state} readOnly={readOnly} onError={onError} />
      {confirming !== null ? (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={confirming ? "チケット販売を全員に公開しますか？" : "チケット販売を停止します"}
          size="sm"
          testId="fe2-lp-tickets-enabled-dialog"
          footer={
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-3)" }}>
              <Button variant="secondary" onClick={() => setConfirming(null)} testId="fe2-lp-tickets-enabled-cancel">
                キャンセル
              </Button>
              <Button
                variant={confirming ? "primary" : "danger"}
                disabled={confirming && !acknowledged}
                onClick={() => {
                  const next = confirming;
                  setConfirming(null);
                  setEnabled.mutate({ enabled: next }, { onError });
                }}
                testId="fe2-lp-tickets-enabled-confirm"
              >
                {confirming ? "公開する" : "停止する"}
              </Button>
            </div>
          }
        >
          {confirming ? (
            <p className={styles.publishWarning} role="alert" data-testid="fe2-lp-tickets-enabled-warning">
              {"本当に全ユーザーに公開されますがよろしいですか？公開すると、ログインしていない一般の方を含むインターネット上の誰でも、購入ページを開いて申し込めるようになります。"}
            </p>
          ) : null}
          <ul style={{ margin: 0, paddingLeft: "var(--dub-space-5)", display: "grid", gap: "var(--dub-space-2)" }}>
            {confirming ? (
              <>
                <li>公開すると LP に「チケットを購入」ボタンと /tickets ページが出ます。</li>
                <li>公開前の見た目は「プレビュー」タブで確かめられます。</li>
                {state.ctaEnabled ? <li>LP の「参加登録」ボタンも「参加チケットを購入」に切り替わります。</li> : null}
                {!state.paymentReady ? <li>決済が未設定のため、有料のチケットは「準備中」と表示されます。</li> : null}
              </>
            ) : (
              <>
                <li>停止すると LP から「チケットを購入」ボタンが消え、/tickets ページは表示されなくなります。</li>
                {state.ctaEnabled ? <li>LP の「参加登録」ボタンは元の表示に戻ります。</li> : null}
                <li>これまでの購入記録は消えません。</li>
              </>
            )}
            <li>反映まで最大 1 分ほどかかります。</li>
          </ul>
          {confirming ? (
            <div className={styles.publishAck}>
              <Checkbox
                id="fe2-lp-tickets-enabled-ack"
                testId="fe2-lp-tickets-enabled-ack"
                checked={acknowledged}
                label="全ユーザーに公開されることを理解しました"
                onChange={setAcknowledged}
              />
            </div>
          ) : null}
        </Modal>
      ) : null}
    </Stack>
  );
}

/** 「参加登録」ボタンの差し替え。販売の公開に従属する 2 段目のスイッチ（効くのは販売公開中だけ）。 */
function CtaSetting({ state, readOnly, onError }: { state: LpTicketsState; readOnly: boolean; onError: OnError }): JSX.Element {
  const setCta = useSetTicketsCta();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const badge = ctaBadge(state);

  // 販売が公開中なら LP の見た目がすぐ変わるので確認を挟む。停止中は効果が無いので即保存（予約）。
  const onChange = (next: boolean): void => {
    if (state.enabled) setConfirming(next);
    else setCta.mutate({ enabled: next }, { onError });
  };

  return (
    <div className={styles.ctaSetting} data-testid="fe2-lp-tickets-cta-setting">
      <div className={styles.statusRow}>
        <Switch
          id="fe2-lp-tickets-cta"
          testId="fe2-lp-tickets-cta"
          checked={state.ctaEnabled}
          disabled={readOnly || setCta.isPending}
          label="LP の「参加登録」ボタンを「参加チケットを購入」に切り替える"
          onChange={onChange}
        />
        <Badge tone={badge.tone} testId="fe2-lp-tickets-cta-state">
          {badge.label}
        </Badge>
      </div>
      <span className={styles.note} data-testid="fe2-lp-tickets-cta-hint">
        {state.enabled
          ? "ヘッダー・ヒーロー・参加カード・お問い合わせ欄の「参加登録」ボタンが、購入ページ（/tickets）へのボタンに変わります。"
          : "販売を公開すると有効になります。いまオンにしても、販売を公開するまで LP のボタンは変わりません。"}
      </span>
      {confirming !== null ? (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={confirming ? "参加登録ボタンを切り替えます" : "参加登録ボタンを元に戻します"}
          size="sm"
          testId="fe2-lp-tickets-cta-dialog"
          footer={
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--dub-space-3)" }}>
              <Button variant="secondary" onClick={() => setConfirming(null)} testId="fe2-lp-tickets-cta-cancel">
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const next = confirming;
                  setConfirming(null);
                  setCta.mutate({ enabled: next }, { onError });
                }}
                testId="fe2-lp-tickets-cta-confirm"
              >
                {confirming ? "切り替える" : "元に戻す"}
              </Button>
            </div>
          }
        >
          <ul style={{ margin: 0, paddingLeft: "var(--dub-space-5)", display: "grid", gap: "var(--dub-space-2)" }}>
            {confirming ? (
              <li>LP の「参加登録」ボタンが「参加チケットを購入」になり、押すと購入ページ（/tickets）に移ります。</li>
            ) : (
              <li>LP の「参加登録」ボタンを元の表示に戻します。右下の「チケットを購入」ボタンと購入ページはそのまま残ります。</li>
            )}
            <li>反映まで最大 1 分ほどかかります。</li>
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}

// ── 登壇者募集 ────────────────────────────────────────────────────────────────

function ProposalsCard({ readOnly, onError }: { readOnly: boolean; onError: OnError }): JSX.Element {
  const proposals = useLpProposals();
  let content: JSX.Element;
  if (proposals.isLoading) {
    content = (
      <div role="status" aria-label="登壇者募集の状態を読み込み中" data-testid="fe2-lp-publish-proposals-loading">
        <SkeletonLoader lines={3} />
      </div>
    );
  } else if (proposals.isError || !proposals.data) {
    content = (
      <SectionError
        testId="fe2-lp-publish-proposals-error"
        message="登壇者募集の状態を読み込めませんでした。"
        onRetry={() => void proposals.refetch()}
      />
    );
  } else {
    content = <ProposalsControls state={proposals.data} readOnly={readOnly} onError={onError} />;
  }
  return (
    <Card testId="fe2-lp-proposals-status" header={<span className={styles.sectionTitle}>登壇者募集</span>}>
      {content}
    </Card>
  );
}

function ProposalsControls({
  state,
  readOnly,
  onError,
}: {
  state: LpProposalsState;
  readOnly: boolean;
  onError: OnError;
}): JSX.Element {
  const setEnabled = useSetProposalsEnabled();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const openConfirm = (next: boolean): void => {
    setAcknowledged(false);
    setConfirming(next);
  };

  return (
    <Stack gap={5}>
      <div className={styles.statusRow}>
        <Switch
          id="fe2-lp-proposals-enabled"
          testId="fe2-lp-proposals-enabled"
          checked={state.enabled}
          disabled={readOnly || setEnabled.isPending}
          label="登壇者の募集を公開"
          onChange={openConfirm}
        />
        <Badge tone={state.enabled ? "success" : "neutral"} testId="fe2-lp-proposals-enabled-state">
          {state.enabled ? "募集中" : "停止中"}
        </Badge>
      </div>
      <span className={styles.note}>
        {state.enabled
          ? "LP の「登壇に応募する」ボタンから応募ページ（/proposals）へ進めます。"
          : "停止中は LP の「登壇に応募する」ボタンが「準備中」のまま押せません。入力項目や応募の確認は「登壇者募集」タブで行います。"}
      </span>
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
                  setEnabled.mutate({ enabled: next }, { onError });
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
    </Stack>
  );
}

// ── 今の本番 LP ───────────────────────────────────────────────────────────────

const LIVE_VERSION: LpVersion = {
  id: "live",
  name: "本番の LP（一般の人に見えているページ）",
  description: "",
  url: lpLiveUrl(),
  updatedAt: "",
  status: "current",
};

function LiveCard(): JSX.Element {
  const [reloads, setReloads] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <Card
      testId="fe2-lp-publish-live-card"
      header={
        <div className={styles.cardHeaderRow}>
          <span className={styles.sectionTitle}>今一般の人に見えているページ</span>
          <div className={styles.urlActions}>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Icon name="refresh" />}
              onClick={() => setReloads((n) => n + 1)}
              testId="fe2-lp-publish-live-reload"
            >
              再読み込み
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconRight={<Icon name="external-link" />}
              onClick={() => setFullscreen(true)}
              testId="fe2-lp-publish-live-open"
            >
              全画面で見る
            </Button>
          </div>
        </div>
      }
    >
      <Stack gap={4}>
        <span className={styles.note} data-testid="fe2-lp-publish-live-note">
          プレビューの条件を付けずに、本番の LP をそのまま表示しています。LP 側で設定を最大 {LP_FLAG_CACHE_SECONDS}{" "}
          秒キャッシュしているため、切り替え直後は前の表示のことがあります。少し待ってから「再読み込み」を押してください。
        </span>
        <iframe
          key={reloads}
          src={LIVE_VERSION.url}
          title={LIVE_VERSION.name}
          className={styles.liveFrame}
          loading="lazy"
          data-testid="fe2-lp-publish-live-frame"
        />
      </Stack>
      {fullscreen ? <LpViewer version={LIVE_VERSION} onBack={() => setFullscreen(false)} /> : null}
    </Card>
  );
}
