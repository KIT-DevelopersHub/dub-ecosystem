// Shared overlay primitives used by anything that needs to escape an ancestor's
// containing block (Modal/Drawer, and the AppLauncher mobile bottom sheet — P19).
// Split out of Modal.tsx so it has exactly one implementation instead of every
// overlay growing its own copy.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Render overlays at <body> via a portal so `position: fixed` is measured against
// the viewport and the overlay escapes any ancestor stacking context / overflow
// clip. This matters in this app specifically: the sticky app-shell header uses
// `backdrop-filter` for its frosted-glass look, and any element with a non-none
// `filter`/`backdrop-filter` becomes the containing block for `position: fixed`
// descendants — so a fixed-position overlay left inside that header anchors to
// the ~header-height box instead of the real viewport.
export function OverlayPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

// Ref-counted scroll lock so nested/stacked overlays don't fight over body.style,
// and the original overflow is restored only once every overlay has closed.
let scrollLockCount = 0;
let savedBodyOverflow = "";
export function useScrollLock(open: boolean) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    if (scrollLockCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLockCount += 1;
    return () => {
      scrollLockCount -= 1;
      if (scrollLockCount === 0) document.body.style.overflow = savedBodyOverflow;
    };
  }, [open]);
}
