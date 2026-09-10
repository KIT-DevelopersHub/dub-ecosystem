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
import { Fragment } from "react";
import { Icon, SegmentedControl, SortableList, type SortableReorderEvent } from "@dub/ui";
import { useUiStore } from "../../../store/uiStore.tsx";
import {
  isResizableWidget,
  mergeRegionOrder,
  regionOrdered,
  sizeOf,
  spanStyle,
  visibleRegion,
  type HomeRegion,
  type HomeWidgetMeta,
  type WidgetSize,
} from "./homeLayout.ts";

const SIZE_OPTIONS: { value: WidgetSize; label: string }[] = [
  { value: "small", label: "小" },
  { value: "medium", label: "中" },
  { value: "large", label: "大" },
];

/** Move an id to a new index within a list (translate a drop into the region's next
 *  id order). Mirrors the P3-2 カスタマイズ modal's helper. */
function moveTo(ids: string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from === to) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return ids;
  next.splice(to, 0, moved);
  return next;
}

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

  if (!isEditing) {
    // Resting dashboard: visible widgets only, in the saved order — no wrapper divs,
    // no drag machinery. Same shape as pre-P3-3.
    const visible = visibleRegion(catalog, order, hidden, region);
    return (
      <div className={className} data-testid={resolvedTestId} {...(containerAriaLabel ? { "aria-label": containerAriaLabel } : {})}>
        {visible.map((w) => (
          <Fragment key={w.id}>{nodes[w.id]}</Fragment>
        ))}
      </div>
    );
  }

  // Editing: EVERY widget of the region, hidden or not (hidden ones render dimmed
  // with a "表示する" toggle so removing one is reversible without leaving edit mode).
  const items = regionOrdered(catalog, order, region);
  if (items.length === 0) return <></>;

  const onReorder = (e: SortableReorderEvent): void => {
    const ids = items.map((w) => w.id);
    const next = moveTo(ids, e.oldIndex, e.newIndex);
    setHomeWidgetOrder(mergeRegionOrder(catalog, order, region, next));
  };

  return (
    <SortableList<HomeWidgetMeta>
      items={items}
      getItemId={(w) => w.id}
      onReorder={onReorder}
      className={className}
      aria-label={`${regionLabel}の並べ替え`}
      testId={resolvedTestId}
      // The region's own className is a CSS Grid (kpi-row / cards / side rail), not a
      // single vertical stack — `rect` reflows by intersecting rectangles (correct for
      // any grid), where the default `vertical` strategy assumes one column and computes
      // the wrong offsets across multiple columns (the visible bug: neighbours overlap /
      // the dragged tile paints behind another one mid-reflow).
      strategy="rect"
      // Give every resizable widget's SortableList row the same CSS Grid span its
      // resting-dashboard node carries (see spanStyle/sizeOf) — so 編集モード's grid
      // keeps mixing sizes exactly like the resting one, and the floating DragOverlay
      // clone (sized from THIS row, see SortableList) matches the tile's real footprint.
      getItemStyle={(w) => (isResizableWidget(w) ? spanStyle(sizeOf(catalog, sizes, w.id)) : undefined)}
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
