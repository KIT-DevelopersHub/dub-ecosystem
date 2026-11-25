// Drag a floating window by its header (Gmail compose). Returns the window's top-left
// position (null = use the default docked bottom-right placement) and a pointerdown
// handler for the handle. The position is clamped so the whole window stays inside the
// viewport (re-clamped on resize) and remembered for the browser session, so the next
// compose opens where the user last left one.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export const COMPOSE_POSITION_KEY = "fe2.mail.compose.position";
/** Below this viewport width the window is full-width and not draggable. */
export const COMPOSE_DRAG_MIN_VIEWPORT = 640;

export interface WindowPos {
  x: number;
  y: number;
}

export function clampPos(pos: WindowPos, size: { width: number; height: number }, viewport: { width: number; height: number }): WindowPos {
  const maxX = Math.max(0, viewport.width - size.width);
  const maxY = Math.max(0, viewport.height - size.height);
  return { x: Math.min(Math.max(0, pos.x), maxX), y: Math.min(Math.max(0, pos.y), maxY) };
}

function readStored(): WindowPos | null {
  try {
    const raw = sessionStorage.getItem(COMPOSE_POSITION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<WindowPos>;
    return typeof v.x === "number" && typeof v.y === "number" ? { x: v.x, y: v.y } : null;
  } catch {
    return null;
  }
}

function store(pos: WindowPos | null): void {
  try {
    if (pos) sessionStorage.setItem(COMPOSE_POSITION_KEY, JSON.stringify(pos));
    else sessionStorage.removeItem(COMPOSE_POSITION_KEY);
  } catch {
    /* storage blocked: position just isn't remembered */
  }
}

const viewport = (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight });

export function useIsNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < COMPOSE_DRAG_MIN_VIEWPORT);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < COMPOSE_DRAG_MIN_VIEWPORT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

export function useDraggableWindow({
  enabled,
  size,
  offset = 0,
}: {
  enabled: boolean;
  size: { width: number; height: number };
  /** Stacking index: extra windows open shifted left of the remembered spot. */
  offset?: number;
}): {
  pos: WindowPos | null;
  dragging: boolean;
  onHandlePointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
} {
  const [pos, setPos] = useState<WindowPos | null>(() => {
    const stored = readStored();
    return stored ? { x: stored.x - offset * 30, y: stored.y } : null;
  });
  const [dragging, setDragging] = useState(false);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // Keep the window on-screen when the viewport shrinks or the window grows.
  const hasPos = pos !== null;
  useEffect(() => {
    if (!enabled || !hasPos) return;
    const fit = (): void =>
      setPos((p) => {
        if (!p) return p;
        const c = clampPos(p, sizeRef.current, viewport());
        return c.x === p.x && c.y === p.y ? p : c;
      });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [enabled, hasPos, size.width, size.height]);

  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (!enabled || e.button !== 0) return;
      // Header buttons (minimize / maximize / close) keep their own click behaviour.
      if ((e.target as HTMLElement).closest("button")) return;
      const rect = (e.currentTarget.parentElement ?? e.currentTarget).getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      let prevUserSelect = "";
      e.preventDefault();
      let last: WindowPos = { x: rect.left, y: rect.top };
      const onMove = (ev: PointerEvent): void => {
        if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        if (!moved) {
          moved = true;
          setDragging(true);
          // Don't paint a text selection across the page while dragging.
          prevUserSelect = document.body.style.userSelect;
          document.body.style.userSelect = "none";
          window.getSelection()?.removeAllRanges();
        }
        ev.preventDefault();
        last = clampPos({ x: ev.clientX - grabX, y: ev.clientY - grabY }, sizeRef.current, viewport());
        setPos(last);
      };
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (moved) {
          document.body.style.userSelect = prevUserSelect;
          setDragging(false);
          store(last);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [enabled],
  );

  return { pos: enabled ? pos : null, dragging, onHandlePointerDown };
}
