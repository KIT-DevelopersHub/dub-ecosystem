// UsageGauge — a token-driven progress bar whose fill color follows the metric
// status (ok=green / warn=yellow / critical=red / unknown=gray). Reusable: takes
// only pct + status. All colors come from @dub/tokens (no ad-hoc hex); the width is
// the sole dynamic value. Exposed as an ARIA progressbar for a11y.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { clampPct, statusMeta } from "../usageStatus.ts";
import type { UsageStatus } from "../types.ts";

export interface UsageGaugeProps {
  pct: number;
  status: UsageStatus;
  /** ja label used for the accessible name (e.g. the metric label). */
  ariaLabel?: string;
  testId?: string;
}

export function UsageGauge({ pct, status, ariaLabel, testId }: UsageGaugeProps): JSX.Element {
  const width = clampPct(pct);
  const meta = statusMeta(status);
  const unknown = status === "unknown";

  const track: CSSProperties = {
    width: "100%",
    height: toCssVarName("space.2"),
    background: toCssVarName("color.gray.200"),
    borderRadius: toCssVarName("radius.full"),
    overflow: "hidden",
  };
  const fill: CSSProperties = {
    // unknown → a faint full-width bar so the row reads as "no data", not "0%".
    width: unknown ? "100%" : `${width}%`,
    height: "100%",
    background: toCssVarName(meta.colorPath),
    opacity: unknown ? 0.3 : 1,
    borderRadius: toCssVarName("radius.full"),
    transition: `width ${toCssVarName("motion.normal")} ${toCssVarName("motion.easing")}`,
  };

  return (
    <div
      role="progressbar"
      aria-valuenow={unknown ? undefined : Math.round(width)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={unknown ? "取得不可" : `${width.toFixed(1)}%`}
      aria-label={ariaLabel}
      data-testid={testId}
      data-status={status}
      style={track}
    >
      <div style={fill} />
    </div>
  );
}
