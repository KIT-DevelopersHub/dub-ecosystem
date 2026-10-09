// 日別アクセスの推移（PV と 訪問 の折れ線）。チャートライブラリは足さず inline SVG で描く。
// - 2 系列とも「回数」で単位が同じなので y 軸は 1 本（二重軸にしない）。
// - 色だけに頼らない: 凡例は常に出し、ホバー/キーボードのツールチップで日ごとの値を読める。
//   正確な数字は下の日別表が持つ（この図は「増減の形」を見るためのもの）。
// - 幅はコンテナに合わせて実測する（viewBox 伸縮だと線や文字が歪むため）。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { formatCount, formatDayLabel } from "./lpRange.ts";
import styles from "./lp.module.css";

export interface TrafficPoint {
  date: string;
  pageViews: number;
  visits: number;
}

const HEIGHT = 220;
const PAD = { top: 12, right: 16, bottom: 28, left: 44 };
/** jsdom 等で幅が測れない時の既定幅。 */
const FALLBACK_WIDTH = 640;
/** x 軸ラベルの最大本数と、1 本あたりに確保する幅（狭い画面で重ならないように）。 */
const MAX_X_LABELS = 7;
const X_LABEL_SLOT = 64;

/** 0 始まりの見やすい目盛り上限と刻み（1/2/5 × 10^n）。 */
export function niceScale(max: number, ticks = 5): { top: number; step: number } {
  if (max <= 0) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: step * Math.ceil(max / step), step: Math.max(1, step) };
}

function useWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function TrafficLineChart({
  points,
  testId = "fe2-lp-site-chart",
}: {
  /** 古い日 → 新しい日の順。 */
  points: TrafficPoint[];
  testId?: string;
}): JSX.Element {
  const [wrapRef, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    const innerW = Math.max(1, width - PAD.left - PAD.right);
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const max = points.reduce((m, p) => Math.max(m, p.pageViews, p.visits), 0);
    const { top, step } = niceScale(max);
    const x = (i: number) => PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
    const line = (pick: (p: TrafficPoint) => number) =>
      points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join("");
    const pvLine = line((p) => p.pageViews);
    const baseY = y(0);
    const pvArea =
      points.length > 1 ? `${pvLine}L${x(points.length - 1).toFixed(1)},${baseY}L${x(0).toFixed(1)},${baseY}Z` : "";
    const yTicks: number[] = [];
    for (let v = 0; v <= top; v += step) yTicks.push(v);
    const maxLabels = Math.max(2, Math.min(MAX_X_LABELS, Math.floor(innerW / X_LABEL_SLOT)));
    const every = Math.max(1, Math.ceil(points.length / maxLabels));
    const xLabels = points
      .map((p, i) => ({ i, label: formatDayLabel(p.date) }))
      .filter(({ i }) => (points.length - 1 - i) % every === 0);
    return { innerW, x, y, pvLine, visitsLine: line((p) => p.visits), pvArea, yTicks, xLabels, baseY };
  }, [points, width]);

  const indexAt = (clientX: number, rect: DOMRect): number => {
    if (points.length <= 1) return 0;
    const ratio = (clientX - rect.left - PAD.left) / geo.innerW;
    return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
  };

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (svg) setActive(indexAt(e.clientX, svg.getBoundingClientRect()));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setActive((cur) => Math.min(points.length - 1, Math.max(0, (cur ?? points.length - 1) + d)));
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  const total = points.reduce((s, p) => s + p.pageViews, 0);
  const first = points[0];
  const last = points[points.length - 1];
  const summary =
    first && last
      ? `${formatDayLabel(first.date)}から${formatDayLabel(last.date)}までの日別アクセスの折れ線グラフ。期間合計 ${formatCount(total)} PV。`
      : "日別アクセスの折れ線グラフ";
  const cur = active !== null ? points[active] : undefined;
  const tipLeft = active !== null ? geo.x(active) : 0;

  return (
    <div className={styles.chart} data-testid={testId}>
      <div className={styles.chartLegend}>
        <span className={styles.legendItem}>
          <span className={`${styles.legendKey} ${styles.keyPv}`} aria-hidden="true" />
          PV
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendKey} ${styles.keyVisits}`} aria-hidden="true" />
          訪問
        </span>
      </div>
      <div
        ref={wrapRef}
        className={styles.chartPlot}
        role="img"
        aria-label={summary}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={HEIGHT} aria-hidden="true">
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line className={styles.grid} x1={PAD.left} x2={width - PAD.right} y1={geo.y(v)} y2={geo.y(v)} />
              <text className={styles.axisText} x={PAD.left - 8} y={geo.y(v)} textAnchor="end" dominantBaseline="middle">
                {formatCount(v)}
              </text>
            </g>
          ))}
          {geo.xLabels.map(({ i, label }) => (
            <text
              key={i}
              className={styles.axisText}
              x={geo.x(i)}
              y={HEIGHT - 8}
              // 右端のラベルは内側に寄せる（狭い幅で切れるため）。
              textAnchor={points.length > 1 && i === points.length - 1 ? "end" : "middle"}
            >
              {label}
            </text>
          ))}
          {geo.pvArea && <path className={styles.areaPv} d={geo.pvArea} />}
          <path className={`${styles.line} ${styles.linePv}`} d={geo.pvLine} data-testid={`${testId}-pv`} />
          <path className={`${styles.line} ${styles.lineVisits}`} d={geo.visitsLine} data-testid={`${testId}-visits`} />
          {points.length === 1 && first && (
            <>
              <circle className={styles.dotPv} cx={geo.x(0)} cy={geo.y(first.pageViews)} r={4} />
              <circle className={styles.dotVisits} cx={geo.x(0)} cy={geo.y(first.visits)} r={4} />
            </>
          )}
          {cur && active !== null && (
            <g data-testid={`${testId}-crosshair`}>
              <line className={styles.crosshair} x1={tipLeft} x2={tipLeft} y1={PAD.top} y2={geo.baseY} />
              <circle className={styles.dotPv} cx={tipLeft} cy={geo.y(cur.pageViews)} r={4} />
              <circle className={styles.dotVisits} cx={tipLeft} cy={geo.y(cur.visits)} r={4} />
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={geo.innerW}
            height={HEIGHT - PAD.top - PAD.bottom}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {cur && (
          <div
            className={styles.tooltip}
            data-testid={`${testId}-tooltip`}
            style={{
              left: tipLeft,
              transform: tipLeft > width / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            }}
          >
            <span className={styles.tooltipDate}>{formatDayLabel(cur.date)}</span>
            <span className={styles.tooltipRow}>
              <span className={`${styles.legendKey} ${styles.keyPv}`} aria-hidden="true" />
              <strong className={styles.num}>{formatCount(cur.pageViews)}</strong> PV
            </span>
            <span className={styles.tooltipRow}>
              <span className={`${styles.legendKey} ${styles.keyVisits}`} aria-hidden="true" />
              <strong className={styles.num}>{formatCount(cur.visits)}</strong> 訪問
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
