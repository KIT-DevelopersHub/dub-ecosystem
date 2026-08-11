// UsageDashboard — the "無料枠 / 課金ガード" screen. Reads GET /usage/summary via
// UsageApi (which falls back to the documented mock when the gateway is absent),
// renders the worst-status banner, a reassurance note about Cloudflare's free plan,
// and a responsive grid of ServiceUsageCards. "今すぐ更新" re-fetches. No optimistic
// UI — a plain refetch is the whole interaction.
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { toCssVarName } from "@dub/tokens";
import { Button, Card, PageHeader, SkeletonLoader, Stack } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useUsageApi } from "./UsageProvider.tsx";
import { UsageSummaryBanner } from "./components/UsageSummaryBanner.tsx";
import { ServiceUsageCard } from "./components/ServiceUsageCard.tsx";

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

const noteStyle: CSSProperties = {
  fontSize: toCssVarName("font.size.sm"),
  color: toCssVarName("color.text.secondary"),
  lineHeight: 1.6,
};
const sampleNoticeStyle: CSSProperties = {
  fontSize: toCssVarName("font.size.sm"),
  color: toCssVarName("color.text.secondary"),
  padding: `${toCssVarName("space.2")} ${toCssVarName("space.3")}`,
  borderRadius: toCssVarName("radius.md"),
  background: toCssVarName("color.warning.100"),
};
// Neutral (not warning-tinted) notice for the "could not read" state. It must not
// borrow an alarm color — the whole point is that we DON'T know the usage, so the
// surface stays calm/gray rather than yellow/red.
const neutralNoticeStyle: CSSProperties = {
  fontSize: toCssVarName("font.size.sm"),
  color: toCssVarName("color.text.secondary"),
  padding: `${toCssVarName("space.2")} ${toCssVarName("space.3")}`,
  borderRadius: toCssVarName("radius.md"),
  background: toCssVarName("color.gray.100"),
};

/** Responsive auto-fit grid (min 260px columns). Kept inline (token-spaced) since
 *  @dub/ui Grid is fixed-column; auto-fit is the right fit for variable card counts. */
const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: toCssVarName("space.4"),
};

export function UsageDashboard(): JSX.Element {
  const usageApi = useUsageApi();
  const query = useQuery({
    queryKey: queryKeys.feature("usage", "summary"),
    queryFn: () => usageApi.getSummary(),
  });

  const refreshAction = (
    <Button
      testId="fe2-usage-refresh"
      variant="secondary"
      onClick={() => void query.refetch()}
      disabled={query.isFetching}
    >
      {query.isFetching ? "更新中…" : "今すぐ更新"}
    </Button>
  );

  // The core reassurance copy — the user's stated goal is "prevent a billing
  // explosion", but the true value is early detection of a *service halt* at the
  // free-tier wall. Say both plainly.
  const reassurance = (
    <Card testId="fe2-usage-reassurance">
      <Stack gap={2}>
        <strong>課金の心配について</strong>
        <p style={noteStyle}>
          Cloudflare の無料プランは上限を超えると<strong>停止（429を返す）</strong>し、
          <strong>勝手に課金されることはありません</strong>。課金が発生するのは、Paid プランへ
          <strong>手動でアップグレードした時だけ</strong>です。
          このダッシュボードの本当の役割は「請求爆発の防止」よりも、
          <strong>無料枠の上限に達して機能が止まる予兆を早く掴むこと</strong>にあります。
        </p>
      </Stack>
    </Card>
  );

  let body: JSX.Element;
  if (query.isPending || !query.data) {
    body = <SkeletonLoader lines={6} />;
  } else {
    const { summary, source, reason } = query.data;
    // The worst-status banner (incl. the red "上限に迫っている" strip) is driven ONLY by
    // real data. On `unavailable` the summary is neutral (worstStatus "unknown"), so
    // the banner is a calm gray "取得できませんでした" — never a false alarm.
    const notice =
      source === "unavailable" ? (
        <div role="note" data-testid="fe2-usage-unavailable-notice" data-reason={reason} style={neutralNoticeStyle}>
          {reason === "forbidden"
            ? "使用状況を表示する権限がありません（管理者にお問い合わせください）。表示中の各項目はサンプルではなく「取得不可」です。"
            : "使用状況を取得できませんでした（取得中、または一時的に利用できません）。表示中の各項目はサンプルではなく「取得不可」です。"}
        </div>
      ) : source === "demo" ? (
        <div role="note" data-testid="fe2-usage-sample-notice" data-source={source} style={sampleNoticeStyle}>
          デモモード — 表示中の使用状況はサンプル値です。
        </div>
      ) : null;

    body = (
      <Stack gap={4}>
        <UsageSummaryBanner worstStatus={summary.worstStatus} />
        {notice}
        {reassurance}
        <div style={gridStyle} data-testid="fe2-usage-grid">
          {summary.services.map((s) => (
            <ServiceUsageCard key={`${s.provider}:${s.metricKey}`} service={s} />
          ))}
        </div>
        <span style={noteStyle} data-testid="fe2-usage-generated-at">
          最終更新: {formatGeneratedAt(summary.generatedAt)}
        </span>
      </Stack>
    );
  }

  return (
    <main data-testid="fe2-usage-dashboard">
      <PageHeader
        title="無料枠 / 課金ガード"
        description="各サービスの無料枠の使用状況と、上限を超えたときの挙動を表示します。"
        actions={refreshAction}
      />
      {body}
    </main>
  );
}
