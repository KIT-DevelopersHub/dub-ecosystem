import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SegmentedControl } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";
import type { common, gantt, task } from "@dub/types";
import {
  type AxisWindow,
  type TimelineBar,
  ROW_HEIGHT,
  BAR_HEIGHT,
  bottomTicks,
  canvasWidth,
  dayAtX,
  extendWindow,
  initialWindow,
  pxToDays,
  rollupRowDates,
  shiftBar,
  timelineBars,
  todayX,
  topSegments,
  weekendBands,
  withGranularity,
} from "../domain/timeline-axis";
import styles from "../styles/app.module.css";

const HEADER_TOP = 28;
const HEADER_BOTTOM = 26;
const HEADER_H = HEADER_TOP + HEADER_BOTTOM;
const CLICK_THRESHOLD_PX = 4;
const DEFAULT_LEFT_W = 264;
const MIN_LEFT_W = 176;
const MAX_LEFT_W = 460;

export interface GanttViewProps {
  dto: gantt.GanttChartDTO;
  /** initial granularity; the view then owns it locally (chips switch instantly). */
  zoom: gantt.GanttZoom;
  onZoomChange?: (z: gantt.GanttZoom) => void;
  /** gantt-service may cap rows; container passes the flag. */
  truncated?: boolean;
  /** Commit a bar move/resize: whole-day start/end after the drag. */
  onSchedule?: (taskId: common.TaskId, startsAt: common.ISODateTime, endsAt: common.ISODateTime) => void;
  /** Shift a work-package (parent) AND its whole subtree by whole days (parent
   *  drag-move: children follow). Falls back to onSchedule when absent. */
  onScheduleShift?: (taskId: common.TaskId, deltaDays: number) => void;
  /** Click a bar or row to open the detail panel. */
  onSelect?: (taskId: common.TaskId) => void;
  /** Click an empty timeline cell / the add-row button to create (date preset). */
  onCreateOnDate?: (dueAt: common.ISODateTime | null) => void;
  /** taskId -> status, for status-legible bar colouring. */
  statusById?: ReadonlyMap<common.TaskId, task.TaskStatus>;
  /** taskId -> assignee display name, shown as a left-pane property. */
  assigneeNameById?: ReadonlyMap<common.TaskId, string>;
  /** taskId -> team accent colour, for the row stripe + bar cap (team grouping). */
  teamColorById?: ReadonlyMap<common.TaskId, string>;
  /** ordered [teamId,{name,color}] for the legend under the toolbar. */
  teamLegend?: ReadonlyArray<{ id: string; name: string; color: string }>;
  canWrite?: boolean;
}

// Granularity chips (month/week/day), built on the shared @dub/ui SegmentedControl
// so the sliding-pill selector matches ViewSwitcher and fe7 — see
// docs/segmented-control-unification.md. testids/values are unchanged.
const ZOOMS: SegmentedOption<gantt.GanttZoom>[] = [
  { value: "month", label: "月", testId: "fe4-gantt-zoom-month" },
  { value: "week", label: "週", testId: "fe4-gantt-zoom-week" },
  { value: "day", label: "日", testId: "fe4-gantt-zoom-day" },
];

const STATUS_BAR_CLASS: Record<task.TaskStatus, string> = {
  todo: styles.barTodo!,
  in_progress: styles.barInProgress!,
  blocked: styles.barBlocked!,
  done: styles.barDone!,
  cancelled: styles.barCancelled!,
};

type DragMode = "move" | "resize-start" | "resize-end";
interface DragState {
  taskId: common.TaskId;
  mode: DragMode;
  startsAt: string;
  endsAt: string;
  dxPx: number;
}

export function GanttView({
  dto,
  zoom: zoomProp,
  onZoomChange,
  truncated,
  onSchedule,
  onScheduleShift,
  onSelect,
  onCreateOnDate,
  statusById,
  assigneeNameById,
  teamColorById,
  teamLegend,
  canWrite = true,
}: GanttViewProps) {
  const [zoom, setZoom] = useState<gantt.GanttZoom>(zoomProp);
  const [win, setWin] = useState<AxisWindow>(() => initialWindow(dto.rows, zoomProp));
  const [leftW, setLeftW] = useState(DEFAULT_LEFT_W);
  const [collapsed, setCollapsed] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  // WBS drill-down: set of expanded work-package ids. Empty = all collapsed, so the
  // view opens on the 41 work-packages and each toggle reveals its leaf children.
  const [openParents, setOpenParents] = useState<ReadonlySet<common.TaskId>>(() => new Set());

  const toggleParent = useCallback((id: common.TaskId) => {
    setOpenParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Parent (work-package) bars always enclose their children: roll each parent's
  // span up to the union of its descendants before any geometry runs, so widening
  // a child auto-grows the parent bar (and, via the window effect, the axis).
  const rolledRows = useMemo(() => rollupRowDates(dto.rows), [dto.rows]);

  // Rows actually shown: a child (has a parent) is hidden unless its parent is open.
  const rows = useMemo(
    () => rolledRows.filter((r) => !(r.parentTaskId && !openParents.has(r.parentTaskId))),
    [rolledRows, openParents],
  );

  // taskId -> true when the row is a WBS parent (its bar spans its children via
  // rollup). Parents are now draggable too — a move shifts the whole subtree.
  const parentIds = useMemo(() => {
    const s = new Set<common.TaskId>();
    for (const r of dto.rows) if (r.hasChildren) s.add(r.taskId);
    return s;
  }, [dto.rows]);

  // taskId -> the ROLLED row (parent dates are the union of their children). Drag
  // start/end must read these displayed dates, not the parent's pre-rollup seed.
  const rolledById = useMemo(() => new Map(rolledRows.map((r) => [r.taskId, r])), [rolledRows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const movedRef = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);
  const centeredForZoom = useRef<gantt.GanttZoom | null>(null);
  const extendPending = useRef(false);

  useEffect(() => setZoom(zoomProp), [zoomProp]);

  // granularity change keeps the same span, swaps px; re-centre on today after.
  useEffect(() => {
    setWin((w) => withGranularity(w, zoom));
    centeredForZoom.current = null;
  }, [zoom]);

  // grow-only: ensure the window always covers the current rows (+ buffers).
  useEffect(() => {
    setWin((w) => {
      const base = initialWindow(dto.rows, zoom);
      const originMs = Math.min(w.originMs, base.originMs);
      const endMs = Math.max(w.endMs, base.endMs);
      return originMs === w.originMs && endMs === w.endMs ? w : { ...w, originMs, endMs };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto.rows]);

  const width = canvasWidth(win);
  const bars = useMemo(() => timelineBars(rows, win), [rows, win]);
  const tops = useMemo(() => topSegments(win, zoom), [win, zoom]);
  const ticks = useMemo(() => bottomTicks(win, zoom), [win, zoom]);
  const weekends = useMemo(() => weekendBands(win, zoom), [win, zoom]);
  const tX = todayX(win);
  const rowsH = Math.max(rows.length * ROW_HEIGHT, ROW_HEIGHT);

  const titleById = useMemo(() => new Map(rows.map((r) => [r.taskId, r.title])), [rows]);
  const barById = useMemo(() => new Map(bars.map((b) => [b.taskId, b])), [bars]);

  const segs = useMemo(() => {
    return dto.dependencies
      .map((d) => {
        const from = barById.get(d.fromTaskId);
        const to = barById.get(d.toTaskId);
        if (!from || !to || !from.hasBar || !to.hasBar) return null;
        return {
          id: d.id,
          x1: from.x + from.width,
          y1: from.y + ROW_HEIGHT / 2,
          x2: to.x,
          y2: to.y + ROW_HEIGHT / 2,
          tip: `依存: ${titleById.get(d.fromTaskId) ?? d.fromTaskId} → ${titleById.get(d.toTaskId) ?? d.toTaskId}`,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [dto.dependencies, barById, titleById]);

  // Faint enclosing band drawn behind an open parent + its (contiguous) children,
  // so the parent-child grouping reads as a container — distinct from the arrows,
  // which mean dependency. Children render right after their parent, so the run
  // is contiguous.
  const groupBands = useMemo(() => {
    const bands: { id: common.TaskId; top: number; height: number }[] = [];
    rows.forEach((r, i) => {
      if (!(r.hasChildren && openParents.has(r.taskId))) return;
      let n = 0;
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[j]!.parentTaskId === r.taskId) n += 1;
        else break;
      }
      if (n > 0) bands.push({ id: r.taskId, top: i * ROW_HEIGHT, height: (n + 1) * ROW_HEIGHT });
    });
    return bands;
  }, [rows, openParents]);

  // ---- centre on today (initial + on zoom change) ----
  const scrollToToday = useCallback(
    (smooth = false) => {
      const el = scrollRef.current;
      if (!el) return;
      const target = Math.max(0, todayX(win) - (el.clientWidth - (collapsed ? 0 : leftW)) * 0.28);
      if (typeof el.scrollTo === "function") el.scrollTo({ left: target, behavior: smooth ? "smooth" : "auto" });
      else el.scrollLeft = target;
    },
    [win, leftW, collapsed],
  );

  useLayoutEffect(() => {
    if (centeredForZoom.current !== zoom) {
      centeredForZoom.current = zoom;
      scrollToToday(false);
    }
  }, [zoom, scrollToToday]);

  // ---- endless right edge: extend when the user nears it ----
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (extendPending.current) return;
    if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 500) {
      extendPending.current = true;
      requestAnimationFrame(() => {
        setWin((w) => extendWindow(w));
        extendPending.current = false;
      });
    }
  };

  const changeZoom = (z: gantt.GanttZoom) => {
    setZoom(z);
    onZoomChange?.(z);
  };

  // ---- bar pointer session (move + resize + click-to-open) ----
  const beginDrag = (e: React.PointerEvent, bar: TimelineBar, mode: DragMode) => {
    if (!canWrite || !onSchedule) {
      // read-only: a tap still opens detail
      if (mode === "move") onSelect?.(bar.taskId);
      return;
    }
    // Parents are draggable too now: read the ROLLED (displayed) span so a move
    // starts from the bar the user actually sees; the drop shifts the subtree.
    const row = rolledById.get(bar.taskId) ?? dto.rows.find((r) => r.taskId === bar.taskId);
    if (!row?.startsAt || !row?.endsAt) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragStartX.current = e.clientX;
    resizeStartX.current = bar.x;
    resizeStartW.current = bar.width;
    movedRef.current = false;
    setDrag({ taskId: bar.taskId, mode, startsAt: row.startsAt, endsAt: row.endsAt, dxPx: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - dragStartX.current;
    if (Math.abs(dx) > CLICK_THRESHOLD_PX) movedRef.current = true;
    setDrag({ ...drag, dxPx: dx });
  };

  const onPointerUp = () => {
    if (!drag) return;
    const { taskId, mode, startsAt, endsAt, dxPx } = drag;
    if (!movedRef.current) {
      // A click that didn't move opens detail — same affordance as leaf bars.
      if (mode === "move") onSelect?.(taskId);
    } else {
      const deltaDays = pxToDays(dxPx, win);
      if (deltaDays !== 0) {
        // Parent MOVE: shift the whole subtree so children follow (keeps rollup
        // consistent — the parent bar stays the union of its shifted children).
        if (mode === "move" && parentIds.has(taskId) && onScheduleShift) {
          onScheduleShift(taskId, deltaDays);
        } else if (onSchedule) {
          // Leaf move/resize, or a parent RESIZE: persist the row's own span. For a
          // parent, rollup then unions it with the children — extending grows the
          // bar, shrinking below the children is ignored (children never split).
          const next = shiftBar(startsAt, endsAt, deltaDays, mode);
          onSchedule(taskId, next.startsAt, next.endsAt);
        }
      }
    }
    setDrag(null);
    movedRef.current = false;
  };

  // live-preview geometry for the bar under an active drag
  const previewGeom = (bar: TimelineBar): { left: number; width: number } => {
    if (!drag || drag.taskId !== bar.taskId) return { left: bar.x, width: bar.width };
    const d = drag.dxPx;
    if (drag.mode === "move") return { left: bar.x + d, width: bar.width };
    if (drag.mode === "resize-start")
      return { left: bar.x + Math.min(d, bar.width - BAR_HEIGHT), width: Math.max(bar.width - d, BAR_HEIGHT) };
    return { left: bar.x, width: Math.max(bar.width + d, BAR_HEIGHT) };
  };

  const barClassOf = (taskId: common.TaskId) => {
    const status = statusById?.get(taskId);
    const cls = status ? STATUS_BAR_CLASS[status] : "";
    const dragging = drag?.taskId === taskId && movedRef.current ? styles.barDragging : "";
    // Parent (work-package) rows keep the rollup behaviour (their span still auto-
    // encloses their children) but render as an ordinary, legible task bar — the
    // hollow "bracket summary" look was reverted per feedback #97 (見づらい). The
    // parent/child vs dependency distinction is carried by indent + tree lines +
    // the dashed dependency arrows + the legend, not by a special bar shape.
    return `${styles.bar} ${cls} ${dragging}`;
  };

  // ---- left-pane resize ----
  const onResizerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startW = leftW;
    const move = (ev: PointerEvent) => {
      const next = Math.min(MAX_LEFT_W, Math.max(MIN_LEFT_W, startW + (ev.clientX - startX)));
      setLeftW(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // click an empty timeline cell -> create with that day preset
  const onCanvasBackgroundClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canWrite || !onCreateOnDate) return;
    if (e.target !== e.currentTarget) return; // ignore clicks that bubbled from a bar
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const day = dayAtX(x, win);
    onCreateOnDate(new Date(day).toISOString());
  };

  const effLeftW = collapsed ? 0 : leftW;

  return (
    <div data-testid="fe4-gantt-view" className={styles.ganttView}>
      {/* Notion-style toolbar: view name + jump-to-today + granularity */}
      <div className={styles.tlToolbar}>
        <div className={styles.tlToolbarLeft}>
          <span className={styles.tlViewName}>タイムライン</span>
          <span className={styles.tlCount}>{rows.length} 件</span>
        </div>
        <div className={styles.tlToolbarRight}>
          <button type="button" className={styles.tlTodayBtn} onClick={() => scrollToToday(true)} data-testid="fe4-gantt-today-btn">
            今日
          </button>
          <SegmentedControl
            options={ZOOMS}
            value={zoom}
            onChange={changeZoom}
            size="sm"
            aria-label="時間軸の単位"
            testId="fe4-gantt-zoom"
          />
        </div>
      </div>

      {teamLegend && teamLegend.length > 0 && (
        <div className={styles.tlLegend} data-testid="fe4-gantt-legend" aria-label="チーム凡例">
          {teamLegend.map((t) => (
            <span key={t.id} className={styles.tlLegendItem}>
              <span className={styles.tlLegendSwatch} style={{ background: t.color }} aria-hidden />
              {t.name}
            </span>
          ))}
        </div>
      )}

      {/* how to read the chart: parent-child (toggle/indent) vs dependency (arrow) */}
      <div className={styles.tlGuide} data-testid="fe4-gantt-guide" aria-label="表記の凡例">
        <span className={styles.tlGuideItem}>
          <span className={styles.tlGuideTree} aria-hidden>▸</span>
          親子（トグルで開閉・インデント）
        </span>
        <span className={styles.tlGuideItem}>
          <span className={styles.tlGuideSummary} aria-hidden />
          まとめバー（親＝子の期間を合算）
        </span>
        <span className={styles.tlGuideItem}>
          <svg className={styles.tlGuideDepIcon} width="26" height="10" aria-hidden>
            <defs>
              <marker id="fe4-legend-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L5,3 L0,6 Z" className={styles.tlDepArrow} />
              </marker>
            </defs>
            <path d="M1,5 H20" fill="none" className={styles.tlDep} markerEnd="url(#fe4-legend-arrow)" />
          </svg>
          依存（前工程 → 後工程）
        </span>
      </div>

      {truncated && (
        <div className={styles.banner} data-testid="fe4-gantt-truncated">
          表示上限に達しました。担当者・期間フィルタで絞り込んでください。
        </div>
      )}

      <div className={styles.tlFrame}>
        <div className={styles.tlScroll} ref={scrollRef} data-testid="fe4-gantt-scroll" onScroll={onScroll} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <div className={styles.tlInner} style={{ width: effLeftW + width, minWidth: "100%" }}>
            {/* ---- left pane (sticky) ---- */}
            {!collapsed && (
              <div className={styles.tlLeft} style={{ width: leftW, flexBasis: leftW }}>
                <div className={styles.tlLeftHead} style={{ height: HEADER_H }}>
                  <span className={styles.tlLeftHeadTitle}>タスク</span>
                  <button
                    type="button"
                    className={styles.tlCollapseBtn}
                    onClick={() => setCollapsed(true)}
                    aria-label="リストを折りたたむ"
                    title="リストを折りたたむ"
                  >
                    ‹
                  </button>
                </div>
                {rows.map((r) => {
                  const depth = r.depth ?? 0;
                  const isOpen = openParents.has(r.taskId);
                  return (
                    <button
                      key={r.taskId}
                      type="button"
                      className={`${styles.tlRow} ${depth > 0 ? styles.tlRowChild : ""}`}
                      // Parent rows move the left indent INTO the toggle so the whole
                      // left gutter (everything left of the team stripe) toggles — a
                      // much bigger hit target than the chevron glyph (feedback #39).
                      style={{ height: ROW_HEIGHT, paddingLeft: r.hasChildren ? 0 : 12 + depth * 18 }}
                      title={r.title}
                      onClick={() => onSelect?.(r.taskId)}
                      data-testid={`fe4-gantt-row-${r.taskId}`}
                    >
                      {r.hasChildren ? (
                        <span
                          className={styles.tlToggleWide}
                          style={{ paddingLeft: 12 + depth * 18 }}
                          role="button"
                          tabIndex={0}
                          aria-label={isOpen ? "子タスクを閉じる" : "子タスクを開く"}
                          aria-expanded={isOpen}
                          data-testid={`fe4-gantt-toggle-${r.taskId}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleParent(r.taskId);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleParent(r.taskId);
                            }
                          }}
                        >
                          <span className={styles.tlToggleGlyph} aria-hidden>{isOpen ? "▾" : "▸"}</span>
                        </span>
                      ) : (
                        depth === 0 && <span className={styles.tlToggleSpacer} aria-hidden />
                      )}
                      {teamColorById?.get(r.taskId) && (
                        <span className={styles.tlTeamStripe} style={{ background: teamColorById.get(r.taskId) }} aria-hidden />
                      )}
                      <span className={`${styles.tlDot} ${statusById?.get(r.taskId) ? STATUS_BAR_CLASS[statusById.get(r.taskId)!] : ""}`} aria-hidden />
                      <span className={styles.tlRowName}>{r.title}</span>
                      {assigneeNameById?.get(r.taskId) && <span className={styles.tlRowMeta}>{assigneeNameById.get(r.taskId)}</span>}
                    </button>
                  );
                })}
                {canWrite && onCreateOnDate && (
                  <button type="button" className={styles.tlAddRow} style={{ height: ROW_HEIGHT }} onClick={() => onCreateOnDate(null)} data-testid="fe4-gantt-addrow">
                    ＋ 新規タスク
                  </button>
                )}
                <div className={styles.tlResizer} onPointerDown={onResizerDown} aria-hidden />
              </div>
            )}

            {/* ---- timeline pane ---- */}
            <div className={styles.tlRight} style={{ width, flexBasis: width, position: "relative" }}>
              {/* header: two tiers */}
              <div className={styles.tlHeader} style={{ width, height: HEADER_H }} data-testid="fe4-gantt-header">
                <div className={styles.tlHeaderTop} style={{ height: HEADER_TOP }}>
                  {tops.map((s) => (
                    <div key={s.key} className={styles.tlMonth} style={{ left: s.x, width: s.width }}>
                      <span className={styles.tlMonthLabel}>{s.label}</span>
                    </div>
                  ))}
                </div>
                <div className={styles.tlHeaderBottom} style={{ top: HEADER_TOP, height: HEADER_BOTTOM }}>
                  {ticks.map((t) => (
                    <div key={t.key} className={`${styles.tlTick} ${t.isToday ? styles.tlTickToday : ""}`} style={{ left: t.x, width: t.width }}>
                      {t.label}
                    </div>
                  ))}
                </div>
              </div>

              {collapsed && (
                <button type="button" className={styles.tlExpandBtn} onClick={() => setCollapsed(false)} title="リストを開く" aria-label="リストを開く">
                  ›
                </button>
              )}

              {/* body */}
              <div
                className={styles.tlBody}
                style={{ width, height: rowsH }}
                onClick={onCanvasBackgroundClick}
              >
                {/* parent-child grouping: faint enclosure behind an open parent + its children */}
                {groupBands.map((g) => (
                  <div
                    key={`grp-${g.id}`}
                    className={styles.tlGroupBand}
                    style={{ top: g.top, height: g.height, width }}
                    data-testid={`fe4-gantt-group-${g.id}`}
                    aria-hidden
                  />
                ))}
                {/* weekend shading */}
                {weekends.map((b) => (
                  <div key={b.key} className={styles.tlWeekend} style={{ left: b.x, width: b.width, height: rowsH }} aria-hidden />
                ))}
                {/* row lines / hover stripes */}
                {rows.map((_, i) => (
                  <div key={i} className={styles.tlRowLine} style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }} aria-hidden />
                ))}

                {/* dependency connectors (subtle) */}
                {segs.length > 0 && (
                  <svg width={width} height={rowsH} className={styles.tlSvg} aria-hidden>
                    <defs>
                      <marker id="fe4-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                        <path d="M0,0 L5,3 L0,6 Z" className={styles.tlDepArrow} />
                      </marker>
                    </defs>
                    {segs.map((s) => {
                      const midX = Math.max(s.x1 + 10, s.x2 - 10);
                      const d = `M ${s.x1} ${s.y1} H ${midX} V ${s.y2} H ${s.x2}`;
                      return (
                        <path key={s.id} d={d} fill="none" className={styles.tlDep} markerEnd="url(#fe4-arrow)" data-testid={`fe4-gantt-dep-${s.id}`}>
                          <title>{s.tip}</title>
                        </path>
                      );
                    })}
                  </svg>
                )}

                {/* today line */}
                <div className={styles.tlToday} style={{ left: tX, height: rowsH }} data-testid="fe4-gantt-today" aria-hidden />

                {/* bars */}
                {bars.map((b) => {
                  if (!b.hasBar) return null;
                  const g = previewGeom(b);
                  const showInside = g.width > 66;
                  return (
                    <div
                      key={b.taskId}
                      className={barClassOf(b.taskId)}
                      style={{ left: g.left, top: b.y + (ROW_HEIGHT - BAR_HEIGHT) / 2, width: g.width, height: BAR_HEIGHT }}
                      title={titleById.get(b.taskId) ?? ""}
                      data-testid={`fe4-gantt-bar-${b.taskId}`}
                      onPointerDown={(e) => beginDrag(e, b, "move")}
                    >
                      {teamColorById?.get(b.taskId) && (
                        <span className={styles.barTeamCap} style={{ background: teamColorById.get(b.taskId) }} aria-hidden />
                      )}
                      <div className={styles.barProgress} style={{ width: `${b.progressPercent}%` }} aria-hidden />
                      {canWrite && onSchedule && (
                        <span
                          className={styles.barHandle + " " + styles.barHandleL}
                          data-testid={`fe4-gantt-bar-${b.taskId}-rz-l`}
                          onPointerDown={(e) => beginDrag(e, b, "resize-start")}
                          aria-hidden
                        />
                      )}
                      {showInside && <span className={styles.barLabel}>{titleById.get(b.taskId)}</span>}
                      {canWrite && onSchedule && (
                        <span
                          className={styles.barHandle + " " + styles.barHandleR}
                          data-testid={`fe4-gantt-bar-${b.taskId}-rz-r`}
                          onPointerDown={(e) => beginDrag(e, b, "resize-end")}
                          aria-hidden
                        />
                      )}
                      {!showInside && <span className={styles.barLabelOut} style={{ left: g.width + 8 }}>{titleById.get(b.taskId)}</span>}
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
