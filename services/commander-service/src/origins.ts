// Which browser origins may read this API's responses.
//
// This used to be `cors({ origin: "*" })`, which is the worst possible answer for a
// loopback service: `*` tells the browser that ANY page the operator has open may read
// every response from `http://127.0.0.1:<port>`. Combined with unauthenticated GETs that
// meant any site could fetch run prompts, worktree paths and AI conversation bodies out of
// the operator's own machine (inventory §2.22 risk 2).
//
// CORS is a second layer, not the authorization layer — `operatorGate` is that, and it now
// applies to GET too. But the two reinforce each other in a way worth stating: because every
// gated route demands the custom `x-commander-token` header, a cross-origin call is no longer
// a "simple request" and the browser must preflight it. A disallowed origin fails the
// preflight, so the real request is never sent at all — the token check is never even reached.
import type { Env } from "./env";

/**
 * Loopback origins, any port. This is the default because Commander is a local, single-
 * operator app: `dev-up.sh` serves the web app on `http://127.0.0.1:<WEB_PORT>` with the
 * port chosen at startup, so an exact-match default would break on every run.
 *
 * Any-port is sound here in a way any-host would not be: `Origin` is set by the browser to
 * the requesting page's own origin and cannot be forged by page script, so this admits only
 * pages actually served from the operator's own machine — not arbitrary websites.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

/**
 * The Dub app's own origins (fe2 /commander screen), exact match. The page reaches this
 * service either on loopback (same PC) or through the operator's Cloudflare Tunnel; either
 * way it is cross-origin, and without this grant the board CORS-fails in the browser.
 * The token gate still applies — this only lets the Dub app read what the token unlocks.
 */
export const DUB_APP_ORIGINS: readonly string[] = [
  "https://dub-fe2-app-shell.developershub-site.workers.dev",
  "https://dub-fe2-app-shell-staging.developershub-site.workers.dev",
];

/**
 * The value for `Access-Control-Allow-Origin`, or `null` to send no CORS header at all.
 *
 * `null` (not `"*"`) is the fallback for every unrecognised origin, and also for a request
 * with no `Origin` header — i.e. the daemon's `fetch` and `dev-up.sh`'s `curl`, which are not
 * browsers and need no CORS grant. Returning `"*"` for them is what made the header
 * unconditional before.
 *
 * Set `COMMANDER_ALLOWED_ORIGINS` (comma-separated, exact origins) if this service is ever
 * served somewhere other than loopback; doing so REPLACES the loopback default rather than
 * adding to it, so a deployed instance does not keep trusting `localhost`.
 */
export function allowedOrigin(origin: string, env: Env): string | null {
  const configured = (env.COMMANDER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");

  if (configured.length > 0) return configured.includes(origin) ? origin : null;
  return LOOPBACK_ORIGIN.test(origin) || DUB_APP_ORIGINS.includes(origin) ? origin : null;
}
