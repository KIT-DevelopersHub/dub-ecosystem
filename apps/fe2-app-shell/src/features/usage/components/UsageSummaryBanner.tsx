// UsageSummaryBanner — the page-top roll-up derived from worstStatus. A tinted
// strip (token colors) + the worst-status message, e.g. "⚠ 一部が警告値です" /
// "✓ すべて余裕あり". Reusable: takes only the worstStatus value.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { statusMeta, worstStatusBanner } from "../usageStatus.ts";
import type { UsageStatus } from "../types.ts";

export interface UsageSummaryBannerProps {
  worstStatus: UsageStatus;
  testId?: string;
}

export function UsageSummaryBanner({ worstStatus, testId }: UsageSummaryBannerProps): JSX.Element {
  const banner = worstStatusBanner(worstStatus);
  const meta = statusMeta(worstStatus);

  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: toCssVarName("space.2"),
    padding: `${toCssVarName("space.3")} ${toCssVarName("space.4")}`,
    borderRadius: toCssVarName("radius.md"),
    background: toCssVarName(meta.softColorPath),
    borderLeft: `${toCssVarName("space.1")} solid ${toCssVarName(meta.colorPath)}`,
    color: toCssVarName("color.text.primary"),
    fontWeight: 500,
  };

  return (
    <div role="status" data-testid={testId ?? "fe2-usage-summary-banner"} data-status={worstStatus} style={style}>
      {banner.text}
    </div>
  );
}
