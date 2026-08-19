import { useCallback, useState, type ReactNode, type CSSProperties, type HTMLAttributes } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cx } from "../utils/cx";
import styles from "./SortableList.module.css";

// SortableList — the design-system's one drag-to-reorder primitive. It bundles the
// whole "picked-up card" interaction so every list reorders the same way:
//   • the dragged row lifts into a floating DragOverlay clone (elevation + slight
//     scale) that follows the cursor,
//   • its neighbours reflow — sliding via transform to open a gap at the drop target
//     (verticalListSortingStrategy) that the clone settles into,
//   • the in-place row is hidden so its slot reads as that gap,
//   • pointer AND keyboard dragging (Space/↑↓/Space) with dnd-kit's live-region
//     announcements — accessible by default.
//
// It stays layout-agnostic: the consumer owns the item markup via `renderItem` and
// commits the order in `onReorder` (raw indices — a flat list can arrayMove; a tree
// can scope the move to siblings). The float is honoured under
// `prefers-reduced-motion` (the scale is dropped; see the CSS module). See
// FRONTEND_GUIDE "並べ替え UI" — reorder UIs should use this, not a bespoke DnD.

/** Props to spread on the element that starts a drag (a handle) — dnd-kit's pointer +
 *  keyboard listeners and the sortable ARIA attributes. Spread on the item root itself
 *  to make the whole row draggable. */
export type SortableDragHandleProps = HTMLAttributes<HTMLElement>;

export interface SortableItemContext {
  /** true for the in-place node of the row currently being dragged (rendered as a gap). */
  isDragging: boolean;
  /** Spread onto the drag handle (or the item root) to make it grab the pointer/keyboard. */
  dragHandleProps: SortableDragHandleProps;
}

export interface SortableReorderEvent {
  /** id of the dragged item. */
  activeId: string;
  /** id of the item it was dropped onto (the drop target). */
  overId: string;
  /** index of the dragged item BEFORE the move. */
  oldIndex: number;
  /** index of the drop target — where the dragged item lands in the preview. */
  newIndex: number;
}

export interface SortableListProps<T> {
  /** The ordered items (their order IS the rendered order). */
  items: readonly T[];
  /** Stable unique id for an item — the dnd-kit key. */
  getItemId: (item: T) => string;
  /** Render one item. Spread `ctx.dragHandleProps` on the handle; read `ctx.isDragging`. */
  renderItem: (item: T, ctx: SortableItemContext) => ReactNode;
  /** The floating clone shown under the cursor. Defaults to the item's own render. */
  renderOverlay?: (item: T) => ReactNode;
  /** Commit the reorder. Receives raw indices/ids so the caller owns the ordering rule
   *  (flat arrayMove, or a sibling-scoped move in a tree). */
  onReorder: (event: SortableReorderEvent) => void;
  /** Turn dragging off entirely (handles inert, no reflow). */
  disabled?: boolean;
  /** Class on the list wrapper. */
  className?: string;
  /** Extra class on the floating overlay wrapper (which already carries the elevation). */
  overlayClassName?: string;
  testId?: string;
  "aria-label"?: string;
}

function SortableRow<T>({
  id,
  item,
  disabled,
  renderItem,
}: {
  id: string;
  item: T;
  disabled: boolean;
  renderItem: (item: T, ctx: SortableItemContext) => ReactNode;
}) {
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id, disabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hide the picked-up row so its reserved slot IS the gap the neighbours open and
    // the floating clone drops into (the clone carries the visible content instead).
    ...(isDragging ? { opacity: 0 } : null),
  };
  const dragHandleProps = (disabled ? {} : { ...attributes, ...(listeners ?? {}) }) as SortableDragHandleProps;
  return (
    <div ref={setNodeRef} style={style} className={styles.item} data-dragging={isDragging || undefined}>
      {renderItem(item, { isDragging, dragHandleProps })}
    </div>
  );
}

export function SortableList<T>({
  items,
  getItemId,
  renderItem,
  renderOverlay,
  onReorder,
  disabled = false,
  className,
  overlayClassName,
  testId,
  ...rest
}: SortableListProps<T>) {
  const ariaLabel = rest["aria-label"];
  const [activeId, setActiveId] = useState<string | null>(null);
  // Pointer needs a 4px slop so a plain click on the handle doesn't start a drag;
  // keyboard uses the sortable coordinate getter (Space to grab, arrows to move).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = items.map(getItemId);

  const onDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(e.active ? String(e.active.id) : null);
  }, []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null);
      const activeId = e.active ? String(e.active.id) : null;
      const overId = e.over ? String(e.over.id) : null;
      if (!activeId || !overId || activeId === overId) return;
      const oldIndex = items.findIndex((it) => getItemId(it) === activeId);
      const newIndex = items.findIndex((it) => getItemId(it) === overId);
      if (oldIndex < 0 || newIndex < 0) return;
      onReorder({ activeId, overId, oldIndex, newIndex });
    },
    [items, getItemId, onReorder],
  );

  const onDragCancel = useCallback(() => setActiveId(null), []);

  const activeItem = activeId != null ? items.find((it) => getItemId(it) === activeId) ?? null : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={className} data-testid={testId} aria-label={ariaLabel}>
          {items.map((item) => (
            <SortableRow key={getItemId(item)} id={getItemId(item)} item={item} disabled={disabled} renderItem={renderItem} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeItem ? (
          <div className={cx(styles.overlay, overlayClassName)}>
            {renderOverlay ? renderOverlay(activeItem) : renderItem(activeItem, { isDragging: false, dragHandleProps: {} })}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
