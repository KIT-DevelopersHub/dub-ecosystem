// UsageGauge — the metric's visual focus: a tall token-driven progress bar whose
// fill color follows status (ok=green / warn=yellow / critical=red / unknown=gray),
// with thin markers at the 70% (warn) and 90% (critical) billing/halt thresholds so
// the reader can see how close the fill is to the wall. Reusable: takes only pct +
// status. All colors come from @dub/tokens (no ad-hoc hex); width is the sole dynamic
// value. Exposed as an ARIA progressbar for a11y.
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { CRITICAL_PCT, WARN_PCT, clampPct, statusMeta } from "../usageStatus.ts";
import type { UsageStatus } from "../types.ts";

export interface UsageGaugeProps {
  pct: number;
  status: UsageStatus;
  /** ja label used for the accessible name (e.g. the metric label). */
  ariaLabel?: string;
  /** Hide the 70/90 threshold markers (e.g. when unknown). Default false. */
  hideThresholds?: boolean;
  testId?: string;
}

const track: CSSProperties = {
  position: "relative",
  width: "100%",
  height: toCssVarName("space.3"),
  background: toCssVarName("color.gray.200"),
  borderRadius: toCssVarName("radius.full"),
  overflow: "hidden",
};

/** A thin vertical tick marking a threshold on the track. */
function marker(left: number): CSSProperties {
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: `${left}%`,
    width: "2px",
    marginLeft: "-1px",
    background: toCssVarName("color.surface.base"),
    opacity: 0.85,
  };
}

export function UsageGauge({ pct, status, ariaLabel, hideThresholds, testId }: UsageGaugeProps): JSX.Element {
  const width = clampPct(pct);
  const meta = statusMeta(status);
  const unknown = status === "unknown";

  const fill: CSSProperties = {
    // unknown → a faint full-width bar so the row reads as "no data", not "0%".
    width: unknown ? "100%" : `${width}%`,
    height: "100%",
    background: toCssVarName(meta.colorPath),
    opacity: unknown ? 0.25 : 1,
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
      {!unknown && !hideThresholds && (
        <>
          <div style={marker(WARN_PCT)} data-testid={testId ? `${testId}-warn-mark` : undefined} aria-hidden="true" />
          <div style={marker(CRITICAL_PCT)} data-testid={testId ? `${testId}-critical-mark` : undefined} aria-hidden="true" />
        </>
      )}
    </div>
  );
}
