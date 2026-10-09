import { useEffect, useState } from "react";

/** Phone-width breakpoint (@dub/tokens breakpoint.sm). Same number as the
 *  `@media (max-width: 640px)` blocks in the component CSS modules. */
export const NARROW_VIEWPORT_QUERY = "(max-width: 640px)";

/** Touch-first device (phone/tablet WebView). */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/**
 * Live `matchMedia` result, for layouts whose styles are inline (no CSS media
 * query possible) or that must change markup, not just styles, on phones.
 * Falls back to `false` (= desktop) where `matchMedia` is unavailable.
 */
export function useMediaQuery(query: string): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [matches, setMatches] = useState<boolean>(() => (supported ? window.matchMedia(query).matches : false));

  useEffect(() => {
    if (!supported) return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    // addListener is the Safari <14 fallback.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query, supported]);

  return matches;
}
