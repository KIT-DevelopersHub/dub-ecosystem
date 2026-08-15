// UsageSummaryBanner — the page-top roll-up. A tinted strip (token colors) driven by
// worstStatus: calm green reassurance when all-ok, a prominent alert naming the
// warn/critical metrics otherwise. A second line rolls up the billing guard: when
// nothing can bill it reassures "全項目 自動停止＝予期せぬ請求なし"; otherwise it names
// the metrics that can incur charges. Reusable: takes worstStatus + the service list.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { Icon } from "@dub/ui";
import { alertingMetrics, billingGuardSummary, statusMeta, worstStatusBanner } from "../usageStatus.ts";
import type { ServiceUsage, UsageStatus } from "../types.ts";

export interface UsageSummaryBannerProps {
  worstStatus: UsageStatus;
  /** Services drive the metric list + billing-guard line. Omit to show the strip only. */
  services?: ServiceUsage[];
  testId?: string;
}

const headline: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: toCssVarName("space.2"),
  fontWeight: toCssVarName("font.weight.bold"),
  fontSize: toCssVarName("font.size.lg"),
  color: toCssVarName("color.text.primary"),
};
const detail: CSSProperties = {
  fontSize: toCssVarName("font.size.sm"),
  color: toCssVarName("color.text.secondary"),
  lineHeight: 1.6,
};

export function UsageSummaryBanner({ worstStatus, services, testId }: UsageSummaryBannerProps): JSX.Element {
  const banner = worstStatusBanner(worstStatus);
  const meta = statusMeta(worstStatus);

  const style: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: toCssVarName("space.2"),
    padding: `${toCssVarName("space.4")} ${toCssVarName("space.5")}`,
    borderRadius: toCssVarName("radius.lg"),
    background: toCssVarName(meta.softColorPath),
    borderLeft: `${toCssVarName("space.2")} solid ${toCssVarName(meta.colorPath)}`,
  };

  // The named-metrics line (warn/critical only). Skipped when unknown / all-ok.
  let metricsLine: string | null = null;
  if (services && (worstStatus === "warn" || worstStatus === "critical")) {
    const { critical, warn } = alertingMetrics(services);
    const parts: string[] = [];
    if (critical.length > 0) parts.push(`危険 ${critical.length}件: ${critical.join("、")}`);
    if (warn.length > 0) parts.push(`警告 ${warn.length}件: ${warn.join("、")}`);
    metricsLine = parts.join(" / ") || null;
  }

  // The billing-guard reassurance line. Only meaningful when we actually have data
  // (never during the neutral "取得できませんでした" state).
  let billingLine: string | null = null;
  if (services && worstStatus !== "unknown") {
    const guard = billingGuardSummary(services);
    billingLine = guard.allHalt
      ? `全 ${guard.total} 項目が上限で自動停止します — 予期せぬ請求は発生しません。`
      : `${guard.billCount} 件は上限超で課金が発生します: ${guard.billMetrics.join("、")}`;
  }

  return (
    <div role="status" data-testid={testId ?? "fe2-usage-summary-banner"} data-status={worstStatus} style={style}>
      <span style={headline}>
        <Icon name={banner.icon} aria-hidden="true" />
        {banner.text}
      </span>
      {metricsLine && (
        <span style={detail} data-testid="fe2-usage-summary-metrics">
          {metricsLine}
        </span>
      )}
      {billingLine && (
        <span style={detail} data-testid="fe2-usage-summary-billing">
          {billingLine}
        </span>
      )}
    </div>
  );
}
