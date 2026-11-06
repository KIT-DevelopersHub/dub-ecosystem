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
/** Matches the .dragDenied animation. */
const DENIED_MS = 400;

export interface ItemDragPreview {
  id: string;
  dates: ItemDates;
}

export interface ItemDragApi {
  /** The item being dragged, drawn at its preview dates. */
  draggingId: string | null;
  /** The item just refused a drag: it shakes for a moment. */
  deniedId: string | null;
  canDrag: (it: CalendarItem) => boolean;
  begin: (e: ReactPointerEvent, it: CalendarItem) => void;
}

const ItemDragContext = createContext<ItemDragApi>({ draggingId: null, deniedId: null, canDrag: () => false, begin: () => undefined });
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
  isLocked,
  onStart,
  onDrop,
  onDenied,
}: {
  canDrag: (it: CalendarItem) => boolean;
  /** Can never be dragged by this user (a row merely waiting for a write is neither). */
  isLocked: (it: CalendarItem) => boolean;
  onStart: () => void;
  onDrop: (it: CalendarItem, dates: ItemDates) => void;
  onDenied: () => void;
}): { api: ItemDragApi; preview: ItemDragPreview | null } {
  const [preview, setPreview] = useState<ItemDragPreview | null>(null);
  const previewRef = useRef<ItemDragPreview | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [deniedId, setDeniedId] = useState<string | null>(null);
  const deniedTimer = useRef<number | undefined>(undefined);
  const latest = useRef({ onStart, onDrop, onDenied });
  latest.current = { onStart, onDrop, onDenied };
  useEffect(
    () => () => {
      cleanupRef.current?.();
      window.clearTimeout(deniedTimer.current);
    },
    [],
  );

  const show = (next: ItemDragPreview | null) => {
    previewRef.current = next;
    setPreview(next);
  };

  /** A drag attempt on a locked item: refuse it once the pointer really moves (a click stays a click). */
  const watchRefusal = useCallback((id: string, x: number, y: number) => {
    const onMove = (ev: PointerEvent) => {
      if (ev.buttons === 0) return cleanupRef.current?.();
      if (Math.hypot(ev.clientX - x, ev.clientY - y) < DRAG_THRESHOLD_PX) return;
      cleanupRef.current?.();
      window.addEventListener("pointerup", swallowNextClick, { once: true });
      window.clearTimeout(deniedTimer.current);
      setDeniedId(id);
      deniedTimer.current = window.setTimeout(() => setDeniedId(null), DENIED_MS);
      latest.current.onDenied();
    };
    const stop = () => cleanupRef.current?.();
    cleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      cleanupRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  const begin = useCallback(
    (e: ReactPointerEvent, item: CalendarItem) => {
      // ctrl+click is a right click on macOS: its pointerup may never come.
      if (e.button !== 0 || e.ctrlKey || e.pointerType === "touch") return;
      cleanupRef.current?.();
      if (!canDrag(item)) {
        if (isLocked(item)) watchRefusal(item.task.id, e.clientX, e.clientY);
        return;
      }
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
        // Only from inside the grid: a bar in the 終日 lane sits above it the whole way.
        if (pointer.x < r.left || pointer.x > r.right || pointer.y < r.top || pointer.y > r.bottom) return;
        const step = pointer.y < r.top + EDGE_PX ? -SCROLL_STEP_PX : pointer.y > r.bottom - EDGE_PX ? SCROLL_STEP_PX : 0;
        if (step === 0) return;
        box.scrollTop += step;
        track();
      };
      let scrollTimer: number | undefined;

      const onMove = (ev: PointerEvent) => {
        if (ev.buttons === 0) return finish(false); // the release was lost (left the window)
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
        if (drag && !last) swallowNextClick();
        if (commit && last) {
          swallowNextClick();
          latest.current.onDrop(item, last.dates);
          // After the optimistic write (a microtask or two), so it never flashes back.
          window.setTimeout(() => show(null));
        } else show(null);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        finish(false);
        // The button is still down: the release that follows is not a click on an item.
        if (drag) window.addEventListener("pointerup", swallowNextClick, { once: true });
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
    [canDrag, isLocked, watchRefusal],
  );

  const api = useMemo<ItemDragApi>(() => ({ draggingId: preview?.id ?? null, deniedId, canDrag, begin }), [preview, deniedId, canDrag, begin]);
  return { api, preview };
}
