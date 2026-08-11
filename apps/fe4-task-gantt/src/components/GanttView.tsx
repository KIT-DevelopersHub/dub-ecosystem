import { useEffect, useMemo, useRef, useState } from "react";
import type { common, gantt } from "@dub/types";
import {
  computeDateBounds,
  ganttGeometry,
  dependencySegments,
  timelineTicks,
  todayLineX,
  pxToDayDelta,
  type BarBox,
} from "../domain/gantt-layout";
import styles from "../styles/app.module.css";

const ROW_HEIGHT = 34;
const BAR_H = 20;
const LABEL_COL = 220;

export interface GanttViewProps {
  dto: gantt.GanttChartDTO;
  /** initial zoom; the view then owns zoom locally (chips switch instantly). */
  zoom: gantt.GanttZoom;
  onZoomChange?: (z: gantt.GanttZoom) => void;
  /** gantt-service may cap rows at 2000; container passes the flag (design 8-8). */
  truncated?: boolean;
  /** Drag a bar N whole days: container patches the task's dueAt (optimistic). */
  onReschedule?: (taskId: common.TaskId, deltaDays: number) => void;
}

const ZOOMS: gantt.GanttZoom[] = ["day", "week", "month"];

/** Tick label granularity: day shows M/D, week/month show the ISO date. */
function tickLabel(iso: string, zoom: gantt.GanttZoom): string {
  const d = new Date(iso);
  if (zoom === "day") return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return iso;
}

export function GanttView({ dto, zoom: zoomProp, onZoomChange, truncated, onReschedule }: GanttViewProps) {
  const [zoom, setZoom] = useState<gantt.GanttZoom>(zoomProp);
  useEffect(() => setZoom(zoomProp), [zoomProp]);

  // live drag preview: {taskId, dxPx} while a bar is being dragged.
  const [drag, setDrag] = useState<{ taskId: common.TaskId; dxPx: number } | null>(null);
  const dragStartX = useRef(0);

  const criticalIds = useMemo(() => new Set(dto.criticalTaskIds ?? []), [dto.criticalTaskIds]);
  const bounds = useMemo(() => computeDateBounds(dto.rows), [dto.rows]);
  const boxes = useMemo(
    () => (bounds ? ganttGeometry(dto.rows, bounds, { zoom, rowHeight: ROW_HEIGHT }, criticalIds) : []),
    [bounds, dto.rows, zoom, criticalIds],
  );
  const segs = useMemo(
    () => (bounds ? dependencySegments(dto.dependencies, boxes, dto.rows, ROW_HEIGHT) : []),
    [bounds, dto.dependencies, boxes, dto.rows],
  );
  const ticks = useMemo(() => (bounds ? timelineTicks(bounds, zoom) : []), [bounds, zoom]);
  const todayX = bounds ? todayLineX(bounds, zoom) : null;

  const canvasWidth = ticks.length ? ticks[ticks.length - 1]!.x + 80 : 400;
  const canvasHeight = Math.max(dto.rows.length * ROW_HEIGHT, ROW_HEIGHT);
  const titleById = useMemo(() => new Map(dto.rows.map((r) => [r.taskId, r.title])), [dto.rows]);

  const changeZoom = (z: gantt.GanttZoom) => {
    setZoom(z);
    onZoomChange?.(z);
  };

  // ---- bar drag (pointer events; only fires reschedule past a 1-day threshold) ----
  const onBarPointerDown = (e: React.PointerEvent, taskId: common.TaskId) => {
    if (!onReschedule) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragStartX.current = e.clientX;
    setDrag({ taskId, dxPx: 0 });
  };
  const onBarPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, dxPx: e.clientX - dragStartX.current });
  };
  const onBarPointerUp = () => {
    if (!drag) return;
    const deltaDays = pxToDayDelta(drag.dxPx, zoom);
    if (deltaDays !== 0) onReschedule?.(drag.taskId, deltaDays);
    setDrag(null);
  };

  const barLeft = (b: BarBox) => b.x + (drag?.taskId === b.taskId ? drag.dxPx : 0);

  return (
    <div data-testid="fe4-gantt-view">
      <div className={styles.toolbar}>
        <div className={styles.switcher} role="tablist" aria-label="ズーム">
          {ZOOMS.map((z) => (
            <button
              key={z}
              role="tab"
              aria-selected={z === zoom}
              className={`${styles.switcherBtn} ${z === zoom ? styles.switcherBtnActive : ""}`}
              onClick={() => changeZoom(z)}
              data-testid={`fe4-gantt-zoom-${z}`}
            >
              {z === "day" ? "日" : z === "week" ? "週" : "月"}
            </button>
          ))}
        </div>
        <span className={styles.ganttLegend}>
          <span className={`${styles.legendSwatch} ${styles.legendCritical}`} /> クリティカルパス
          <span className={`${styles.legendSwatch} ${styles.legendToday}`} /> 今日
        </span>
      </div>

      {truncated && (
        <div className={styles.banner} data-testid="fe4-gantt-truncated">
          表示上限に達しました。担当者・期間フィルタで絞り込んでください。
        </div>
      )}

      {!bounds ? (
        <div className={styles.ganttEmpty} data-testid="fe4-gantt-empty">
          期日が設定されたタスクがありません。タスクに期日を設定すると棒が表示されます。
        </div>
      ) : (
        <div className={styles.gantt}>
          <div className={styles.ganttGrid} style={{ gridTemplateColumns: `${LABEL_COL}px ${canvasWidth}px` }}>
            {/* row 1: sticky corner + timeline header */}
            <div className={styles.ganttCorner}>タスク</div>
            <div className={styles.ganttHeader} style={{ width: canvasWidth }} data-testid="fe4-gantt-header">
              {ticks.map((t) => (
                <div key={t.ms} className={styles.ganttTick} style={{ left: t.x }}>
                  {tickLabel(t.label, zoom)}
                </div>
              ))}
              {todayX !== null && (
                <div className={styles.ganttTodayLabel} style={{ left: todayX }} data-testid="fe4-gantt-today-label">
                  今日
                </div>
              )}
            </div>

            {/* row 2: labels + canvas */}
            <div className={styles.ganttLabels}>
              {dto.rows.map((r) => (
                <div
                  key={r.taskId}
                  className={styles.ganttRowLabel}
                  style={{ height: ROW_HEIGHT }}
                  title={r.title}
                  data-testid={`fe4-gantt-row-${r.taskId}`}
                >
                  {criticalIds.has(r.taskId) && <span className={styles.criticalDot} aria-hidden />}
                  {r.title}
                </div>
              ))}
            </div>

            <div
              className={styles.ganttCanvas}
              style={{ width: canvasWidth, height: canvasHeight }}
              onPointerMove={onBarPointerMove}
              onPointerUp={onBarPointerUp}
            >
              {/* zebra rows */}
              {dto.rows.map((_, i) => (
                <div
                  key={i}
                  className={styles.ganttRowStripe}
                  style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
                  aria-hidden
                />
              ))}

              {/* dependency connectors (behind bars) */}
              <svg width={canvasWidth} height={canvasHeight} className={styles.ganttSvg} aria-hidden>
                <defs>
                  <marker id="fe4-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" className={styles.depArrow} />
                  </marker>
                </defs>
                {segs.map((s) => {
                  const midX = Math.max(s.x1 + 8, s.x2 - 8);
                  const d = `M ${s.x1} ${s.y1} H ${midX} V ${s.y2} H ${s.x2}`;
                  return (
                    <path
                      key={s.id}
                      d={d}
                      fill="none"
                      className={s.isViolated ? styles.depViolated : styles.depNormal}
                      strokeWidth={s.isViolated ? 2 : 1.5}
                      markerEnd="url(#fe4-arrow)"
                      data-testid={`fe4-gantt-dep-${s.id}`}
                    />
                  );
                })}
              </svg>

              {/* today line */}
              {todayX !== null && (
                <div className={styles.ganttToday} style={{ left: todayX, height: canvasHeight }} data-testid="fe4-gantt-today" />
              )}

              {/* bars */}
              {boxes.map((b) =>
                b.hasBar ? (
                  <div
                    key={b.taskId}
                    className={`${styles.bar} ${b.isCritical ? styles.barCritical : ""} ${drag?.taskId === b.taskId ? styles.barDragging : ""}`}
                    style={{ left: barLeft(b), top: b.y + (ROW_HEIGHT - BAR_H) / 2, width: b.width, height: BAR_H }}
                    title={`${titleById.get(b.taskId) ?? ""} — ${b.progressPercent}%`}
                    data-testid={`fe4-gantt-bar-${b.taskId}`}
                    onPointerDown={onReschedule ? (e) => onBarPointerDown(e, b.taskId) : undefined}
                  >
                    <div className={styles.barProgress} style={{ width: `${b.progressPercent}%` }} />
                    <span className={styles.barLabel}>{titleById.get(b.taskId)}</span>
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
