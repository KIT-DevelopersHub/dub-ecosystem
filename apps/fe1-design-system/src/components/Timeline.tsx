// Timeline / Gantt — the data-viz primitive @dub/ui was missing. Renders a
// row-label column + a scrollable canvas of bars (CSS grid + absolute boxes) with
// SVG dependency links, from a data-agnostic numeric-ms row model. Replaces the
// raw-SVG Gantt FE4 hand-rolled. Geometry lives in utils/timeline-geometry (pure,
// exported, unit-tested); this file is presentation + interaction only.
import type { TimelineProps, TimelineScale } from "../types";
import styles from "./Timeline.module.css";
import { cx } from "../utils/cx";
import {
  computeTimelineBounds,
  timelineBars,
  timelineDependencySegments,
  timelineTicks,
} from "../utils/timeline-geometry";

const SCALES: TimelineScale[] = ["day", "week", "month"];
const DEFAULT_ROW_HEIGHT = 28;

export function Timeline({
  rows,
  dependencies = [],
  scale = "week",
  onScaleChange,
  rowHeight = DEFAULT_ROW_HEIGHT,
  minBarWidth,
  truncated,
  truncatedLabel,
  onRowClick,
  selectedRowId,
  emptyState,
  testId,
}: TimelineProps) {
  const bounds = computeTimelineBounds(rows);
  const bars = bounds ? timelineBars(rows, bounds, { scale, rowHeight, minBarWidth }) : [];
  const segments = bounds ? timelineDependencySegments(dependencies, bars, rowHeight) : [];
  const ticks = bounds ? timelineTicks(bounds, scale) : [];
  const canvasWidth = ticks.length ? ticks[ticks.length - 1]!.x + 80 : 400;
  const canvasHeight = Math.max(rows.length * rowHeight, rowHeight);

  return (
    <div className={cx(styles.root)} data-testid={testId}>
      {onScaleChange && (
        <div className={cx(styles.toolbar)} role="group" aria-label="表示スケール">
          {SCALES.map((s) => (
            <button
              key={s}
              type="button"
              className={cx(styles.chip, s === scale && styles.chipActive)}
              aria-pressed={s === scale}
              onClick={() => onScaleChange(s)}
              data-testid={testId ? `${testId}-scale-${s}` : undefined}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {truncated && (
        <div className={cx(styles.banner)} role="status" data-testid={testId ? `${testId}-truncated` : undefined}>
          {truncatedLabel ?? "表示上限に達しました。フィルタで絞り込んでください。"}
        </div>
      )}

      {bounds === null ? (
        <div className={cx(styles.empty)}>{emptyState ?? "表示できる期間がありません。"}</div>
      ) : (
        <div className={cx(styles.grid)}>
          <div className={cx(styles.labels)} style={{ paddingTop: 0 }}>
            {rows.map((r, i) => (
              <div
                key={r.id}
                className={cx(styles.rowLabel, r.id === selectedRowId && styles.rowLabelActive, onRowClick && styles.clickable)}
                style={{ height: rowHeight }}
                onClick={onRowClick ? () => onRowClick(r.id) : undefined}
                data-testid={testId ? `${testId}-row-${r.id}` : undefined}
                data-selected={r.id === selectedRowId ? "true" : undefined}
              >
                <span className={cx(styles.rowLabelText)}>{r.label}</span>
              </div>
            ))}
          </div>

          <div className={cx(styles.canvasScroll)}>
            <div className={cx(styles.canvas)} style={{ width: canvasWidth, height: canvasHeight }}>
              {ticks.map((t) => (
                <div key={t.ms} className={cx(styles.tick)} style={{ left: t.x }}>
                  <span className={cx(styles.tickLabel)}>{t.label}</span>
                </div>
              ))}

              <svg
                className={cx(styles.deps)}
                width={canvasWidth}
                height={canvasHeight}
                aria-hidden="true"
              >
                {segments.map((s) => (
                  <line
                    key={s.id}
                    x1={s.x1}
                    y1={s.y1}
                    x2={s.x2}
                    y2={s.y2}
                    className={cx(s.violated ? styles.depViolated : styles.depNormal)}
                    data-testid={testId ? `${testId}-dep-${s.id}` : undefined}
                    data-violated={s.violated ? "true" : "false"}
                  />
                ))}
              </svg>

              {bars.map((b) =>
                b.hasBar ? (
                  <div
                    key={b.id}
                    className={cx(styles.bar, b.id === selectedRowId && styles.barActive, onRowClick && styles.clickable)}
                    style={{ left: b.x, top: b.y + 4, width: b.width, height: rowHeight - 8 }}
                    onClick={onRowClick ? () => onRowClick(b.id) : undefined}
                    data-testid={testId ? `${testId}-bar-${b.id}` : undefined}
                    aria-label={`進捗 ${b.progressPercent}%`}
                  >
                    <div className={cx(styles.barProgress)} style={{ width: `${b.progressPercent}%` }} />
                  </div>
                ) : null,
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
