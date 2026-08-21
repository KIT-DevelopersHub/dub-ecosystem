import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties, type HTMLAttributes } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
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
  /** id of the row currently grabbed (any row, not just this one), or null when idle.
   *  Lets a consumer render the OTHER rows of a multi-selection as "lifted" while a
   *  group drag is in flight — the grabbed row rides the floating overlay. Additive;
   *  consumers that don't need it can ignore it. */
  dragActiveId: string | null;
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
  /** Optional: compute the FULL next id order for a drop — used for MULTI-row (group)
   *  drops where the default single-item `arrayMove` is wrong. Return the complete
   *  ordered id list to render optimistically, or `null` to fall back to the single-row
   *  arrayMove. When this returns a custom order, the rows that move (other than the
   *  grabbed one, which the floating clone settles) animate together via a FLIP
   *  transition — so a whole marquee selection slides into place at once (honoured
   *  against prefers-reduced-motion). */
  computeNextOrder?: (activeId: string, overId: string, currentIds: string[]) => string[] | null;
  /** Ids that ride together as ONE group when any of them is grabbed (e.g. a marquee
   *  multi-selection). When a drag starts on a member and the group has >1 id, the OTHER
   *  members collapse to zero height (they "join the floating deck") and the grabbed row's
   *  placeholder grows to the group's row-count — so the reflow opens a MULTI-row gap that
   *  matches how many rows are floating, not a fixed single row (⑤a). Omit / length ≤ 1 ⇒
   *  classic single-row behaviour (unchanged). Pair with `computeNextOrder` for the drop
   *  order + `renderOverlay` for the stacked deck clone. */
  liftedIds?: readonly string[];
  /** Turn dragging off entirely (handles inert, no reflow). */
  disabled?: boolean;
  /** Class on the list wrapper. */
  className?: string;
  /** Extra class on the floating overlay wrapper (which already carries the elevation). */
  overlayClassName?: string;
  testId?: string;
  "aria-label"?: string;
}

// Drop "settle" feel: the picked-up clone eases from where it was released into its
// new slot (never back to the source — the list is already reordered synchronously).
// Tuned to feel deliberate but not sluggish; kept as named constants so the feel is
// trivial to re-tune. Honoured against prefers-reduced-motion (instant when reduced).
//
// The clone travels for the full duration on a long-tailed ease-out so it keeps
// decelerating right up to the last frame — no abrupt "snap into place" at the end
// (feedback: 最後までアニメーションが続いてほしい). At the very end dnd-kit unmounts the
// floating clone and reveals the real row; that hand-off is cross-faded (the revealed
// row fades in — see `.item` opacity transition in the CSS module) so the landing reads
// as one continuous motion instead of a clone→row pop.
const SORTABLE_DROP_DURATION_MS = 280;
const SORTABLE_DROP_EASING = "cubic-bezier(0.16, 1, 0.3, 1)"; // easeOutExpo: brisk lift-off, long gentle settle to the last frame
// Reveal cross-fade: after the clone lands and unmounts, the real row fades IN over this
// window (see SortableRow) so the clone→row hand-off — and the hover/selected background
// the row now carries — eases in instead of popping. Kept SHORTER than the settle so the
// row snaps crisp soon after landing (no lingering ghost; stays within "not sluggish").
const SORTABLE_DROP_REVEAL_MS = 170;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function SortableRow<T>({
  id,
  item,
  disabled,
  renderItem,
  registerNode,
  activeId,
  collapsed,
  placeholderHeight,
}: {
  id: string;
  item: T;
  disabled: boolean;
  renderItem: (item: T, ctx: SortableItemContext) => ReactNode;
  /** Register/unregister this row's DOM node so the list can FLIP a group move. */
  registerNode: (id: string, el: HTMLElement | null) => void;
  /** id of the row currently grabbed (list-wide), forwarded to renderItem's ctx. */
  activeId: string | null;
  /** true while a GROUP drag is in flight and this is a lifted row OTHER than the
   *  grabbed one — it collapses to zero height so it "joins the floating deck" and
   *  leaves no phantom gap at its origin (⑤a). */
  collapsed: boolean;
  /** When set, this is the grabbed row of a GROUP drag: its hidden placeholder slot
   *  grows to this height (= liftedCount rows) so the reflow opens a MULTI-row gap
   *  that follows the cursor — sized to how many rows are floating (⑤a). */
  placeholderHeight: number | null;
}) {
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id, disabled });
  // Compose dnd-kit's node ref with the list's node registry (used by the group-move
  // FLIP to measure before/after positions). Both see the same element.
  const composedRef = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      registerNode(id, el);
    },
    [setNodeRef, registerNode, id],
  );
  // Fade the row's opacity as well as its transform: on pickup the source row fades out
  // (rather than blinking to a gap), and on drop — when dnd-kit unmounts the floating
  // clone and reveals this real row — the row (and any hover/selected background it now
  // carries) fades IN, so the clone→row hand-off reads as one continuous settle instead
  // of a hard pop at the final frame. Composed onto dnd-kit's own transition (never
  // replacing it) and dropped under prefers-reduced-motion (the reveal is then instant).
  const reduced = prefersReducedMotion();
  const opacityTransition = reduced ? null : `opacity ${SORTABLE_DROP_REVEAL_MS}ms ${SORTABLE_DROP_EASING}`;
  // A group drag collapses/expands the lifted rows' HEIGHT; animate that too (unless
  // reduced-motion) so rows fold into the deck on pickup and unfold into the open gap on
  // drop as one continuous motion instead of popping.
  const heightTransition = reduced ? null : `height ${SORTABLE_DROP_REVEAL_MS}ms ${SORTABLE_DROP_EASING}`;
  const groupHeight = collapsed || placeholderHeight != null;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition:
      [transition, opacityTransition, groupHeight ? heightTransition : null].filter(Boolean).join(", ") || undefined,
    // Hide the picked-up row so its reserved slot IS the gap the neighbours open and
    // the floating clone drops into (the clone carries the visible content instead).
    ...(isDragging ? { opacity: 0 } : null),
    // Group drag (⑤a): lifted non-grabbed rows collapse to 0; the grabbed row's hidden
    // placeholder grows to `placeholderHeight` (= liftedCount rows) so the moving gap is
    // as tall as the floating deck. overflow:hidden clips the (invisible) inner content.
    ...(collapsed ? { height: 0, minHeight: 0, paddingTop: 0, paddingBottom: 0, overflow: "hidden", pointerEvents: "none" as const } : null),
    ...(placeholderHeight != null ? { height: placeholderHeight, overflow: "hidden" as const } : null),
  };
  const dragHandleProps = (disabled ? {} : { ...attributes, ...(listeners ?? {}) }) as SortableDragHandleProps;
  return (
    <div ref={composedRef} style={style} className={styles.item} data-dragging={isDragging || undefined}>
      {renderItem(item, { isDragging, dragHandleProps, dragActiveId: activeId })}
    </div>
  );
}

// Group-move FLIP tuning: how long the block of moved rows slides into place. Matched
// to the single-row drop settle (SORTABLE_DROP_DURATION_MS) so a group move and a
// single move read as the same motion. Easing is shared too.
const FLIP_DURATION_MS = SORTABLE_DROP_DURATION_MS;

export function SortableList<T>({
  items,
  getItemId,
  renderItem,
  renderOverlay,
  onReorder,
  computeNextOrder,
  liftedIds,
  disabled = false,
  className,
  overlayClassName,
  testId,
  ...rest
}: SortableListProps<T>) {
  const ariaLabel = rest["aria-label"];
  const [activeId, setActiveId] = useState<string | null>(null);
  // The lifted group as a Set (stable per liftedIds content). A drag on a member with
  // group size > 1 triggers the multi-row-gap behaviour (⑤a).
  const liftedSet = useMemo(() => new Set(liftedIds ?? []), [liftedIds]);
  // Height (px) the grabbed row's hidden placeholder takes during a GROUP drag: the
  // measured row height × the number of lifted rows, so the moving gap is that many rows
  // tall. null ⇒ no group drag in flight (classic single-row gap).
  const [groupGapPx, setGroupGapPx] = useState<number | null>(null);

  // ---- group-move FLIP ----
  // Registry of each rendered row's DOM node (keyed by id) so a multi-row drop can
  // measure First (pre-commit) and Last (post-commit) positions and animate the delta.
  const nodeMap = useRef<Map<string, HTMLElement>>(new Map());
  const registerNode = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodeMap.current.set(id, el);
    else nodeMap.current.delete(id);
  }, []);
  // Set on a group drop (computeNextOrder returned a custom order): the pre-commit row
  // tops + the grabbed id (excluded — the floating clone settles it). The layout effect
  // after the reorder commit plays the FLIP and clears this.
  const flipPlanRef = useRef<{ prevTops: Map<string, number>; grabbedId: string } | null>(null);
  // Optimistic drop: on release the RENDERED list is reordered synchronously (in the
  // same React commit as clearing activeId), so the dropped row is already in its new
  // slot when the overlay's drop animation measures — the clone then settles INTO that
  // slot instead of flying back to the source (the "元に戻ってから移動する" flicker; the
  // consumer's durable order often lands a tick later via its own state/query). The
  // consumer still owns the persisted order via onReorder; once its updated `items`
  // arrive we release the override and defer to props (order key = reconcile signal).
  const [overrideIds, setOverrideIds] = useState<readonly string[] | null>(null);
  const overrideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearOverrideTimer = () => {
    if (overrideTimer.current) {
      clearTimeout(overrideTimer.current);
      overrideTimer.current = null;
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The list actually rendered: props order, or the optimistic override applied over the
  // latest props (items absent from the override keep their props order).
  const orderedItems = useMemo(() => {
    if (!overrideIds) return items;
    const byId = new Map<string, T>();
    for (const it of items) byId.set(getItemId(it), it);
    const out: T[] = [];
    const used = new Set<string>();
    for (const id of overrideIds) {
      const it = byId.get(id);
      if (it && !used.has(id)) {
        out.push(it);
        used.add(id);
      }
    }
    for (const it of items) {
      const id = getItemId(it);
      if (!used.has(id)) out.push(it);
    }
    return out;
  }, [items, overrideIds, getItemId]);

  const ids = orderedItems.map(getItemId);

  // Reconcile: when the consumer re-derives `items` into a new order (its persisted/
  // optimistic order landed), release the override and let props drive. Keyed on the
  // order CONTENT (not array identity) so it's robust to consumers that recreate the
  // array each render. The batched drop-commit doesn't change props order, so the
  // override survives the drop frame and only releases once real data catches up.
  const propOrderKey = useMemo(() => items.map(getItemId).join(" "), [items, getItemId]);
  useEffect(() => {
    clearOverrideTimer();
    setOverrideIds(null);
  }, [propOrderKey]);
  useEffect(() => () => clearOverrideTimer(), []);

  const onDragStart = useCallback(
    (e: DragStartEvent) => {
      clearOverrideTimer();
      setOverrideIds(null);
      const id = e.active ? String(e.active.id) : null;
      setActiveId(id);
      // Group drag (⑤a): when the grabbed row is a member of a >1 lifted set, size the
      // moving gap to the whole deck — measure the grabbed row's height and reserve
      // liftedCount × that as its placeholder slot (the other members collapse to 0).
      if (id && liftedSet.has(id) && liftedSet.size > 1) {
        const el = nodeMap.current.get(id);
        const h = el ? el.getBoundingClientRect().height : 0;
        setGroupGapPx(h > 0 ? h * liftedSet.size : null);
      } else {
        setGroupGapPx(null);
      }
    },
    [liftedSet],
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null);
      setGroupGapPx(null);
      const activeId = e.active ? String(e.active.id) : null;
      const overId = e.over ? String(e.over.id) : null;
      if (!activeId || !overId || activeId === overId) return;
      const currentIds = orderedItems.map(getItemId);
      const oldIndex = currentIds.indexOf(activeId);
      const newIndex = currentIds.indexOf(overId);
      if (oldIndex < 0 || newIndex < 0) return;
      // Group (multi-row) drop: let the consumer supply the FULL next order — a single
      // arrayMove would move only the grabbed row. When it does, arm a FLIP so every OTHER
      // moved row slides to its new slot together (the grabbed row rides the floating
      // clone). Fall back to the single-row arrayMove otherwise.
      const custom = computeNextOrder ? computeNextOrder(activeId, overId, [...currentIds]) : null;
      if (custom) {
        // With the multi-row-gap approach (liftedIds) the lifted rows were collapsed to 0
        // and the gap already held the whole deck, so they simply unfold into that open
        // gap on drop — no FLIP (measuring collapsed tops would be wrong). The classic path
        // (no liftedIds) still FLIPs the scattered rows into place.
        const liftedActive = liftedSet.has(activeId) && liftedSet.size > 1;
        if (!prefersReducedMotion() && !liftedActive) {
          const prevTops = new Map<string, number>();
          for (const [id, el] of nodeMap.current) prevTops.set(id, el.getBoundingClientRect().top);
          flipPlanRef.current = { prevTops, grabbedId: activeId };
        }
        setOverrideIds(custom);
        clearOverrideTimer();
        overrideTimer.current = setTimeout(() => setOverrideIds(null), 400);
        onReorder({ activeId, overId, oldIndex, newIndex });
        return;
      }
      // Apply the reorder to the rendered list NOW (batched with setActiveId above) so
      // the drop settles smoothly into place; persist via the consumer.
      const next = arrayMove(currentIds, oldIndex, newIndex);
      setOverrideIds(next);
      // Safety net: if the consumer rejects the move (no items change, e.g. a
      // cross-parent drop the container ignores), release the override shortly after
      // the drop animation so the row snaps back instead of sticking optimistically.
      clearOverrideTimer();
      overrideTimer.current = setTimeout(() => setOverrideIds(null), 400);
      onReorder({ activeId, overId, oldIndex, newIndex });
    },
    [orderedItems, getItemId, onReorder, computeNextOrder, liftedSet],
  );

  // Play the group-move FLIP after the reorder commit: every moved row (except the
  // grabbed one, settled by the floating clone) is inverted to its OLD position then
  // released, so the whole selected block slides to its new slot in one motion. Keyed on
  // the rendered id order so it runs exactly on the commit that applied the new order.
  const renderedOrderKey = ids.join(" ");
  useLayoutEffect(() => {
    const plan = flipPlanRef.current;
    if (!plan) return;
    flipPlanRef.current = null;
    const anims: { el: HTMLElement; dy: number }[] = [];
    for (const [id, el] of nodeMap.current) {
      if (id === plan.grabbedId) continue; // the clone settles the grabbed row
      const prevTop = plan.prevTops.get(id);
      if (prevTop === undefined) continue;
      const dy = prevTop - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;
      anims.push({ el, dy });
    }
    if (anims.length === 0) return;
    // Invert: jump each moved row back to where it was (no transition), then...
    for (const { el, dy } of anims) {
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
    }
    // ...play: on the next frame, release to the real position with a transition.
    const raf = requestAnimationFrame(() => {
      for (const { el } of anims) {
        el.style.transition = `transform ${FLIP_DURATION_MS}ms ${SORTABLE_DROP_EASING}`;
        el.style.transform = "";
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [renderedOrderKey]);

  const onDragCancel = useCallback(() => {
    setActiveId(null);
    setGroupGapPx(null);
  }, []);

  // A group drag is in flight when we've reserved a multi-row gap for the grabbed row.
  const groupActive = activeId != null && groupGapPx != null;

  const activeItem = activeId != null ? orderedItems.find((it) => getItemId(it) === activeId) ?? null : null;

  // Drop animation: ease the clone from the release point INTO the (already-reordered)
  // new slot — because the list reorders synchronously on drop, dnd-kit measures the
  // active row at its NEW position, so this eases toward the new slot, never back to the
  // source. The sideEffect keeps the destination row hidden until the clone lands, so it
  // reads as the clone settling into the open gap. Instant when reduced-motion is on.
  const dropAnimation: DropAnimation = {
    duration: prefersReducedMotion() ? 0 : SORTABLE_DROP_DURATION_MS,
    easing: SORTABLE_DROP_EASING,
    sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // While a group drag reshapes row heights (collapse + multi-row placeholder), keep
      // measuring droppables so the reflow gap tracks the live heights (⑤a); otherwise the
      // default (measure once at drag start) is fine.
      measuring={groupActive ? { droppable: { strategy: MeasuringStrategy.Always } } : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={className} data-testid={testId} aria-label={ariaLabel}>
          {orderedItems.map((item) => {
            const rid = getItemId(item);
            return (
              <SortableRow
                key={rid}
                id={rid}
                item={item}
                disabled={disabled}
                renderItem={renderItem}
                registerNode={registerNode}
                activeId={activeId}
                collapsed={groupActive && liftedSet.has(rid) && rid !== activeId}
                placeholderHeight={groupActive && rid === activeId ? groupGapPx : null}
              />
            );
          })}
        </div>
      </SortableContext>
      {/* The clone eases (~200ms ease-out) from where it was released into its new slot
          — never back to the source, since the list is already reordered synchronously —
          so the drop reads as a gentle "settle into the open gap", no return-to-origin. */}
      <DragOverlay dropAnimation={dropAnimation}>
        {activeItem ? (
          <div className={cx(styles.overlay, overlayClassName)}>
            {renderOverlay ? renderOverlay(activeItem) : renderItem(activeItem, { isDragging: false, dragHandleProps: {}, dragActiveId: activeId })}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
