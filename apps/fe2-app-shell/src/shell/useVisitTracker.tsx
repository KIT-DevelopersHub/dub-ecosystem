// P3-1「最近開いたジャンプ」— React glue for the recent-visit store.
//
//  • useVisitTracker(navEntries): mounted once inside the router context, records a
//    visit whenever the route changes to a trackable app page. The label is the
//    page's own heading (the content <PageHeader> <h1>) when it can be read, so the
//    list shows real item names (an event / channel / member title); otherwise it
//    falls back to the owning app's name. Heading capture is retried briefly because
//    feature pages mount lazily (Suspense) after the location changes.
//  • useRecentVisits(): subscribes the dashboard card to the store.
import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import type { NavEntry } from "../modules/types.tsx";
import {
  getRecentVisits,
  recordVisit,
  resolveVisitApp,
  subscribeRecentVisits,
  type RecentVisit,
} from "../lib/recentVisits.ts";

// How aggressively to look for the page heading after a navigation. The content
// route mounts lazily, so the heading may not be in the DOM on the first tick.
const HEADING_RETRY_MS = 250;
const HEADING_MAX_RETRIES = 6;

/**
 * Read the CURRENT route's page title from the DOM: the content <PageHeader>'s
 * <h1>, scoped to <main> so the shell's own brand header (also a PageHeader, but
 * outside <main>) is never picked up. Returns null when absent/blank.
 */
export function readContentHeading(): string | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector('main [data-testid="dub-page-header-row"] h1');
  const text = el?.textContent?.trim();
  return text && text.length > 0 ? text : null;
}

/** Records a recent visit on every trackable route change. Render-only side effect. */
export function useVisitTracker(navEntries: NavEntry[]): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    const meta = resolveVisitApp(pathname, navEntries);
    if (!meta) return;

    const commit = (label: string): void => {
      recordVisit({ path: pathname, label, app: meta.app, icon: meta.icon });
    };

    // Record immediately with the best label available now (heading if the page is
    // already mounted, else the app name) so an entry always exists.
    const initialHeading = readContentHeading();
    commit(initialHeading && initialHeading !== meta.app ? initialHeading : meta.app);
    if (initialHeading) return;

    // Heading not ready yet (lazy route still loading): poll a few times and upgrade
    // the label — re-recording the same path just refreshes it in place (dedup).
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (): void => {
      const heading = readContentHeading();
      if (heading) {
        if (heading !== meta.app) commit(heading);
        return;
      }
      tries += 1;
      if (tries < HEADING_MAX_RETRIES) timer = setTimeout(attempt, HEADING_RETRY_MS);
    };
    timer = setTimeout(attempt, HEADING_RETRY_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [pathname, navEntries]);
}

const EMPTY: RecentVisit[] = [];

/** Subscribe the dashboard to the recent-visit store. */
export function useRecentVisits(): RecentVisit[] {
  return useSyncExternalStore(
    subscribeRecentVisits,
    getRecentVisits,
    () => EMPTY, // server snapshot (SSR / no window)
  );
}
