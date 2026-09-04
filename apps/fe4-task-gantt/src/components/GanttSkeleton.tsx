// Loading skeleton for the ガントチャート workspace body (FE1 §5 loading principle:
// 読み込み中は必ずスケルトンを出し、空=データ0件と区別できるようにする).
//
// WHY this file exists / the bug it fixes:
//   The workspace used to render NOTHING where <GanttView> goes until the gantt DTO
//   arrived — the chart popped in below the (always-mounted) page header + toolbar,
//   so the layout jumped as data loaded ("スケルトンがずれてる"). This skeleton draws
//   the SAME skeleton GanttView draws — its Notion-style toolbar, the 凡例 guide, the
//   two-tier date-axis header, the sticky left task-name column and the row grid — using
//   the EXACT same CSS module classes and the EXACT same layout constants (HEADER_H /
//   ROW_HEIGHT / DEFAULT_LEFT_W, now centralised in domain/timeline-axis). Because both
//   read one source of truth for those dimensions, the placeholder's toolbar, header
//   band, left column and every row line sit pixel-for-pixel where the real chart's do,
//   so nothing shifts when the data lands (Δ=0).
import type { CSSProperties } from "react";
import { Skeleton } from "@dub/ui";
import {
  ROW_HEIGHT,
  BAR_HEIGHT,
  HEADER_TOP,
  HEADER_BOTTOM,
  HEADER_H,
  DEFAULT_LEFT_W,
} from "../domain/timeline-axis";
import styles from "../styles/app.module.css";

export interface GanttSkeletonProps {
  /** how many placeholder rows to draw (default 8 — a comfortable first screenful). */
  rows?: number;
}

// A stable set of (left%, width%) pairs so the fake bars form a believable, varied
// timeline instead of a single column. Indexed modulo the row count.
const BAR_LAYOUT: ReadonlyArray<readonly [left: number, width: number]> = [
  [4, 26],
  [18, 34],
  [30, 22],
  [12, 40],
  [46, 20],
  [24, 30],
  [8, 18],
  [38, 28],
];

/**
 * GanttSkeleton — placeholder that matches GanttView's skeleton 1:1. Rendered by
 * TaskWorkspacePage while the gantt DTO is loading, in the SAME slot GanttView occupies,
 * so the switch to real data is a content swap with no reflow.
 */
export function GanttSkeleton({ rows = 8 }: GanttSkeletonProps): JSX.Element {
  const rowIdx = Array.from({ length: rows }, (_, i) => i);
  // A handful of evenly-spaced axis tick columns for the date-axis header placeholder.
  const ticks = Array.from({ length: 12 }, (_, i) => i);
  const bodyHeight = rows * ROW_HEIGHT;
  const rightStyle: CSSProperties = { flex: "1 1 auto", position: "relative", minWidth: 0 };

  return (
    <div
      className={styles.ganttView}
      role="status"
      aria-label="ガントチャートを読み込み中"
      data-testid="fe4-gantt-skeleton"
    >
      {/* toolbar — same structure/height as GanttView's tlToolbar so it doesn't shift */}
      <div className={styles.tlToolbar} aria-hidden>
        <div className={styles.tlToolbarLeft}>
          <span className={styles.tlViewName}>タイムライン</span>
          <Skeleton variant="text" width={40} height={12} />
        </div>
        <div className={styles.tlToolbarRight}>
          {/* heights mirror the real controls (今日/拡大 = 33px, 単位 SegmentedControl =
              38px) so the toolbar — and everything below it — sits at the same y. */}
          <Skeleton variant="rect" width={64} height={33} radius="8px" />
          <Skeleton variant="rect" width={132} height={38} radius="8px" />
          <Skeleton variant="rect" width={72} height={33} radius="8px" />
        </div>
      </div>

      {/* team 凡例 placeholder — the real GanttView shows a team-colour legend here for
          any event that has teams (the common case: a conference/hackathon roster). We
          reserve its one-line height with the SAME classes so the date-axis header/left
          column/rows below land at the same y as the loaded chart. */}
      <div className={styles.tlLegend} aria-hidden>
        {[64, 88, 72].map((w, i) => (
          // height 18 == the real legend chip's line-box height, so the strip is the
          // same 31px tall (12px padding + 18px content + 1px border) as the loaded one.
          <span key={i} className={styles.tlLegendItem} style={{ height: 18 }}>
            <span className={styles.tlLegendSwatch} aria-hidden />
            <Skeleton variant="text" width={w} height={10} />
          </span>
        ))}
      </div>

      {/* 凡例 guide — static text, rendered identically to GanttView so it lines up */}
      <div className={styles.tlGuide} aria-hidden>
        <span className={styles.tlGuideItem}>
          <span className={styles.tlGuideTree} aria-hidden>▸</span>
          親子（トグルで開閉・インデント）
        </span>
        <span className={styles.tlGuideItem}>
          <span className={styles.tlGuideSummary} aria-hidden />
          親の内包枠（展開時＝子を囲む・入れ子対応）
        </span>
      </div>

      <div className={styles.tlFrame}>
        <div className={styles.tlScroll}>
          <div className={styles.tlInner}>
            {/* ---- left task-name column (sticky) ---- */}
            <div
              className={styles.tlLeft}
              style={{ width: DEFAULT_LEFT_W, flexBasis: DEFAULT_LEFT_W }}
              aria-hidden
            >
              <div className={styles.tlLeftHead} style={{ height: HEADER_H }}>
                <span className={styles.tlLeftHeadTitle}>タスク</span>
              </div>
              {rowIdx.map((i) => (
                <div
                  key={i}
                  className={styles.tlRow}
                  style={{ height: ROW_HEIGHT, cursor: "default" }}
                >
                  <span className={styles.tlDot} aria-hidden />
                  <Skeleton variant="text" width={`${68 - (i % 3) * 12}%`} height={12} />
                </div>
              ))}
            </div>

            {/* ---- right timeline pane ---- */}
            <div className={styles.tlRight} style={rightStyle} aria-hidden>
              {/* two-tier date-axis header placeholder (month band + day/week ticks) */}
              <div className={styles.tlHeader} style={{ width: "100%", height: HEADER_H }}>
                <div
                  className={styles.tlHeaderTop}
                  style={{ height: HEADER_TOP, display: "flex", alignItems: "center", gap: 8, paddingLeft: 8 }}
                >
                  <Skeleton variant="text" width={72} height={11} />
                  <Skeleton variant="text" width={72} height={11} />
                  <Skeleton variant="text" width={72} height={11} />
                </div>
                <div
                  className={styles.tlHeaderBottom}
                  style={{
                    top: HEADER_TOP,
                    height: HEADER_BOTTOM,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-around",
                  }}
                >
                  {ticks.map((t) => (
                    <Skeleton key={t} variant="text" width={16} height={10} />
                  ))}
                </div>
              </div>

              {/* body: row lines + a fake bar per row (same pitch as the real grid) */}
              <div className={styles.tlBody} style={{ width: "100%", height: bodyHeight }}>
                {rowIdx.map((i) => (
                  <div
                    key={`line-${i}`}
                    className={styles.tlRowLine}
                    style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
                    aria-hidden
                  />
                ))}
                {rowIdx.map((i) => {
                  const [left, width] = BAR_LAYOUT[i % BAR_LAYOUT.length]!;
                  return (
                    <div
                      key={`bar-${i}`}
                      style={{
                        position: "absolute",
                        top: i * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2,
                        left: `${left}%`,
                        width: `${width}%`,
                        height: BAR_HEIGHT,
                      }}
                    >
                      <Skeleton variant="rect" width="100%" height={BAR_HEIGHT} radius="6px" />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
