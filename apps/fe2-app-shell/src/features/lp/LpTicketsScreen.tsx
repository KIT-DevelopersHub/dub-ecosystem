// LP管理 → チケット。LP の /tickets ページ（チケット購入）の販売状態・券種・入力項目を設定し、
// 売れ行きと購入者を見る。
//
// 設計メモ:
//  - 販売の公開/停止と「参加登録」ボタン差し替え（ctaEnabled）は本番の LP に効くので、スイッチは
//    「本番公開」タブ（LpPublishScreen）に集約した。ここは状態バッジとそのタブへの導線だけを出す。
//  - 公開前の見た目は「プレビュー」タブ（版とチケットあり/なしを選んで開く・申し込み不可）で確かめる。
//  - 決済（Stripe）の鍵が未登録でも画面は動く。未設定の間は有料券は買えず、無料券だけ申し込める。
//  - 購入者一覧は個人情報なので app:lp:edit のときだけ取得・表示する（閲覧者には出さない）。
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
  SkeletonLoader,
  Stack,
} from "@dub/ui";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import type { LpTicketOrder, LpTicketsState } from "./lpApi.tsx";
import { useLpTicketOrders, useLpTickets } from "./lpTicketsHooks.ts";
import { ORDER_STATUS, ctaBadge, formatDateTime, formatPrice, formatYen, orderItemLabel } from "./lpTickets.ts";
import { LpTicketTypesCard } from "./LpTicketTypes.tsx";
import { LpTicketFieldsCard } from "./LpTicketFields.tsx";
import { GotoPublishButton, LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

export function LpTicketsScreen(): JSX.Element {
  const tickets = useLpTickets();
  const { canEdit } = useAppCapability("lp");

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
        <SalesStatusCard state={state} />
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

function SalesStatusCard({ state }: { state: LpTicketsState }): JSX.Element {
  const cta = ctaBadge(state);
  return (
    <Card testId="fe2-lp-tickets-status" header={<span className={styles.sectionTitle}>チケット販売</span>}>
      <Stack gap={5}>
        <div className={styles.gotoPublish}>
          <span className={styles.kpiLabel}>販売</span>
          <Badge tone={state.enabled ? "success" : "neutral"} testId="fe2-lp-tickets-enabled-state">
            {state.enabled ? "公開中" : "停止中"}
          </Badge>
          <span className={styles.kpiLabel}>参加登録ボタン</span>
          <Badge tone={cta.tone} testId="fe2-lp-tickets-cta-state">
            {cta.label}
          </Badge>
          <GotoPublishButton testId="fe2-lp-tickets-goto-publish" />
        </div>
        <span className={styles.note} data-testid="fe2-lp-tickets-enabled-hint">
          販売の公開・停止と、LP の「参加登録」ボタンの切り替えは「本番公開」タブで行います。
        </span>
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
    </Card>
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
