// Google-style drag of existing items: move (time grid, 終日 lane, 月) and resize (bottom edge of a
// timed block, right edge of a 終日 bar). The dates live in calendar-model; this only tracks the
// pointer. Mouse/pen only: a touch on the grid has to keep scrolling it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { HOUR_PX, datesAfterDrag, type CalendarItem, type DropTarget, type ItemDates, type ItemDrag } from "./calendar-model";

/** Below this the gesture is still a click (opens the detail). */
const DRAG_THRESHOLD_PX = 4;
const EDGE_PX = 36;
const SCROLL_STEP_PX = 12;
const SCROLL_TICK_MS = 30;

export interface ItemDragPreview {
  id: string;
  dates: ItemDates;
}

export interface ItemDragApi {
  /** The item being dragged, drawn at its preview dates. */
  draggingId: string | null;
  canDrag: (it: CalendarItem) => boolean;
  begin: (e: ReactPointerEvent, it: CalendarItem) => void;
}

const ItemDragContext = createContext<ItemDragApi>({ draggingId: null, canDrag: () => false, begin: () => undefined });
export const ItemDragProvider = ItemDragContext.Provider;
export const useItemDragContext = (): ItemDragApi => useContext(ItemDragContext);

function dropTargetAt(x: number, y: number): DropTarget | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const slot = el.closest<HTMLElement>("[data-cal-slot]");
    if (!slot) continue;
    const day = Number(slot.dataset.calDay);
    const kind = slot.dataset.calSlot;
    if (kind === "timed") return { kind, day, minute: ((y - slot.getBoundingClientRect().top) / HOUR_PX) * 60 };
    if (kind === "allday" || kind === "day") return { kind, day };
  }
  return null;
}

/** The click that ends a drag lands on whatever is under the pointer: it must not open anything. */
function swallowNextClick(): void {
  const stop = (e: MouseEvent) => e.stopPropagation();
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

export function useItemDrag({
  canDrag,
  onStart,
  onDrop,
}: {
  canDrag: (it: CalendarItem) => boolean;
  onStart: () => void;
  onDrop: (it: CalendarItem, dates: ItemDates) => void;
}): { api: ItemDragApi; preview: ItemDragPreview | null } {
  const [preview, setPreview] = useState<ItemDragPreview | null>(null);
  const previewRef = useRef<ItemDragPreview | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const latest = useRef({ onStart, onDrop });
  latest.current = { onStart, onDrop };
  useEffect(() => () => cleanupRef.current?.(), []);

  const show = (next: ItemDragPreview | null) => {
    previewRef.current = next;
    setPreview(next);
  };

  const begin = useCallback(
    (e: ReactPointerEvent, item: CalendarItem) => {
      if (e.button !== 0 || e.pointerType === "touch" || !canDrag(item)) return;
      const origin = { x: e.clientX, y: e.clientY };
      const pointer = { ...origin };
      const mode = (e.target as Element).closest("[data-cal-resize]") ? "resize" : "move";
      let drag: ItemDrag | null = null;
      const pickUp = (): ItemDrag => {
        const grabbed = dropTargetAt(origin.x, origin.y);
        return {
          item,
          mode,
          fromDay: grabbed?.day ?? item.startDay,
          grabMinute: grabbed?.kind === "timed" && item.start ? grabbed.minute - (item.start.getHours() * 60 + item.start.getMinutes()) : 0,
        };
      };

      const track = () => {
        const target = dropTargetAt(pointer.x, pointer.y);
        const dates = drag && target && datesAfterDrag(drag, target);
        // Off the grid, or a place this item cannot go: it stays where it last could (as Google).
        if (dates) show({ id: item.task.id, dates });
      };
      const autoScroll = () => {
        const box = document.querySelector("[data-cal-scroll]");
        if (!box) return;
        const r = box.getBoundingClientRect();
        if (pointer.x < r.left || pointer.x > r.right) return;
        const step = pointer.y < r.top + EDGE_PX ? -SCROLL_STEP_PX : pointer.y > r.bottom - EDGE_PX ? SCROLL_STEP_PX : 0;
        if (step === 0) return;
        box.scrollTop += step;
        track();
      };
      let scrollTimer: number | undefined;

      const onMove = (ev: PointerEvent) => {
        pointer.x = ev.clientX;
        pointer.y = ev.clientY;
        if (!drag) {
          if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD_PX) return;
          drag = pickUp();
          latest.current.onStart();
          scrollTimer = window.setInterval(autoScroll, SCROLL_TICK_MS);
        }
        track();
      };
      const finish = (commit: boolean) => {
        cleanupRef.current?.();
        const last = previewRef.current;
        if (drag) swallowNextClick();
        if (commit && last) latest.current.onDrop(item, last.dates);
        show(null);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        finish(false);
      };

      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        window.clearInterval(scrollTimer);
        cleanupRef.current = null;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [canDrag],
  );

  const api = useMemo<ItemDragApi>(() => ({ draggingId: preview?.id ?? null, canDrag, begin }), [preview, canDrag, begin]);
  return { api, preview };
}
