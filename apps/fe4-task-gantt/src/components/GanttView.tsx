import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, SegmentedControl, Select, SortableList } from "@dub/ui";
import type { SegmentedOption, SelectOption, SortableItemContext, SortableReorderEvent } from "@dub/ui";
import { barsInRect, normalizeRect, rectIsDrag, unionIds, type Rect } from "../domain/marquee";
import type { GanttSortMode } from "../domain/row-sort";
import { GANTT_SORT_OPTIONS } from "../domain/gantt-sort-pref";
import { groupRuns, type RowGroup } from "../domain/row-groups";
import { readableTextColor } from "../domain/color-contrast";
import { childProgressByParent, type ChildProgress } from "../domain/child-progress";
import type { common, gantt, task } from "@dub/types";

/** arrayMove — pure list move (kept local so fe4 needs no direct @dnd-kit/sortable dep;
 *  the DnD itself lives in @dub/ui's SortableList). */
function moveInList<T>(arr: readonly T[], from: number, to: number): T[] {
  const copy = arr.slice();
  const [moved] = copy.splice(from, 1);
  if (moved !== undefined) copy.splice(to, 0, moved);
  return copy;
}
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
  parentEnclosures,
  pxToDays,
  rollupRowDates,
  shiftBar,
  timelineBars,
  todayX,
  topSegments,
  weekendBands,
  withGranularity,
} from "../domain/timeline-axis";
import { reorderSelectionWithinSiblings } from "../domain/row-order";
import { visibleTreeRows } from "../domain/gantt-layout";
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
  /** RESIZE a work-package (parent) bar by whole days at one edge. A parent's span is
   *  DERIVED from its children (the read model returns the parent's own dates as null), so
   *  persisting the parent's own row would be discarded on the next GET — the bar snaps
   *  back ("親バーを伸ばしても反映されない"). Instead the container SCALES the children to fill
   *  the new span, which persists and rolls the parent bar up to match. `edge`=which handle;
   *  `deltaDays`=whole-day drag at that edge (＋ grows at that edge). Absent ⇒ parent resize
   *  falls back to the (non-persisting) onSchedule. */
  onParentResize?: (parentId: common.TaskId, edge: "start" | "end", deltaDays: number) => void;
  /** Reorder rows by dragging in the left pane. `beforeTaskId` = the sibling the
   *  dragged row should sit immediately before (null ⇒ move to the end of its
   *  group). Only same-parent moves are applied by the container. Absent ⇒ no DnD. */
  onReorder?: (draggedId: common.TaskId, beforeTaskId: common.TaskId | null) => void;
  /** Current row 並び替え mode (手動/重要度/時期/チーム). The container owns the state
   *  and applies the actual re-ordering to `dto.rows`; this view only renders the
   *  selector and, in non-"manual" modes, hides the drag handles (auto-sorted). */
  sortMode?: GanttSortMode;
  onSortModeChange?: (mode: GanttSortMode) => void;
  /** Click a bar or row to open the detail panel. */
  onSelect?: (taskId: common.TaskId) => void;
  /** Click an empty timeline cell / the add-row button to create (date preset). */
  onCreateOnDate?: (dueAt: common.ISODateTime | null) => void;
  /** taskId -> status, for status-legible bar colouring. */
  statusById?: ReadonlyMap<common.TaskId, task.TaskStatus>;
  /** taskId -> assignee display name, shown as a left-pane property. */
  assigneeNameById?: ReadonlyMap<common.TaskId, string>;
  /** taskId -> title from the optimistic task store (task-service = the authority on
   *  title). Overrides the gantt read model's denormalized row title so a detail-panel
   *  rename reflects on every row/bar the SAME tick — and never reverts to a stale
   *  read-model copy after the reconciling refetch. Absent ⇒ use the DTO row title.
   *  Mirrors how statusById / assigneeNameById already flow from the store. */
  titleOverrides?: ReadonlyMap<common.TaskId, string>;
  /** taskId -> team accent colour, for the row stripe + bar cap (team grouping). */
  teamColorById?: ReadonlyMap<common.TaskId, string>;
  /** taskId -> WBS number label (e.g. "AA-1-1"), shown as a badge before the title.
   *  Computed by the container from the current row order + WBS tree; absent ⇒ no badge. */
  numberById?: ReadonlyMap<common.TaskId, string>;
  /** ordered [teamId,{name,color}] for the legend under the toolbar. */
  teamLegend?: ReadonlyArray<{ id: string; name: string; color: string }>;
  /** taskId -> its grouping descriptor for the current sort (チーム名/重要度ラベル…). When
   *  present, contiguous same-group rows get a labelled bracket down the list's right
   *  edge. Absent/empty (手動・時期) ⇒ no brackets. */
  rowGroupById?: ReadonlyMap<common.TaskId, RowGroup>;
  /** Bulk delete a marquee-selected set (after the confirm dialog). Absent ⇒ no bulk delete. */
  onBulkDelete?: (ids: readonly common.TaskId[]) => void;
  /** Shift a marquee-selected set left/right by whole days (arrow keys / group drag).
   *  Each selection root moves its own subtree, preserving relative positions + spans. */
  onBulkShiftDays?: (ids: readonly common.TaskId[], deltaDays: number) => void;
  /** Move a marquee-selected set up/down one slot (手動 mode only). */
  onBulkMoveVertical?: (ids: readonly common.TaskId[], dir: -1 | 1) => void;
  /** Group drag-reorder (⑤): drop a marquee-selected block at `overId`; the whole selection
   *  moves together, contiguous + in order. `draggedId` = grabbed row, `overId` = drop target.
   *  手動 mode only. Absent ⇒ a group drag falls back to a single-row `onReorder`. */
  onBulkReorderTo?: (ids: readonly common.TaskId[], draggedId: common.TaskId, overId: common.TaskId) => void;
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

// Per-status slice fill for a parent (work-package) bar. Reuses the SAME pastel
// tokens as the leaf status bars above, so a parent whose children are all 完了
// reads identically to a 完了 leaf bar, and a mixed parent shows those exact hues
// in proportion (design: 親バーを子ステータスの割合で色分け).
const STATUS_SEG_CLASS: Record<task.TaskStatus, string> = {
  todo: styles.barSegTodo!,
  in_progress: styles.barSegInProgress!,
  blocked: styles.barSegBlocked!,
  done: styles.barSegDone!,
  cancelled: styles.barSegCancelled!,
};

type DragMode = "move" | "resize-start" | "resize-end";
interface DragState {
  taskId: common.TaskId;
  mode: DragMode;
  startsAt: string;
  endsAt: string;
  dxPx: number;
}

/** One left-pane task row. Presentational: the DnD (reflow + floating clone) is owned
 *  by @dub/ui's `SortableList`, which hands this row its `dragHandleProps` (spread on
 *  the ⠿ handle — the ONLY drag surface, so the row's click-to-open is preserved) and
 *  wraps it in the transform/opacity node. */
function LeftPaneRow({
  r,
  isOpen,
  dragEnabled,
  grouped,
  selected,
  lifting,
  dragHandleProps,
  number,
  onSelect,
  toggleParent,
  statusById,
  assigneeNameById,
}: {
  r: gantt.GanttRow;
  isOpen: boolean;
  dragEnabled: boolean;
  /** true when the group-bracket rail is shown — reserves right padding for it. */
  grouped: boolean;
  /** true when this row is part of the marquee multi-selection. */
  selected: boolean;
  /** true while a GROUP drag is in flight and this is a selected row OTHER than the
   *  grabbed one — it dims in place so it reads as "picked up" into the floating stack. */
  lifting?: boolean;
  /** from SortableList.renderItem — spread on the drag handle to arm pointer/keyboard. */
  dragHandleProps: SortableItemContext["dragHandleProps"];
  /** WBS number label (e.g. "AA-1-1"); absent ⇒ no badge. */
  number?: string;
  onSelect?: (taskId: common.TaskId) => void;
  toggleParent: (id: common.TaskId) => void;
  statusById?: ReadonlyMap<common.TaskId, task.TaskStatus>;
  assigneeNameById?: ReadonlyMap<common.TaskId, string>;
}) {
  const depth = r.depth ?? 0;
  const style: React.CSSProperties = {
    height: ROW_HEIGHT,
    // Parent rows move the left indent INTO the toggle so the whole left gutter
    // toggles — a much bigger hit target than the chevron glyph (feedback #39).
    paddingLeft: r.hasChildren ? 0 : 12 + depth * 18,
  };
  return (
    <button
      type="button"
      className={`${styles.tlRow} ${depth > 0 ? styles.tlRowChild : ""} ${grouped ? styles.tlRowGrouped : ""} ${selected ? styles.tlRowSelected : ""} ${lifting ? styles.tlRowLifting : ""}`}
      style={style}
      aria-pressed={selected}
      title={r.title}
      onClick={() => onSelect?.(r.taskId)}
      data-testid={`fe4-gantt-row-${r.taskId}`}
      {...(selected ? { "data-fe4-keep-selection": "true" } : {})}
    >
      {dragEnabled && (
        <span
          {...dragHandleProps}
          className={styles.tlRowDrag}
          aria-label="ドラッグして並べ替え"
          title="ドラッグして並べ替え"
          data-testid={`fe4-gantt-drag-${r.taskId}`}
          onClick={(e) => e.stopPropagation()}
        >
          ⠿
        </span>
      )}
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
      {/* team accent is drawn as a fixed-x left rail (see tlTeamRail) — NOT inline —
          so consecutive same-team rows form a straight vertical line regardless of
          each row's WBS indent (the old in-flow stripe stepped with the indent). */}
      <span className={`${styles.tlDot} ${statusById?.get(r.taskId) ? STATUS_BAR_CLASS[statusById.get(r.taskId)!] : ""}`} aria-hidden />
      {number && (
        <span className={styles.tlRowNum} data-testid={`fe4-gantt-num-${r.taskId}`}>{number}</span>
      )}
      <span className={styles.tlRowName}>{r.title}</span>
      {assigneeNameById?.get(r.taskId) && <span className={styles.tlRowMeta}>{assigneeNameById.get(r.taskId)}</span>}
    </button>
  );
}

export function GanttView({
  dto,
  zoom: zoomProp,
  onZoomChange,
  truncated,
  onSchedule,
  onScheduleShift,
  onParentResize,
  onReorder,
  sortMode = "manual",
  onSortModeChange,
  onSelect,
  onCreateOnDate,
  statusById,
  assigneeNameById,
  titleOverrides,
  teamColorById,
  teamLegend,
  rowGroupById,
  numberById,
  onBulkDelete,
  onBulkShiftDays,
  onBulkMoveVertical,
  onBulkReorderTo,
  canWrite = true,
}: GanttViewProps) {
  const [zoom, setZoom] = useState<gantt.GanttZoom>(zoomProp);
  const [win, setWin] = useState<AxisWindow>(() => initialWindow(dto.rows, zoomProp));
  const [leftW, setLeftW] = useState(DEFAULT_LEFT_W);
  const [collapsed, setCollapsed] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  // 拡大（全画面）閲覧モード: みんなで投影して「見るだけ」の大画面表示。ON の間は
  // 編集（バーのドラッグ/リサイズ・詳細を開く・新規作成・並べ替え）を全て無効化し、
  // ズーム（日/週/月）と横スクロールだけを許す。Fullscreen API を使い、非対応/失敗時も
  // position:fixed のオーバーレイ（.ganttPresenting）で画面いっぱいに広がる。
  const [presenting, setPresenting] = useState(false);
  // 拡大中は編集不可（editing）・タップで詳細も開かない（interactive）＝純粋な閲覧。
  const editing = canWrite && !presenting;
  const interactive = !presenting;
  // ---- marquee multi-select (範囲ドラッグ) ----
  // The set of bars selected by a marquee (or additive shift/⌘ marquee). Bulk delete
  // / left-right shift / up-down reorder all act on this set. Cleared by Esc or an
  // empty background click.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<common.TaskId>>(() => new Set());
  // The live marquee rectangle (tlBody-local) while the user is dragging one out.
  const [marquee, setMarquee] = useState<Rect | null>(null);
  // Open state for the bulk-delete confirm dialog (same tone as the single-delete #364).
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Set true for the click that immediately follows a marquee drag, so the canvas
  // background click handler doesn't also fire (create / clear).
  const marqueeConsumedClickRef = useRef(false);
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

  // Row drag-reorder (left pane) via @dub/ui's SortableList — it owns the floating
  // clone + neighbour reflow + keyboard a11y; this view only supplies the rows and
  // commits the drop. Drag only makes sense in 手動 mode (an automatic sort would just
  // overwrite the drop next render), so the handles are hidden when a sort is active.
  const reorderEnabled = !!onReorder && editing && sortMode === "manual";
  // The current visible rows, read inside the reorder handler (which is memoised
  // before `rows` is derived). Kept fresh every render so the drop maps to the screen.
  const visibleRowsRef = useRef<gantt.GanttRow[]>([]);
  const onRowReorder = useCallback(
    (e: SortableReorderEvent) => {
      const activeId = e.activeId as common.TaskId;
      const overId = e.overId as common.TaskId;
      // Group drag (⑤): when the grabbed row is part of a marquee multi-selection, move the
      // WHOLE selected block together (contiguous, in order) to the drop target — not just the
      // one row. Hands the raw active/over ids to the host, which computes the block move.
      if (onBulkReorderTo && selectedIds.size > 1 && selectedIds.has(activeId)) {
        onBulkReorderTo([...selectedIds], activeId, overId);
        return;
      }
      // Translate the drop into the container's "place before X" contract so the
      // committed order equals the sortable PREVIEW (no post-drop jump). Same-parent
      // only: move the sibling id list, then whichever id ends up right AFTER the
      // dragged one is `beforeTaskId` (null ⇒ it became the group's last row). A
      // cross-parent drop is forwarded as-is — the container rejects it (no-op).
      const rows = visibleRowsRef.current;
      const byId = new Map(rows.map((r) => [r.taskId, r] as const));
      const parentOf = (id: common.TaskId) => byId.get(id)?.parentTaskId ?? null;
      if (parentOf(activeId) === parentOf(overId)) {
        const sibs = rows.filter((r) => (r.parentTaskId ?? null) === parentOf(activeId)).map((r) => r.taskId);
        const from = sibs.indexOf(activeId);
        const to = sibs.indexOf(overId);
        if (from < 0 || to < 0) {
          onReorder?.(activeId, overId);
          return;
        }
        const moved = moveInList(sibs, from, to);
        const pos = moved.indexOf(activeId);
        const before = pos + 1 < moved.length ? moved[pos + 1]! : null;
        onReorder?.(activeId, before);
      } else {
        onReorder?.(activeId, overId);
      }
    },
    [onReorder, onBulkReorderTo, selectedIds],
  );

  // Group-move animation (⑤): for a marquee multi-selection drag, give the SortableList
  // the FULL next order up front (the same block move the host commits) so it can render
  // the drop in ONE step and FLIP every moved row into place TOGETHER — instead of only
  // the grabbed row sliding while the rest jump. Single-row drags return null (default
  // arrayMove). Uses the visible rows + current selection so the optimistic order matches
  // what onBulkReorderTo persists.
  const computeGroupOrder = useCallback(
    (activeId: string, overId: string): string[] | null => {
      if (!(onBulkReorderTo && selectedIds.size > 1 && selectedIds.has(activeId as common.TaskId))) return null;
      return reorderSelectionWithinSiblings(
        visibleRowsRef.current,
        selectedIds,
        activeId as common.TaskId,
        overId as common.TaskId,
      );
    },
    [onBulkReorderTo, selectedIds],
  );

  // Swap in the store's (authoritative + optimistic) title before any geometry runs,
  // so a rename shows on every row/bar the same tick and survives the reconciling
  // refetch. Only the label changes; the DTO row still owns layout (dates/tree).
  const rowsTitled = useMemo(() => {
    if (!titleOverrides || titleOverrides.size === 0) return dto.rows;
    return dto.rows.map((r) => {
      const t = titleOverrides.get(r.taskId);
      return t !== undefined && t !== r.title ? { ...r, title: t } : r;
    });
  }, [dto.rows, titleOverrides]);

  // Parent (work-package) bars always enclose their children: roll each parent's
  // span up to the union of its descendants before any geometry runs, so widening
  // a child auto-grows the parent bar (and, via the window effect, the axis).
  const rolledRows = useMemo(() => rollupRowDates(rowsTitled), [rowsTitled]);

  // Rows actually shown: a row is hidden unless EVERY ancestor on its parent chain
  // is open — collapsing any ancestor hides the whole subtree, so a grandchild can
  // never stay visible under a collapsed grandparent (checking only the direct
  // parent left deep descendants stranded). Each node's own toggle state is kept, so
  // re-opening an ancestor restores the subtree exactly as the user left it.
  const rows = useMemo(() => visibleTreeRows(rolledRows, openParents), [rolledRows, openParents]);
  visibleRowsRef.current = rows;

  // taskId -> true when the row is a WBS parent (its bar spans its children via
  // rollup). Parents are now draggable too — a move shifts the whole subtree.
  const parentIds = useMemo(() => {
    const s = new Set<common.TaskId>();
    for (const r of dto.rows) if (r.hasChildren) s.add(r.taskId);
    return s;
  }, [dto.rows]);

  // Auto-expand a row the instant it becomes a parent (gains its first child). Adding
  // a subtask to a previously-childless task must reveal that child at once — otherwise
  // the new toggle appears collapsed and the child stays hidden ("追加した子タスクが
  // 見えない"). We diff parentIds against the previous render: only NEWLY-parented ids
  // are force-opened, so the initial all-collapsed load and any parent the user later
  // collapsed by hand are left untouched.
  const prevParentIdsRef = useRef<ReadonlySet<common.TaskId> | null>(null);
  useEffect(() => {
    const prev = prevParentIdsRef.current;
    prevParentIdsRef.current = parentIds;
    if (!prev) return; // first render: seed only, don't expand the whole seeded tree
    const newlyParented: common.TaskId[] = [];
    for (const id of parentIds) if (!prev.has(id)) newlyParented.push(id);
    if (newlyParented.length === 0) return;
    setOpenParents((cur) => {
      const next = new Set(cur);
      for (const id of newlyParented) next.add(id);
      return next;
    });
  }, [parentIds]);

  // parentId -> its children's status mix (完了/進行中/未着手…), for the at-a-glance
  // "子: n/m 完了" bar. Computed from ALL rows (not just the visible/rolled set) so a
  // collapsed parent still shows its full progress. Pure + memoised; re-derives when a
  // child's status changes (optimistic status edits flow through statusById).
  const childProgressById = useMemo<Map<common.TaskId, ChildProgress>>(
    () => (statusById ? childProgressByParent(dto.rows, statusById) : new Map()),
    [dto.rows, statusById],
  );

  // taskId -> the ROLLED row (parent dates are the union of their children). Drag
  // start/end must read these displayed dates, not the parent's pre-rollup seed.
  const rolledById = useMemo(() => new Map(rolledRows.map((r) => [r.taskId, r])), [rolledRows]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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

  // ---- 拡大（全画面）閲覧モード ----
  const enterPresent = useCallback(() => {
    setPresenting(true); // overlay covers the viewport even if native FS is unavailable
    const el = rootRef.current;
    // Prefer the native Fullscreen API for a truly immersive projector view; if it
    // rejects (permission/unsupported) the .ganttPresenting overlay already handles it.
    el?.requestFullscreen?.().catch(() => {});
  }, []);

  const exitPresent = useCallback(() => {
    if (typeof document !== "undefined" && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
    setPresenting(false);
  }, []);

  // Native fullscreen exit (Esc / browser chrome) → leave presenting so the UI syncs.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onFsChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Esc closes the overlay-only fallback (when native fullscreen never engaged; the
  // native path is handled by the browser + fullscreenchange above).
  useEffect(() => {
    if (!presenting || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitPresent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, exitPresent]);

  const width = canvasWidth(win);
  const bars = useMemo(() => timelineBars(rows, win), [rows, win]);
  const tops = useMemo(() => topSegments(win, zoom), [win, zoom]);
  const ticks = useMemo(() => bottomTicks(win, zoom), [win, zoom]);
  const weekends = useMemo(() => weekendBands(win, zoom), [win, zoom]);
  const tX = todayX(win);
  const rowsH = Math.max(rows.length * ROW_HEIGHT, ROW_HEIGHT);

  const titleById = useMemo(() => new Map(rows.map((r) => [r.taskId, r.title])), [rows]);
  const barById = useMemo(() => new Map(bars.map((b) => [b.taskId, b])), [bars]);

  // Every row (visible or hidden) by id — used to walk the WBS up to a visible anchor.
  const rowByIdAll = useMemo(() => new Map(dto.rows.map((r) => [r.taskId, r] as const)), [dto.rows]);
  // Resolve a dependency endpoint to the nearest row that is actually drawn: if the
  // endpoint is hidden inside a collapsed parent, walk up to the visible ancestor so
  // the edge renders as an AGGREGATE arrow on that parent instead of vanishing. A
  // fully-visible endpoint resolves to itself. This is why top-level ↔ top-level and
  // collapsed-subtree dependencies both show up now (判断: 折りたたみ中は集約表示).
  const visibleAnchor = useMemo(() => {
    return (taskId: common.TaskId): common.TaskId | null => {
      let id: common.TaskId | null = taskId;
      const guard = new Set<common.TaskId>();
      while (id && !guard.has(id)) {
        guard.add(id);
        if (barById.has(id)) return id;
        id = rowByIdAll.get(id)?.parentTaskId ?? null;
      }
      return null;
    };
  }, [barById, rowByIdAll]);

  const segs = useMemo(() => {
    const seen = new Set<string>(); // dedup edges aggregated onto the same anchor pair
    return dto.dependencies
      .map((d) => {
        const fromId = visibleAnchor(d.fromTaskId);
        const toId = visibleAnchor(d.toTaskId);
        // both collapsed into the SAME visible ancestor → an internal edge, nothing to draw
        if (!fromId || !toId || fromId === toId) return null;
        const from = barById.get(fromId);
        const to = barById.get(toId);
        if (!from || !to || !from.hasBar || !to.hasBar) return null;
        const key = `${fromId}->${toId}`;
        if (seen.has(key)) return null;
        seen.add(key);
        // ADR-0006 / 判断65: an endpoint folded UP to a visible parent is a
        // CROSS-HIERARCHY dependency (the real endpoint is a child at a deeper level,
        // shown aggregated on its parent bar). Same-level FS edges keep the side (left
        // edge) approach — 判断16「真ん中でなく横から」; cross-hierarchy edges instead
        // approach the parent bar VERTICALLY and touch its top/bottom edge at the bar's
        // horizontal middle, so the arrowhead reads as "a dependency onto that subtree"
        // rather than piercing the bar from the side. Visual anchor only — CPM/前後関係
        // is over the real child tasks, never derived from these coordinates.
        const fromAgg = fromId !== d.fromTaskId;
        const toAgg = toId !== d.toTaskId;
        const aggregated = fromAgg || toAgg;
        const fromCenterY = from.y + ROW_HEIGHT / 2;
        const toBarTop = to.y + (ROW_HEIGHT - BAR_HEIGHT) / 2;
        const toBarBottom = to.y + (ROW_HEIGHT + BAR_HEIGHT) / 2;
        const fromAbove = fromCenterY <= to.y + ROW_HEIGHT / 2;
        return {
          id: d.id,
          // predecessor: right edge normally; parent-bar middle when folded up.
          x1: fromAgg ? from.x + from.width / 2 : from.x + from.width,
          y1: fromCenterY,
          // successor: left edge normally; parent-bar middle when folded up.
          x2: toAgg ? to.x + to.width / 2 : to.x,
          y2: to.y + ROW_HEIGHT / 2,
          // cross-hierarchy target → drop onto the parent bar's top/bottom edge
          // (top when the source is above, bottom when below), never piercing it.
          dropOntoBar: toAgg,
          dropEdgeY: fromAbove ? toBarTop : toBarBottom,
          aggregated,
          mid: aggregated,
          tip: aggregated
            ? `依存（集約）: ${titleById.get(fromId) ?? fromId} → ${titleById.get(toId) ?? toId}（折りたたみ中の子タスク・親バー上辺/下辺を指しています）`
            : `依存: ${titleById.get(d.fromTaskId) ?? d.fromTaskId} → ${titleById.get(d.toTaskId) ?? d.toTaskId}`,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [dto.dependencies, barById, titleById, visibleAnchor]);

  // 内包バー (experimental): an open parent's bar GROWS vertically to cover its
  // subtree, so the parent visually CONTAINS its children instead of sitting in a
  // same-height row beside them (どれが親か図で分かりにくい問題, feedback). Each
  // enclosure is a translucent, bordered container spanning the parent's period
  // horizontally and its descendant rows vertically; the parent's own solid bar
  // rides the top edge as the container "header". Geometry is pure (parentEnclosures
  // walks the visible rows by DEPTH, so 3–4 level nests each get their own nested
  // box); here we just attach each parent's horizontal span (x/width) from its bar.
  // Folded parents produce nothing and fall back to the ordinary 1-row bar.
  const enclosures = useMemo(() => {
    return parentEnclosures(rows).map((e) => {
      const bar = barById.get(e.taskId);
      const left = bar?.hasBar ? bar.x : 0;
      const boxW = bar?.hasBar ? bar.width : width;
      // Two tints per zone, both @dub/tokens-derived:
      //  - bodyPct: the淡い parent-colour fill of the whole lane (子タスクが親色の上に載る).
      //    Deeper nests step up (12→15→18…) so a box reads as "inside" its ancestor.
      //  - headerPct: a distinctly stronger band over the parent's OWN row so "ここが親ゾーン"
      //    is legible at a glance (the header lane), independent of the bar riding on top.
      const bodyPct = 12 + Math.min(e.depth, 4) * 3;
      const headerPct = bodyPct + 8;
      return { ...e, left, boxW, bodyPct, headerPct };
    });
  }, [rows, barById, width]);

  // Sort grouping brackets: collapse the (already sorted) visible rows into runs of
  // rows that share a group key, so the list's right edge can draw one labelled
  // bracket per range (チーム順 → 「統括チーム」…, 重要度順 → 「高」「中」…). Empty in
  // 手動/時期 modes (no map passed), so the rail simply doesn't render there.
  const groupRunList = useMemo(() => groupRuns(rows, rowGroupById), [rows, rowGroupById]);
  const hasGroupRail = groupRunList.length > 0;

  // Team accent as a fixed-x LEFT rail: collapse the visible rows into contiguous
  // same-team runs and draw each as one straight 3px segment pinned to the pane's
  // left edge. This replaces the old per-row inline stripe, whose x moved with each
  // row's WBS indent and so stepped/zig-zagged between a parent and its child.
  const teamRailById = useMemo(() => {
    if (!teamColorById || teamColorById.size === 0) return undefined;
    const m = new Map<common.TaskId, RowGroup>();
    for (const [id, color] of teamColorById) m.set(id, { key: color, label: "", color });
    return m;
  }, [teamColorById]);
  const teamRailRuns = useMemo(() => groupRuns(rows, teamRailById), [rows, teamRailById]);

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
    if (!editing || !onSchedule) {
      // read-only: a tap still opens detail — but NOT in the 拡大 viewing mode
      // (interactive=false), which is strictly look-only.
      if (mode === "move" && interactive) onSelect?.(bar.taskId);
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
      if (mode === "move" && interactive) onSelect?.(taskId);
    } else {
      const deltaDays = pxToDays(dxPx, win);
      if (deltaDays !== 0) {
        // Group MOVE: the grabbed bar is in a multi-select — shift the whole selected
        // set together (each root carries its subtree), keeping relative positions.
        if (mode === "move" && selectedIds.size > 1 && selectedIds.has(taskId) && onBulkShiftDays) {
          onBulkShiftDays([...selectedIds], deltaDays);
          setDrag(null);
          movedRef.current = false;
          return;
        }
        // Parent MOVE: shift the whole subtree so children follow (keeps rollup
        // consistent — the parent bar stays the union of its shifted children).
        if (mode === "move" && parentIds.has(taskId) && onScheduleShift) {
          onScheduleShift(taskId, deltaDays);
        } else if ((mode === "resize-start" || mode === "resize-end") && parentIds.has(taskId) && onParentResize) {
          // Parent RESIZE: a work-package span is derived from its children, so persisting
          // the parent's own row is discarded on the next GET (the bar snaps back). Instead
          // SCALE the children to fill the new span — that persists and rolls the parent bar
          // up to match. edge = which handle the user grabbed.
          onParentResize(taskId, mode === "resize-start" ? "start" : "end", deltaDays);
        } else if (onSchedule) {
          // Leaf move/resize (persists its own row), or a parent op with no dedicated
          // handler wired (falls back to the row write).
          const next = shiftBar(startsAt, endsAt, deltaDays, mode);
          onSchedule(taskId, next.startsAt, next.endsAt);
        }
      }
    }
    setDrag(null);
    movedRef.current = false;
  };

  // True when the active drag is a group move: the grabbed bar is in a multi-select,
  // so every selected bar slides together (まとめてドラッグ).
  const isGroupMove = !!drag && drag.mode === "move" && selectedIds.size > 1 && selectedIds.has(drag.taskId);

  // live-preview geometry for the bar under an active drag
  const previewGeom = (bar: TimelineBar): { left: number; width: number } => {
    // Group move: shift EVERY selected bar by the same dx (not just the grabbed one).
    if (isGroupMove && selectedIds.has(bar.taskId)) return { left: bar.x + drag!.dxPx, width: bar.width };
    if (!drag || drag.taskId !== bar.taskId) return { left: bar.x, width: bar.width };
    const d = drag.dxPx;
    if (drag.mode === "move") return { left: bar.x + d, width: bar.width };
    if (drag.mode === "resize-start")
      return { left: bar.x + Math.min(d, bar.width - BAR_HEIGHT), width: Math.max(bar.width - d, BAR_HEIGHT) };
    return { left: bar.x, width: Math.max(bar.width + d, BAR_HEIGHT) };
  };

  const barClassOf = (taskId: common.TaskId) => {
    // Parent (work-package) bars with a known child-status mix render as a neutral
    // track filled by per-status slices (see childProgressById); their own single
    // status must NOT paint the whole bar, or the slices would be invisible.
    const isParentWithProgress = parentIds.has(taskId) && childProgressById.has(taskId);
    const status = statusById?.get(taskId);
    const cls = isParentWithProgress ? styles.barParent : status ? STATUS_BAR_CLASS[status] : "";
    const dragging = drag?.taskId === taskId && movedRef.current ? styles.barDragging : "";
    const selected = selectedIds.has(taskId) ? styles.barSelected : "";
    // Parent (work-package) rows keep the rollup behaviour (their span still auto-
    // encloses their children) but render as an ordinary, legible task bar — the
    // hollow "bracket summary" look was reverted per feedback #97 (見づらい). The
    // parent/child vs dependency distinction is carried by indent + tree lines +
    // the dashed dependency arrows + the legend, not by a special bar shape.
    return `${styles.bar} ${cls} ${dragging} ${selected}`;
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

  const clearSelection = useCallback(() => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  // ---- 外側クリックで選択解除 (⑤b) ----
  // Once a marquee selection exists, a pointer-down anywhere that is NOT a selected row/
  // bar, the bulk-action bar, or an additive (Shift/⌘/Ctrl) gesture clears it — so a stray
  // click on empty space or another task drops the selection instead of it lingering.
  // Capture phase so it runs regardless of a target's own stopPropagation (bars do), and
  // BEFORE dnd-kit arms a group drag off a selected row (which is data-marked to be kept).
  // Skipped while the bulk-delete confirm is open (its buttons act on the selection).
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onDown = (e: PointerEvent) => {
      if (bulkDeleteOpen) return;
      if (e.button !== 0) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) return; // additive — keep building the set
      const el = e.target as HTMLElement | null;
      if (el && el.closest("[data-fe4-keep-selection]")) return; // selected row/bar or the action bar
      // The timeline canvas owns its own clear/create priority (onCanvasBackgroundClick +
      // the marquee session) — defer to it so a deselect-click there never spawns a task.
      if (el && el.closest("[data-fe4-gantt-canvas]")) return;
      clearSelection();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [selectedIds, bulkDeleteOpen, clearSelection]);

  // ---- marquee (範囲ドラッグ) pointer session on the timeline body ----
  // Starts on a pointer-down over the empty canvas (bars stopPropagation their own
  // pointer-down, so this only fires on background). While dragging we draw the
  // rectangle; on release, every bar it touches is selected (union when Shift/⌘/Ctrl
  // is held). A drag that never crosses the click threshold is treated as a plain
  // click (create / clear) — see onCanvasBackgroundClick.
  const onBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (!interactive) return; // 拡大（全画面）閲覧モードは look-only — 範囲選択させない
    if (drag) return; // a bar drag owns the pointer
    // Fresh gesture — clear any stale "a marquee just ended" flag so it can never
    // swallow a later genuine background click (create / clear).
    marqueeConsumedClickRef.current = false;
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const origin = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let moved = false;
    const barsSnapshot = bars;
    const move = (ev: PointerEvent) => {
      const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      const r = normalizeRect(origin, cur);
      if (rectIsDrag(r)) moved = true;
      setMarquee(r);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMarquee(null);
      if (!moved) return; // a plain click — let the click handler decide (create/clear)
      marqueeConsumedClickRef.current = true;
      const r = normalizeRect(origin, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      const hit = barsInRect(barsSnapshot, r);
      setSelectedIds((prev) => (additive ? unionIds(prev, hit) : new Set(hit)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // click an empty timeline cell -> create with that day preset (or clear a selection)
  const onCanvasBackgroundClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Swallow the click that ends a marquee drag (it isn't a create/clear intent).
    if (marqueeConsumedClickRef.current) {
      marqueeConsumedClickRef.current = false;
      return;
    }
    // ⑤b: while a selection is active, a click anywhere on the timeline that is NOT on a
    // bar (or a kept-selection element) clears it — including the decorative layers that
    // fill the canvas (row lines / weekend shading / 内包ゾーン / today line / connectors),
    // whose clicks previously did nothing because they aren't the exact canvas node. Only
    // bar / selected-row / action-bar clicks are excluded from deselect.
    if (selectedIds.size > 0) {
      const el = e.target as HTMLElement | null;
      const onBar = !!el?.closest?.('[data-testid^="fe4-gantt-bar-"]');
      const keep = !!el?.closest?.("[data-fe4-keep-selection]");
      if (onBar || keep) return;
      clearSelection();
      return;
    }

    if (!editing || !onCreateOnDate) return;
    if (e.target !== e.currentTarget) return; // create only on the bare canvas, never a bar
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const day = dayAtX(x, win);
    onCreateOnDate(new Date(day).toISOString());
  };

  // ---- keyboard: bulk ops on the marquee selection ----
  // Backspace/Delete → confirm then bulk delete; ←/→ → shift dates by ±1 day; ↑/↓ →
  // reorder (手動 mode only); Esc → clear. Guarded so typing in a field never fires,
  // and skipped while the confirm dialog is open (its own buttons drive delete).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selectedIds.size === 0 || bulkDeleteOpen) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (t && t.isContentEditable)
      ) {
        // typing in a field — never hijack its own keys (except Esc-to-clear stays off here).
        return;
      }
      if (e.key === "Escape") {
        clearSelection();
        return;
      }
      if (!canWrite) return;
      if ((e.key === "Backspace" || e.key === "Delete") && onBulkDelete) {
        e.preventDefault();
        setBulkDeleteOpen(true);
        return;
      }
      if (e.key === "ArrowLeft" && onBulkShiftDays) {
        e.preventDefault();
        onBulkShiftDays([...selectedIds], -1);
        return;
      }
      if (e.key === "ArrowRight" && onBulkShiftDays) {
        e.preventDefault();
        onBulkShiftDays([...selectedIds], 1);
        return;
      }
      if (e.key === "ArrowUp" && sortMode === "manual" && onBulkMoveVertical) {
        e.preventDefault();
        onBulkMoveVertical([...selectedIds], -1);
        return;
      }
      if (e.key === "ArrowDown" && sortMode === "manual" && onBulkMoveVertical) {
        e.preventDefault();
        onBulkMoveVertical([...selectedIds], 1);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, bulkDeleteOpen, canWrite, sortMode, onBulkDelete, onBulkShiftDays, onBulkMoveVertical, clearSelection]);

  const confirmBulkDelete = () => {
    const ids = [...selectedIds];
    onBulkDelete?.(ids);
    setBulkDeleteOpen(false);
    clearSelection();
  };

  const effLeftW = collapsed ? 0 : leftW;

  return (
    <div
      ref={rootRef}
      data-testid="fe4-gantt-view"
      className={`${styles.ganttView} ${presenting ? styles.ganttPresenting : ""}`}
      data-presenting={presenting ? "1" : undefined}
    >
      {/* Notion-style toolbar: view name + jump-to-today + granularity */}
      <div className={styles.tlToolbar}>
        <div className={styles.tlToolbarLeft}>
          <span className={styles.tlViewName}>タイムライン</span>
          <span className={styles.tlCount}>{rows.length} 件</span>
          {presenting && (
            <span className={styles.tlViewBadge} data-testid="fe4-gantt-viewonly-badge">
              閲覧モード（編集不可）
            </span>
          )}
        </div>
        <div className={styles.tlToolbarRight}>
          {/* 並び替えは編集寄りの操作なので閲覧（拡大）モードでは隠す */}
          {onSortModeChange && !presenting && (
            <label className={styles.tlSort}>
              <span className={styles.tlSortLabel}>並び替え</span>
              <Select<GanttSortMode>
                id="fe4-gantt-sort"
                value={sortMode}
                onChange={onSortModeChange}
                options={GANTT_SORT_OPTIONS as SelectOption<GanttSortMode>[]}
                aria-label="タスクの並び替え"
                testId="fe4-gantt-sort"
              />
            </label>
          )}
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
          {presenting ? (
            <button
              type="button"
              className={styles.tlPresentBtn}
              onClick={exitPresent}
              aria-label="全画面を終了"
              title="全画面を終了（Esc）"
              data-testid="fe4-gantt-fullscreen-exit"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
                <path d="M9 9L4 4M9 9V5M9 9H5M15 9l5-5M15 9V5M15 9h4M9 15l-5 5M9 15v4M9 15H5M15 15l5 5M15 15v4M15 15h4"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>閉じる</span>
            </button>
          ) : (
            <button
              type="button"
              className={styles.tlPresentBtn}
              onClick={enterPresent}
              aria-label="ガントを全画面で表示（閲覧モード）"
              title="拡大（全画面でガントだけを表示・見るだけ）"
              data-testid="fe4-gantt-fullscreen-btn"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>拡大</span>
            </button>
          )}
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
          親の内包枠（展開時＝子を囲む・入れ子対応）
        </span>
        <span className={styles.tlGuideItem}>
          <svg className={styles.tlGuideDepIcon} width="28" height="12" aria-hidden>
            <defs>
              <marker id="fe4-legend-arrow" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
                <path d="M0,0 L7,4.5 L0,9 Z" className={styles.tlDepArrow} />
              </marker>
            </defs>
            <path d="M1,6 H20" fill="none" className={styles.tlDep} markerEnd="url(#fe4-legend-arrow)" />
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
                {/* Drag-to-reorder via the shared @dub/ui SortableList: the floating
                    clone (renderOverlay), the neighbour reflow, and keyboard a11y all
                    live there — this view supplies the rows and commits the drop. */}
                <SortableList<gantt.GanttRow>
                  items={rows}
                  getItemId={(r) => r.taskId}
                  disabled={!reorderEnabled}
                  onReorder={onRowReorder}
                  computeNextOrder={computeGroupOrder}
                  // ⑤a: when a marquee multi-selection is grabbed, the whole set rides as one
                  // deck — tell SortableList so the reflow opens a gap as tall as the number of
                  // floating rows (not a fixed single row). Only meaningful while >1 is selected.
                  liftedIds={selectedIds.size > 1 ? [...selectedIds] : undefined}
                  aria-label="タスクの並び替え"
                  renderItem={(r, ctx) => {
                    // Group drag in flight: the grabbed row rides the floating overlay (hidden
                    // in place by SortableList); every OTHER selected row dims in place so the
                    // whole marquee selection reads as "lifted" together (⑤a).
                    const groupDragging =
                      ctx.dragActiveId != null &&
                      selectedIds.size > 1 &&
                      selectedIds.has(ctx.dragActiveId as common.TaskId);
                    const lifting = groupDragging && selectedIds.has(r.taskId) && r.taskId !== ctx.dragActiveId;
                    return (
                      <LeftPaneRow
                        r={r}
                        isOpen={openParents.has(r.taskId)}
                        dragEnabled={reorderEnabled}
                        grouped={hasGroupRail}
                        selected={selectedIds.has(r.taskId)}
                        lifting={lifting}
                        dragHandleProps={ctx.dragHandleProps}
                        number={numberById?.get(r.taskId)}
                        onSelect={interactive ? onSelect : undefined}
                        toggleParent={toggleParent}
                        statusById={statusById}
                        assigneeNameById={assigneeNameById}
                      />
                    );
                  }}
                  renderOverlay={(r) => {
                    // A single mini-row clone (the visual used both alone and stacked).
                    const cloneRow = (row: gantt.GanttRow, key?: string) => (
                      <div key={key} className={styles.tlRowOverlay} style={{ width: leftW, height: ROW_HEIGHT }}>
                        <span className={styles.tlRowDrag} aria-hidden>⠿</span>
                        {teamColorById?.get(row.taskId) && (
                          <span className={styles.tlTeamStripe} style={{ background: teamColorById.get(row.taskId) }} aria-hidden />
                        )}
                        <span className={`${styles.tlDot} ${statusById?.get(row.taskId) ? STATUS_BAR_CLASS[statusById.get(row.taskId)!] : ""}`} aria-hidden />
                        {numberById?.get(row.taskId) && <span className={styles.tlRowNum}>{numberById.get(row.taskId)}</span>}
                        <span className={styles.tlRowName}>{row.title}</span>
                      </div>
                    );
                    // Group drag (⑤a): float the WHOLE selection as a stacked deck under the
                    // cursor — every selected row (in visible order) lifts, not just the grabbed
                    // one. A count badge names how many are moving.
                    if (selectedIds.size > 1 && selectedIds.has(r.taskId)) {
                      const picked = rows.filter((row) => selectedIds.has(row.taskId));
                      return (
                        <div className={styles.tlRowOverlayStack} style={{ width: leftW }} data-testid="fe4-gantt-drag-overlay">
                          <span className={styles.tlRowOverlayCount} data-testid="fe4-gantt-drag-overlay-count">{picked.length}</span>
                          {picked.map((row) => cloneRow(row, row.taskId))}
                        </div>
                      );
                    }
                    return (
                      <div data-testid="fe4-gantt-drag-overlay">{cloneRow(r)}</div>
                    );
                  }}
                />
                {/* team accent rail: fixed-x straight segments (one per contiguous team run) */}
                {teamRailRuns.length > 0 && (
                  <div className={styles.tlTeamRail} style={{ top: HEADER_H }} data-testid="fe4-gantt-team-rail" aria-hidden>
                    {teamRailRuns.map((run) => (
                      <div
                        key={`${run.key}-${run.startIndex}`}
                        className={styles.tlTeamRailSeg}
                        style={{ top: run.startIndex * ROW_HEIGHT, height: run.length * ROW_HEIGHT, background: run.color }}
                        data-testid={`fe4-gantt-team-seg-${run.startIndex}`}
                      />
                    ))}
                  </div>
                )}
                {/* sort grouping brackets: one labelled bracket per contiguous same-group run */}
                {hasGroupRail && (
                  <div className={styles.tlGroupRail} style={{ top: HEADER_H }} data-testid="fe4-gantt-group-rail" aria-hidden>
                    {groupRunList.map((run) => {
                      const fill = run.color ?? "var(--dub-color-gray-500)";
                      const text = readableTextColor(run.color);
                      return (
                        <div
                          key={`${run.key}-${run.startIndex}`}
                          className={styles.tlGroupBracket}
                          style={{ top: run.startIndex * ROW_HEIGHT + 3, height: run.length * ROW_HEIGHT - 6, background: fill }}
                          data-testid={`fe4-gantt-group-bracket-${run.key}`}
                          title={run.label}
                        >
                          <span className={styles.tlGroupBracketLabel} style={{ color: text }}>
                            {run.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {editing && onCreateOnDate && (
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
                ref={bodyRef}
                className={styles.tlBody}
                style={{ width, height: rowsH }}
                onClick={onCanvasBackgroundClick}
                onPointerDown={onBodyPointerDown}
                data-testid="fe4-gantt-body"
                data-fe4-gantt-canvas="true"
              >
                {/* weekend shading (painted FIRST, behind the parent enclosure) */}
                {weekends.map((b) => (
                  <div key={b.key} className={styles.tlWeekend} style={{ left: b.x, width: b.width, height: rowsH }} aria-hidden />
                ))}
                {/* row lines / hover stripes */}
                {rows.map((_, i) => (
                  <div key={i} className={styles.tlRowLine} style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }} aria-hidden />
                ))}
                {/* 内包ゾーン: an open parent's bar grows to a container that encloses its
                    subtree (nested boxes for 3–4 level WBS). Row order is shallow-first, so a
                    grandparent paints before (behind) the inner parent's smaller box.
                    Rendered AFTER weekend shading + row lines so the parent-colour zone is
                    CONTINUOUS across weekend columns (the grey 休日 stripes no longer paint
                    over it, which made the zone look cut off / colourless on weekends). Still
                    below the bars/connectors, which are drawn later + on higher z-indexes. */}
                {enclosures.map((e) => (
                  <div
                    key={`grp-${e.taskId}`}
                    className={styles.tlEncl}
                    style={{
                      top: e.top + 2,
                      height: e.height - 4,
                      left: e.left,
                      width: e.boxW,
                      // Header-lane fill: a stronger band over the parent's own row (first
                      // ROW_HEIGHT) that steps down to the淡い body tint over the children —
                      // so the zone reads "親ヘッダ＋その配下" without relying on the faint border.
                      background: `linear-gradient(180deg,
                        color-mix(in srgb, var(--dub-color-brand-500) ${e.headerPct}%, transparent) 0px,
                        color-mix(in srgb, var(--dub-color-brand-500) ${e.headerPct}%, transparent) ${ROW_HEIGHT - 2}px,
                        color-mix(in srgb, var(--dub-color-brand-500) ${e.bodyPct}%, transparent) ${ROW_HEIGHT - 2}px,
                        color-mix(in srgb, var(--dub-color-brand-500) ${e.bodyPct}%, transparent) 100%)`,
                    }}
                    data-testid={`fe4-gantt-group-${e.taskId}`}
                    data-depth={e.depth}
                    aria-hidden
                  />
                ))}

                {/* dependency connectors (前工程 → 後工程) */}
                {segs.length > 0 && (
                  <svg width={width} height={rowsH} className={styles.tlSvg} aria-hidden>
                    <defs>
                      <marker id="fe4-arrow" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
                        <path d="M0,0 L7,4.5 L0,9 Z" className={styles.tlDepArrow} />
                      </marker>
                    </defs>
                    {segs.map((s) => {
                      // Vertical-first routing (縦→横): drop DOWN/UP out of the predecessor
                      // end first, then run horizontally into the successor — the elbow's
                      // corner sits near the predecessor, not the successor.
                      // Cross-hierarchy target (folded parent) → drop out vertically, cross
                      // at mid-height, then meet the bar's top/bottom edge with a final
                      // vertical drop (head touches the edge from above/below, no pierce).
                      // Same-level FS target → vertical then horizontal into the left edge.
                      const d = s.dropOntoBar
                        ? `M ${s.x1} ${s.y1} V ${(s.y1 + s.dropEdgeY) / 2} H ${s.x2} V ${s.dropEdgeY}`
                        : `M ${s.x1} ${s.y1} V ${s.y2} H ${s.x2}`;
                      const cls = s.aggregated ? `${styles.tlDep} ${styles.tlDepAgg}` : styles.tlDep;
                      return (
                        <path
                          key={s.id}
                          d={d}
                          fill="none"
                          className={cls}
                          markerEnd="url(#fe4-arrow)"
                          data-testid={`fe4-gantt-dep-${s.id}`}
                          data-aggregated={s.aggregated ? "1" : undefined}
                          data-mid-anchor={s.mid ? "true" : undefined}
                        >
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
                  const title = titleById.get(b.taskId) ?? "";
                  // Parent bars are painted by their children's status mix (完了/進行中/
                  // 未着手…) instead of one flat progress fill, plus a "n/m 完了" count.
                  const prog = childProgressById.get(b.taskId);
                  const countText = prog ? `${prog.doneCount}/${prog.total} 完了` : null;
                  const barTitle = prog
                    ? `${title} — 子タスク ${prog.doneCount}/${prog.total} 完了` +
                      (prog.inProgressCount ? `・進行中 ${prog.inProgressCount}` : "")
                    : title;
                  return (
                    <div
                      key={b.taskId}
                      className={barClassOf(b.taskId)}
                      style={{ left: g.left, top: b.y + (ROW_HEIGHT - BAR_HEIGHT) / 2, width: g.width, height: BAR_HEIGHT }}
                      title={barTitle}
                      data-testid={`fe4-gantt-bar-${b.taskId}`}
                      data-child-done={prog ? prog.doneCount : undefined}
                      data-child-total={prog ? prog.total : undefined}
                      onPointerDown={(e) => beginDrag(e, b, "move")}
                      {...(selectedIds.has(b.taskId) ? { "data-fe4-keep-selection": "true" } : {})}
                    >
                      {teamColorById?.get(b.taskId) && (
                        <span className={styles.barTeamCap} style={{ background: teamColorById.get(b.taskId) }} aria-hidden />
                      )}
                      {prog ? (
                        // stacked per-status slices (design 案A — 割合の積み上げ)
                        <div className={styles.barSegTrack} aria-hidden data-testid={`fe4-gantt-segs-${b.taskId}`}>
                          {prog.segments.map((s) => (
                            <span
                              key={s.status}
                              className={`${styles.barSeg} ${STATUS_SEG_CLASS[s.status]}`}
                              style={{ width: `${s.fraction * 100}%` }}
                              data-status={s.status}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className={styles.barProgress} style={{ width: `${b.progressPercent}%` }} aria-hidden />
                      )}
                      {editing && onSchedule && (
                        <span
                          className={styles.barHandle + " " + styles.barHandleL}
                          data-testid={`fe4-gantt-bar-${b.taskId}-rz-l`}
                          onPointerDown={(e) => beginDrag(e, b, "resize-start")}
                          aria-hidden
                        />
                      )}
                      {showInside && (
                        <span className={styles.barLabel}>
                          {title}
                          {countText && (
                            <span className={styles.barCount} data-testid={`fe4-gantt-count-${b.taskId}`}>
                              {countText}
                            </span>
                          )}
                        </span>
                      )}
                      {editing && onSchedule && (
                        <span
                          className={styles.barHandle + " " + styles.barHandleR}
                          data-testid={`fe4-gantt-bar-${b.taskId}-rz-r`}
                          onPointerDown={(e) => beginDrag(e, b, "resize-end")}
                          aria-hidden
                        />
                      )}
                      {!showInside && (
                        <span className={styles.barLabelOut} style={{ left: g.width + 8 }}>
                          {title}
                          {countText && (
                            <span className={styles.barCount} data-testid={`fe4-gantt-count-${b.taskId}`}>
                              {countText}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* marquee (範囲ドラッグ) rectangle while selecting */}
                {marquee && (
                  <div
                    className={styles.tlMarquee}
                    style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }}
                    data-testid="fe4-gantt-marquee"
                    aria-hidden
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* selection action hint — surfaces the available bulk ops (keyboard/drag) */}
      {selectedIds.size > 0 && (
        <div className={styles.tlSelectionBar} role="status" data-testid="fe4-gantt-selection-bar" data-fe4-keep-selection="true">
          <span className={styles.tlSelectionCount} data-testid="fe4-gantt-selection-count">
            {selectedIds.size} 件選択中
          </span>
          <span className={styles.tlSelectionHint}>
            ←→ で移動{sortMode === "manual" ? " ・ ↑↓ で並べ替え" : ""} ・ Backspace で削除 ・ Esc で解除
          </span>
          {canWrite && onBulkDelete && (
            <button
              type="button"
              className={styles.tlSelectionDelete}
              onClick={() => setBulkDeleteOpen(true)}
              data-testid="fe4-gantt-selection-delete"
            >
              削除
            </button>
          )}
          <button
            type="button"
            className={styles.tlSelectionClear}
            onClick={clearSelection}
            data-testid="fe4-gantt-selection-clear"
          >
            選択解除
          </button>
        </div>
      )}

      <ConfirmDialog
        open={bulkDeleteOpen}
        title="タスクを削除"
        message={`${selectedIds.size}件のタスクを削除しますか？取り消せません。`}
        confirmLabel="削除"
        cancelLabel="キャンセル"
        danger
        onConfirm={confirmBulkDelete}
        onCancel={() => setBulkDeleteOpen(false)}
        testId="fe4-gantt-bulk-delete-confirm"
      />
    </div>
  );
}
