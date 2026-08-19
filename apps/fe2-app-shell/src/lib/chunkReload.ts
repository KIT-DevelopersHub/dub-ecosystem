// Stale-chunk recovery (production incident: 通知アプリ / メール名簿 が
// "Something went wrong" で開けない).
//
// The shell code-splits every feature route (React.lazy → dynamic import). A
// deploy publishes NEW hashed asset filenames (assets/NotificationInboxPage-*.js)
// and removes the old ones. A browser tab still running the PREVIOUS index.html
// keeps requesting the OLD chunk names, which now 404 → the dynamic import
// rejects → the route's error boundary renders a bare "Something went wrong!".
// Already-loaded routes keep working, so only the not-yet-visited lazy routes
// (typically 通知 / 名簿) break — exactly the reported symptom. A hard refresh
// fixes it because it fetches the fresh index.html + new chunk names.
//
// This module makes that recovery automatic: on a chunk-load failure we reload
// ONCE to pick up the fresh index.html. A short time-window guard prevents a
// reload loop if the chunk is genuinely (not just stale) unavailable — after one
// attempt the real error is allowed to surface.

/** Does this error look like a failed dynamic-import / stale chunk fetch? Covers
 *  Chrome/Firefox/Safari wording plus generic network fetch failures for a module. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /dynamically imported module|importing a module script failed|error loading dynamically imported module|failed to fetch/i.test(
    msg,
  );
}

const RELOAD_AT_KEY = "fe2:chunk-reload-at";
// Long enough to cover a slow reload+render so we never double-reload the same
// episode; short enough that a genuinely new stale-chunk hit minutes later still
// recovers. If a reload does not resolve the failure within this window, the real
// error is shown instead of looping.
const RELOAD_GUARD_MS = 30_000;

// Fallback guard when sessionStorage is unavailable (private mode / SSR).
let reloadedInMemory = false;

/**
 * Trigger a one-time full reload to recover from a stale hashed chunk after a
 * deploy. Returns true if a reload was triggered (the caller should stop and let
 * the navigation happen); false if the loop guard suppressed it (let the error
 * surface). Safe to call from multiple sites (router lazy wrapper + vite:preloadError).
 */
export function reloadForStaleChunk(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_AT_KEY) ?? "0");
    if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  } catch {
    if (reloadedInMemory) return false;
    reloadedInMemory = true;
  }
  window.location.reload();
  return true;
}
