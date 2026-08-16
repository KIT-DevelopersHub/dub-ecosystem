// Lightweight, dependency-free dashboard visuals (design 2-1 revamp). No chart
// library — just inline SVG + token-driven CSS, so the bundle stays small and the
// marks track the theme. Each is presentational: pass a percentage/status, get a
// gauge. Colors resolve from @dub/tokens via toCssVarName (no ad-hoc hex).
import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import { clampPct, statusMeta, type MetricStatus, type TaskSegment } from "./dashboardData.ts";

/** A donut/ring gauge for a single percentage, with the value shown at its center.
 *  Exposed as an ARIA progressbar. The arc color follows `status`. */
export function Ring({
  pct,
  status,
  size = 68,
  thickness = 8,
  centerLabel,
  ariaLabel,
  testId,
}: {
  pct: number;
  status: MetricStatus;
  size?: number;
  thickness?: number;
  /** Text drawn in the middle (defaults to the rounded percentage). */
  centerLabel?: string;
  ariaLabel?: string;
  testId?: string;
}): JSX.Element {
  const value = clampPct(pct);
  const meta = statusMeta(status);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const dash = (value / 100) * c;
  const center = size / 2;

  return (
    <div
      className="fe2-ring"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${value.toFixed(0)}%`}
      aria-label={ariaLabel}
      data-status={status}
      data-testid={testId}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={toCssVarName("color.border.default")}
          strokeWidth={thickness}
        />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={toCssVarName(meta.colorPath)}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: `stroke-dasharray ${toCssVarName("motion.slow")} ${toCssVarName("motion.easing")}` }}
        />
      </svg>
      <span className="fe2-ring-center" aria-hidden="true">
        {centerLabel ?? `${Math.round(value)}%`}
      </span>
    </div>
  );
}

/** A horizontal meter (progress bar) whose fill color follows `status`. */
export function Meter({
  pct,
  status,
  ariaLabel,
  testId,
}: {
  pct: number;
  status: MetricStatus;
  ariaLabel?: string;
  testId?: string;
}): JSX.Element {
  const value = clampPct(pct);
  const meta = statusMeta(status);
  const fill: CSSProperties = {
    width: `${value}%`,
    background: toCssVarName(meta.colorPath),
  };
  return (
    <div
      className="fe2-meter"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${value.toFixed(1)}%`}
      aria-label={ariaLabel}
      data-status={status}
      data-testid={testId}
    >
      <span className="fe2-meter-fill" style={fill} />
    </div>
  );
}

/** A single stacked bar split proportionally across segments (task breakdown). The
 *  legend below names each color, so meaning never rests on hue alone. */
export function SegmentBar({
  segments,
  testId,
}: {
  segments: TaskSegment[];
  testId?: string;
}): JSX.Element {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  return (
    <div className="fe2-segbar-wrap" data-testid={testId}>
      <div className="fe2-segbar" role="img" aria-label={segments.map((s) => `${s.label} ${s.count}件`).join("、")}>
        {segments.map((s) => {
          const width = total === 0 ? 0 : (s.count / total) * 100;
          return (
            <span
              key={s.key}
              className="fe2-segbar-seg"
              data-testid={`fe2-segbar-${s.key}`}
              style={{ width: `${width}%`, background: toCssVarName(statusMeta(s.status).colorPath) }}
            />
          );
        })}
      </div>
      <ul className="fe2-seglegend">
        {segments.map((s) => (
          <li key={s.key} className="fe2-seglegend-item">
            <span className="fe2-seglegend-dot" style={{ background: toCssVarName(statusMeta(s.status).colorPath) }} aria-hidden="true" />
            <span className="fe2-seglegend-label">{s.label}</span>
            <span className="fe2-seglegend-count">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
