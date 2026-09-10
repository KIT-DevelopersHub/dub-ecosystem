// Inline 編集モード for one Home dashboard region (P3-3). Replaces the old separate
// カスタマイズ modal: instead of reordering abstract label rows in a dialog, the
// viewer taps "編集" and the REAL widgets on the dashboard itself become the
// draggable rows — iOS ホーム画面編集 style (light jiggle + dashed frame + a grip
// handle + a per-widget hide toggle). Tapping "完了" commits and exits.
//
// `SortableList` (@dub/ui) is the one drag primitive per FRONTEND_GUIDE "並べ替え UI"
// — it already provides pointer AND keyboard (Space/↑↓/Space) dragging with a11y
// live-region announcements, so this component only supplies the per-item chrome and
// the region-scoped ordering rule (`mergeRegionOrder` never moves a widget across
// regions). Not editing ⇒ a plain, layout-neutral render of the visible widgets only
// (identical DOM shape to before P3-3, so the resting dashboard is unchanged).
import { cloneElement, Fragment } from "react";
import { Icon, SegmentedControl, SortableList, type SortableReorderEvent } from "@dub/ui";
import { useUiStore } from "../../../store/uiStore.tsx";
import {
  computeBlocks,
  computeDensePositions,
  isResizableWidget,
  mergeRegionOrder,
  positionStyle,
  regionOrdered,
  sizeOf,
  spanStyle,
  swapBlocks,
  visibleRegion,
  WIDGET_SIZE_SPAN,
  type HomeRegion,
  type HomeWidgetMeta,
  type WidgetSize,
} from "./homeLayout.ts";
import { useGridColumns } from "./useGridColumns.ts";

const SIZE_OPTIONS: { value: WidgetSize; label: string }[] = [
  { value: "small", label: "小" },
  { value: "medium", label: "中" },
  { value: "large", label: "大" },
];

export function HomeEditableRegion({
  region,
  catalog,
  nodes,
  isEditing,
  className,
  regionLabel,
  testId,
  containerAriaLabel,
}: {
  region: HomeRegion;
  catalog: HomeWidgetMeta[];
  /** Rendered node per widget id (the SAME node used outside edit mode). */
  nodes: Record<string, JSX.Element>;
  isEditing: boolean;
  /** Class on the region's own container — kept identical in and out of edit mode so
   *  the grid/flex layout (KPI row / card grid / side rail) never shifts. */
  className?: string;
  /** aria-label for the sortable list while editing (announced by dnd-kit). */
  regionLabel: string;
  /** testid on the region's own container — stable across edit-mode toggles (defaults
   *  to `fe2-home-region-<region>`) so a caller/E2E test never has to branch on state. */
  testId?: string;
  /** aria-label applied to the resting (non-editing) container, if the region needs one
   *  (the apps/cards/side regions carry their own labelled elements already). */
  containerAriaLabel?: string;
}): JSX.Element {
  const order = useUiStore((s) => s.homeLayout.order);
  const hidden = useUiStore((s) => s.homeLayout.hidden);
  const sizes = useUiStore((s) => s.homeLayout.sizes);
  const setHomeWidgetHidden = useUiStore((s) => s.setHomeWidgetHidden);
  const setHomeWidgetOrder = useUiStore((s) => s.setHomeWidgetOrder);
  const setHomeWidgetSize = useUiStore((s) => s.setHomeWidgetSize);
  const hiddenSet = new Set(hidden);
  const resolvedTestId = testId ?? `fe2-home-region-${region}`;
  // Fallback column count BEFORE the container is measured (first paint / no
  // ResizeObserver support) — matches this region's declared `grid-template-columns`
  // at the desktop breakpoint (see global.css .fe2-kpi-row / .fe2-home-side); the live
  // measurement below self-corrects at narrower breakpoints.
  const fallbackColumns = region === "kpi" ? 6 : 2;
  const { ref: containerRef, columns } = useGridColumns(fallbackColumns);
  const spanOfId = (id: string): { col: number; row: number } => {
    const meta = catalog.find((w) => w.id === id);
    return meta && isResizableWidget(meta) ? WIDGET_SIZE_SPAN[sizeOf(catalog, sizes, id)] : { col: 1, row: 1 };
  };

  if (!isEditing) {
    // Resting dashboard: visible widgets only, in the saved order — no drag machinery.
    // Each resizable widget's rendered node gets an EXPLICIT grid placement computed by
    // the SAME `computeDensePositions` simulation `computeBlocks`/`swapBlocks` (below)
    // reason about while editing — not a second, independent `dense` auto-placement
    // pass that could disagree with it (see homeLayout.ts module doc: that exact
    // disagreement is why the previous two swap fixes read as broken to a real user).
    const visible = visibleRegion(catalog, order, hidden, region);
    const positions = computeDensePositions(
      visible.map((w) => w.id),
      spanOfId,
      columns,
    );
    return (
      <div
        ref={containerRef}
        className={className}
        data-testid={resolvedTestId}
        {...(containerAriaLabel ? { "aria-label": containerAriaLabel } : {})}
      >
        {visible.map((w) => {
          const node = nodes[w.id];
          if (!node) return null;
          if (!isResizableWidget(w)) return <Fragment key={w.id}>{node}</Fragment>;
          const pos = positions.get(w.id);
          const size = sizeOf(catalog, sizes, w.id);
          const existingStyle = (node.props as { style?: object }).style;
          const style = pos ? { ...existingStyle, ...positionStyle(pos, size) } : undefined;
          return <Fragment key={w.id}>{style ? cloneElement(node, { style }) : node}</Fragment>;
        })}
      </div>
    );
  }

  // Editing: EVERY widget of the region, hidden or not (hidden ones render dimmed
  // with a "表示する" toggle so removing one is reversible without leaving edit mode).
  const items = regionOrdered(catalog, order, region);
  if (items.length === 0) return <></>;

  // Swappable row-units for THIS render's order/sizes/columns — see homeLayout.ts
  // module doc. A drop exchanges the whole block the dragged widget belongs to with
  // the whole block its drop target belongs to (never a lone id), so e.g. dragging a
  // "medium" onto one of two "small" tiles trades it with BOTH smalls' row — matching
  // what dense packing actually painted as "this row" — and leaves every other row's
  // widgets untouched.
  const blocks = computeBlocks(
    items.map((w) => w.id),
    spanOfId,
    columns,
  );
  const positions = computeDensePositions(
    items.map((w) => w.id),
    spanOfId,
    columns,
  );

  const onReorder = (e: SortableReorderEvent): void => {
    const next = swapBlocks(blocks, e.activeId, e.overId);
    setHomeWidgetOrder(mergeRegionOrder(catalog, order, region, next));
  };

  return (
    <SortableList<HomeWidgetMeta>
      items={items}
      getItemId={(w) => w.id}
      onReorder={onReorder}
      // Supply the FULL next id order synchronously (dnd-kit's default single-item
      // arrayMove is wrong here — see module doc) so the optimistic re-render and the
      // persisted order always agree, and so every OTHER widget whose block moved as a
      // side effect of the swap (e.g. a dragged medium's pair-mate) FLIPs into its new
      // slot instead of popping.
      computeNextOrder={(activeId, overId) => swapBlocks(blocks, activeId, overId)}
      className={className}
      aria-label={`${regionLabel}の並べ替え`}
      testId={resolvedTestId}
      containerRef={containerRef}
      // The region's own className is a CSS Grid (kpi-row / cards / side rail), not a
      // single vertical stack — `rect` reflows by intersecting rectangles (correct for
      // any grid), where the default `vertical` strategy assumes one column and computes
      // the wrong offsets across multiple columns (the visible bug: neighbours overlap /
      // the dragged tile paints behind another one mid-reflow).
      strategy="rect"
      // Explicit placement (line + span), not `spanStyle`'s span-only — see module doc:
      // this pins each row to the SAME simulated cell `computeBlocks`/`swapBlocks`
      // reasoned about, so the drag preview and the committed swap always agree.
      getItemStyle={(w) => {
        if (!isResizableWidget(w)) return undefined;
        const pos = positions.get(w.id);
        return pos ? positionStyle(pos, sizeOf(catalog, sizes, w.id)) : spanStyle(sizeOf(catalog, sizes, w.id));
      }}
      renderItem={(w, ctx) => {
        const isHidden = hiddenSet.has(w.id);
        const resizable = isResizableWidget(w);
        const size = sizeOf(catalog, sizes, w.id);
        return (
          <div
            className="fe2-widget-edit"
            data-testid={`fe2-widget-edit-${w.id}`}
            data-hidden={isHidden}
            data-dragging={ctx.isDragging || undefined}
            data-size={resizable ? size : undefined}
          >
            <button
              type="button"
              className="fe2-widget-edit-hide"
              aria-pressed={!isHidden}
              aria-label={isHidden ? `${w.label}を表示する` : `${w.label}を非表示にする`}
              data-testid={`fe2-widget-hide-${w.id}`}
              onClick={() => setHomeWidgetHidden(w.id, !isHidden)}
            >
              <Icon name={isHidden ? "plus" : "x"} />
            </button>
            <span
              className="fe2-widget-edit-handle"
              aria-label={`${w.label}をドラッグして並べ替え`}
              data-testid={`fe2-widget-handle-${w.id}`}
              {...ctx.dragHandleProps}
            >
              <Icon name="drag" />
            </span>
            <div className="fe2-widget-edit-inner" data-hidden={isHidden} aria-hidden={isHidden || undefined}>
              {nodes[w.id]}
            </div>
            {resizable ? (
              <SegmentedControl<WidgetSize>
                className="fe2-widget-edit-sizes"
                size="sm"
                value={size}
                onChange={(next) => setHomeWidgetSize(w.id, next)}
                aria-label={`${w.label}のサイズ`}
                testId={`fe2-widget-size-${w.id}`}
                options={SIZE_OPTIONS.map((o) => ({ ...o, testId: `fe2-widget-size-${w.id}-${o.value}` }))}
              />
            ) : null}
          </div>
        );
      }}
    />
  );
}
