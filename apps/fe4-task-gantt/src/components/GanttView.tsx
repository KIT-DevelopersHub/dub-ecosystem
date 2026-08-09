import type { gantt } from "@dub/types";
import {
  computeDateBounds,
  ganttGeometry,
  dependencySegments,
  timelineTicks,
} from "../domain/gantt-layout";
import styles from "../styles/app.module.css";

const ROW_HEIGHT = 28;

export interface GanttViewProps {
  dto: gantt.GanttChartDTO;
  zoom: gantt.GanttZoom;
  onZoomChange?: (z: gantt.GanttZoom) => void;
  /** gantt-service may cap rows at 2000; container passes the flag (design 8-8). */
  truncated?: boolean;
}

const ZOOMS: gantt.GanttZoom[] = ["day", "week", "month"];

export function GanttView({ dto, zoom, onZoomChange, truncated }: GanttViewProps) {
  const bounds = computeDateBounds(dto.rows);
  const boxes = bounds ? ganttGeometry(dto.rows, bounds, { zoom, rowHeight: ROW_HEIGHT }) : [];
  const segs = bounds ? dependencySegments(dto.dependencies, boxes, dto.rows, ROW_HEIGHT) : [];
  const ticks = bounds ? timelineTicks(bounds, zoom) : [];
  const canvasWidth = ticks.length ? ticks[ticks.length - 1]!.x + 80 : 400;
  const canvasHeight = dto.rows.length * ROW_HEIGHT;

  return (
    <div data-testid="fe4-gantt-view">
      <div className={styles.toolbar}>
        {ZOOMS.map((z) => (
          <button
            key={z}
            className={`${styles.chip} ${z === zoom ? styles.chipActive : ""}`}
            onClick={() => onZoomChange?.(z)}
            data-testid={`fe4-gantt-zoom-${z}`}
          >
            {z}
          </button>
        ))}
      </div>
      {truncated && (
        <div className={styles.banner} data-testid="fe4-gantt-truncated">
          表示上限に達しました。担当者・期間フィルタで絞り込んでください。
        </div>
      )}
      <div className={styles.gantt}>
        <div className={styles.ganttGrid}>
          <div>
            {dto.rows.map((r) => (
              <div key={r.taskId} className={styles.ganttRowLabel} style={{ height: ROW_HEIGHT }} data-testid={`fe4-gantt-row-${r.taskId}`}>
                {r.title}
              </div>
            ))}
          </div>
          <div className={styles.ganttCanvas} style={{ width: canvasWidth, height: canvasHeight }}>
            {boxes.map((b) =>
              b.hasBar ? (
                <div key={b.taskId}>
                  <div
                    className={styles.bar}
                    style={{ left: b.x, top: b.y + 4, width: b.width }}
                    data-testid={`fe4-gantt-bar-${b.taskId}`}
                  />
                  <div className={styles.barProgress} style={{ left: b.x, top: b.y + 4, width: b.progressWidth }} />
                </div>
              ) : null,
            )}
            <svg width={canvasWidth} height={canvasHeight} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {segs.map((s) => (
                <line
                  key={s.id}
                  x1={s.x1}
                  y1={s.y1}
                  x2={s.x2}
                  y2={s.y2}
                  className={s.isViolated ? styles.depViolated : styles.depNormal}
                  strokeWidth={s.isViolated ? 2 : 1}
                  data-testid={`fe4-gantt-dep-${s.id}`}
                />
              ))}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
