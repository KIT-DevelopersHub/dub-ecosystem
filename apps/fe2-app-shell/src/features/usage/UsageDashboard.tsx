// UsageDashboard — the "無料枠 / 課金ガード" screen. Reads GET /usage/summary via
// UsageApi (which falls back to a NEUTRAL summary when the gateway is absent), then
// renders: a worst-status summary banner (with the billing-guard reassurance line), a
// short reassurance card, and the metrics GROUPED by provider (Cloudflare / Resend /
// [future GCP]) with worst-status-first ordering inside each group. "今すぐ更新"
// re-fetches. No optimistic UI — a plain refetch is the whole interaction.
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { toCssVarName } from "@dub/tokens";
import { Button, Card, Icon, PageHeader, SkeletonLoader, Stack } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { useUsageApi } from "./UsageProvider.tsx";
import { UsageSummaryBanner } from "./components/UsageSummaryBanner.tsx";
import { ServiceGroup } from "./components/ServiceGroup.tsx";
import { groupServicesByProvider } from "./usageStatus.ts";

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
// surface stays calm/gray rather than yellow/red, and it is clearly NOT real 0% data.
const neutralNoticeStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: toCssVarName("space.2"),
  fontSize: toCssVarName("font.size.sm"),
  color: toCssVarName("color.text.secondary"),
  padding: `${toCssVarName("space.3")} ${toCssVarName("space.4")}`,
  borderRadius: toCssVarName("radius.md"),
  background: toCssVarName("color.gray.100"),
  border: `1px dashed ${toCssVarName("color.border.strong")}`,
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
          <Icon name="info" size="sm" aria-hidden="true" />
          <span>
            {reason === "forbidden"
              ? "使用状況を表示する権限がありません（管理者にお問い合わせください）。表示中の各項目はサンプルでも 0% でもなく「取得不可」です。"
              : "使用状況を取得できませんでした（取得中、または一時的に利用できません）。表示中の各項目はサンプルでも 0% でもなく「取得不可」です。"}
          </span>
        </div>
      ) : source === "demo" ? (
        <div role="note" data-testid="fe2-usage-sample-notice" data-source={source} style={sampleNoticeStyle}>
          デモモード — 表示中の使用状況はサンプル値です。
        </div>
      ) : null;

    const groups = groupServicesByProvider(summary.services);

    body = (
      <Stack gap={5}>
        <UsageSummaryBanner worstStatus={summary.worstStatus} services={summary.services} />
        {notice}
        {reassurance}
        <Stack gap={6} testId="fe2-usage-groups">
          {groups.map((g) => (
            <ServiceGroup key={g.provider} group={g} />
          ))}
        </Stack>
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
        description="各サービスの無料枠の使用状況と、上限を超えたときの挙動（自動停止か課金か）を表示します。"
        actions={refreshAction}
      />
      {body}
    </main>
  );
}
