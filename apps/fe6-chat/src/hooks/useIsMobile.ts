/// <reference lib="dom" />
// Tracks whether the viewport is at/under the mobile breakpoint so ChatApp /
// ChannelPage can switch the channel list + thread pane from grid columns to
// slide-in drawers (P21). Mirrors the matchMedia-subscription pattern already
// used for dark-mode detection in fe2-app-shell's ThemeBridge — a live
// subscription, not a one-time read, so resizing/rotating updates without a
// reload. Matches @dub/tokens breakpoint.md (768px).
import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 768px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => globalThis.matchMedia?.(MOBILE_QUERY).matches ?? false);
  useEffect(() => {
    const mq = globalThis.matchMedia?.(MOBILE_QUERY);
    if (!mq) return undefined;
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}
