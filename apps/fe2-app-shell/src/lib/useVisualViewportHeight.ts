import { useEffect } from "react";

/**
 * Mirror the *visual* viewport height into the `--dub-app-height` CSS custom
 * property so full-height surfaces (the shell, chat) size to the space left
 * ABOVE the on-screen keyboard instead of being covered by it.
 *
 * Why CSS alone is not enough: `100dvh` follows the URL bar but NOT the software
 * keyboard on iOS WebView/Safari — the layout viewport stays full-height, so a
 * bottom-docked composer slides under the keyboard. `window.visualViewport` DOES
 * shrink when the keyboard opens, so we copy its height onto the var. Android's
 * `interactive-widget=resizes-content` (set in each index.html) already resizes
 * the layout viewport, so this brings iOS to parity. When visualViewport is
 * unavailable the var stays unset and CSS falls back to `100dvh` / `100vh`.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const root = document.documentElement;
    const apply = (): void => {
      // Round to whole px so sub-pixel jitter during URL-bar/keyboard animation
      // does not churn layout every frame.
      root.style.setProperty("--dub-app-height", `${Math.round(vv.height)}px`);
    };
    apply();
    // `resize` fires on keyboard open/close, URL-bar collapse and orientation change.
    vv.addEventListener("resize", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      root.style.removeProperty("--dub-app-height");
    };
  }, []);
}
