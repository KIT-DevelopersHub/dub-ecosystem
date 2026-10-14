// LP管理 → チケット。LP の /tickets ページ（チケット購入）の販売状態・券種・入力項目を設定し、
// 売れ行きと購入者を見る。
//
// 設計メモ:
//  - 販売の公開/停止は LP 全体に効くので lp:publish 必須 + 確認ダイアログ（版の公開と同じ扱い）。
//    公開は誰でも見られる状態になるので、「全員に公開される」ことへの同意チェックを押すまで実行できない。
//  - 公開前の見た目は「プレビュー」タブ（版とチケットあり/なしを選んで開く・申し込み不可）で確かめる。
//  - 決済（Stripe）の鍵が未登録でも画面は動く。未設定の間は有料券は買えず、無料券だけ申し込める。
//  - LP の「参加登録」ボタン差し替え（ctaEnabled）は販売公開に従属する 2 段目のスイッチ。
//    効くのは enabled && ctaEnabled のときだけ。販売停止中でも予約として保存はできる。
//  - 購入者一覧は個人情報なので app:lp:edit のときだけ取得・表示する（閲覧者には出さない）。
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
  SkeletonLoader,
  Stack,
  Switch,
} from "@dub/ui";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import type { LpTicketOrder, LpTicketsState } from "./lpApi.tsx";
import { useLpTicketOrders, useLpTickets, useSetTicketsCta, useSetTicketsEnabled } from "./lpTicketsHooks.ts";
import { ORDER_STATUS, formatDateTime, formatPrice, formatYen, orderItemLabel } from "./lpTickets.ts";
import { LpTicketTypesCard } from "./LpTicketTypes.tsx";
import { LpTicketFieldsCard } from "./LpTicketFields.tsx";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

export function LpTicketsScreen(): JSX.Element {
  const tickets = useLpTickets();
  const { canEdit } = useAppCapability("lp");
  const { can } = usePermissions();
  const canToggle = canEdit && can("lp:publish");

  let body: JSX.Element;
  if (tickets.isLoading) {
    body = (
      <Stack gap={6} testId="fe2-lp-tickets-loading">
        {["status", "summary", "types", "fields"].map((k) => (
          <Card key={k} testId={`fe2-lp-tickets-loading-${k}`}>
            <SkeletonLoader lines={k === "summary" ? 2 : 4} />
          </Card>
        ))}
      </Stack>
    );
  } else if (tickets.isError || !tickets.data) {
    body = (
      <ErrorState
        testId="fe2-lp-tickets-error"
        error={{ code: "INTERNAL", message: "チケット販売の設定を読み込めませんでした。" }}
        onRetry={() => void tickets.refetch()}
      />
    );
  } else {
    const state = tickets.data;
    body = (
      <Stack gap={6}>
        <SalesStatusCard state={state} canToggle={canToggle} />
        <div className={styles.kpiGrid}>
          <SummaryTile testId="fe2-lp-tickets-sold" label="販売数" value={`${state.totals.sold.toLocaleString("ja-JP")} 枚`} hint="支払い済みの枚数（無料券を含む・1 回で複数枚の購入あり）" />
          <SummaryTile testId="fe2-lp-tickets-revenue" label="売上" value={formatYen(state.totals.revenueJpy)} hint="支払い済みの合計（税込）" />
        </div>
        <LpTicketTypesCard types={state.types} canEdit={canEdit} />
        <LpTicketFieldsCard fields={state.fields} canEdit={canEdit} />
        {canEdit ? <OrdersCard /> : null}
      </Stack>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-tickets-screen">
      <PageHeader
        testId="fe2-lp-tickets-header"
        title="LP管理"
        description="LP のチケット購入ページの販売状態・券種・入力項目を設定し、売れ行きと購入者を確認します。"
      />
      <LpTabs active="tickets" />
      {body}
    </Stack>
  );
}

function SummaryTile({ testId, label, value, hint }: { testId: string; label: string; value: string; hint: string }): JSX.Element {
  return (
    <Card testId={testId}>
      <Stack gap={1}>
        <span className={styles.kpiLabel}>{label}</span>
        <span className={styles.kpiValue}>{value}</span>
        <span className={styles.kpiHint}>{hint}</span>
      </Stack>
    </Card>
  );
}

function SalesStatusCard({ state, canToggle }: { state: LpTicketsState; canToggle: boolean }): JSX.Element {
  const setEnabled = useSetTicketsEnabled();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const openConfirm = (next: boolean): void => {
    setAcknowledged(false);
    setConfirming(next);
  };

  return (
    <Card testId="fe2-lp-tickets-status" header={<span className={styles.sectionTitle}>チケット販売</span>}>
      <Stack gap={5}>
        <div className={styles.statusRow}>
          <Switch
            id="fe2-lp-tickets-enabled"
            testId="fe2-lp-tickets-enabled"
            checked={state.enabled}
            disabled={!canToggle || setEnabled.isPending}
            label="チケット販売を公開"
            onChange={openConfirm}
          />
          <Badge tone={state.enabled ? "success" : "neutral"} testId="fe2-lp-tickets-enabled-state">
            {state.enabled ? "公開中" : "停止中"}
          </Badge>
        </div>
        {!canToggle ? (
          <span className={styles.note} data-testid="fe2-lp-tickets-enabled-hint">
            切り替えには lp:publish 権限が必要です
          </span>
        ) : null}
        <CtaSetting state={state} canToggle={canToggle} />
        <div className={styles.statusRow}>
          <span className={styles.kpiLabel}>購入ページ</span>
          <a
            className={styles.urlOpen}
            href={state.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="fe2-lp-tickets-public-url"
          >
            {state.publicUrl}
          </a>
          <Icon name="external-link" />
        </div>
        <div className={styles.statusRow}>
          <span className={styles.kpiLabel}>決済</span>
          <Badge tone={state.paymentReady ? "success" : "warning"} testId="fe2-lp-tickets-payment">
            {state.paymentReady ? "Stripe 接続済み" : "決済 未設定"}
          </Badge>
          {!state.paymentReady ? (
            <span className={styles.note}>
              Stripe の鍵を登録するまで有料のチケットは購入できません（無料のチケットは申し込めます）。
            </span>
          ) : null}
        </div>
      </Stack>
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
                  setEnabled.mutate({ enabled: next });
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
    </Card>
  );
}

function CtaSetting({ state, canToggle }: { state: LpTicketsState; canToggle: boolean }): JSX.Element {
  const setCta = useSetTicketsCta();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const effective = state.enabled && state.ctaEnabled;
  const badge = effective
    ? { tone: "success" as const, label: "LP に反映中" }
    : state.ctaEnabled
      ? { tone: "warning" as const, label: "販売の公開待ち" }
      : { tone: "neutral" as const, label: "元の表示" };

  // 販売が公開中なら LP の見た目がすぐ変わるので確認を挟む。停止中は効果が無いので即保存。
  const onChange = (next: boolean): void => {
    if (state.enabled) setConfirming(next);
    else setCta.mutate({ enabled: next });
  };

  return (
    <div className={styles.ctaSetting} data-testid="fe2-lp-tickets-cta-setting">
      <div className={styles.statusRow}>
        <Switch
          id="fe2-lp-tickets-cta"
          testId="fe2-lp-tickets-cta"
          checked={state.ctaEnabled}
          disabled={!canToggle || setCta.isPending}
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
                  setCta.mutate({ enabled: next });
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

function OrdersCard(): JSX.Element {
  const orders = useLpTicketOrders(true);
  const rows = useMemo(() => orders.data?.pages.flatMap((p) => p.items) ?? [], [orders.data]);

  let content: JSX.Element;
  if (orders.isLoading) {
    content = <SkeletonLoader lines={5} />;
  } else if (orders.isError) {
    content = (
      <ErrorState
        testId="fe2-lp-ticket-orders-error"
        error={{ code: "INTERNAL", message: "購入者を読み込めませんでした。" }}
        onRetry={() => void orders.refetch()}
      />
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        testId="fe2-lp-ticket-orders-empty"
        icon="users"
        title="まだ購入者はいません"
        description="購入ページから申し込みがあると、新しい順にここへ並びます。"
      />
    );
  } else {
    content = (
      <Stack gap={5}>
        <div className={styles.orderList} data-testid="fe2-lp-ticket-orders-list">
          {rows.map((o) => (
            <OrderRow key={o.id} order={o} />
          ))}
        </div>
        <LoadMore
          testId="fe2-lp-ticket-orders-more"
          hasMore={orders.hasNextPage}
          loading={orders.isFetchingNextPage}
          onLoadMore={() => void orders.fetchNextPage()}
        />
      </Stack>
    );
  }

  return (
    <Card testId="fe2-lp-ticket-orders" header={<span className={styles.sectionTitle}>購入者</span>}>
      {content}
    </Card>
  );
}

function OrderRow({ order: o }: { order: LpTicketOrder }): JSX.Element {
  const [open, setOpen] = useState(false);
  const status = ORDER_STATUS[o.status];
  return (
    <div className={styles.orderRow} data-testid={`fe2-lp-ticket-order-${o.id}`}>
      <div className={styles.orderLine}>
        <strong className={styles.linkName}>{o.buyerName}</strong>
        <span className={styles.orderEmail}>{o.buyerEmail}</span>
        <ul className={styles.orderItems} data-testid={`fe2-lp-ticket-order-items-${o.id}`}>
          {o.items.map((it) => (
            <li key={it.ticketTypeId}>
              <span>{orderItemLabel(it)}</span>
              <span className={styles.num}>× {it.quantity}</span>
            </li>
          ))}
        </ul>
        <span className={styles.orderTotal} data-testid={`fe2-lp-ticket-order-total-${o.id}`}>
          <span className={styles.num}>{formatPrice(o.amountJpy)}</span>
          <small className={styles.kpiHint}>計 {o.quantity.toLocaleString("ja-JP")} 枚</small>
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <small className={styles.versionDate}>{formatDateTime(o.createdAt)}</small>
        <Button
          variant="ghost"
          size="sm"
          iconRight={<Icon name={open ? "chevron-down" : "chevron-right"} />}
          onClick={() => setOpen((v) => !v)}
          testId={`fe2-lp-ticket-order-details-${o.id}`}
        >
          詳細
        </Button>
      </div>
      {open ? (
        <dl className={styles.orderAnswers} data-testid={`fe2-lp-ticket-order-answers-${o.id}`}>
          {o.items.map((it) => (
            <div key={`item-${it.ticketTypeId}`} className={styles.orderAnswer}>
              <dt>{orderItemLabel(it)}</dt>
              <dd className={styles.num}>
                {formatPrice(it.unitPriceJpy)} × {it.quantity} 枚 = {formatYen(it.unitPriceJpy * it.quantity)}
              </dd>
            </div>
          ))}
          {o.answers.length === 0 ? (
            <dd>追加の回答はありません。</dd>
          ) : (
            o.answers.map((a) => (
              <div key={a.fieldId} className={styles.orderAnswer}>
                <dt>{a.label}</dt>
                <dd>{a.value || "（未回答）"}</dd>
              </div>
            ))
          )}
        </dl>
      ) : null}
    </div>
  );
}
