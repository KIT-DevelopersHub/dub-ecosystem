// Resolve the API gateway base URL the SPA talks to, baked in at build time from
// VITE_API_BASE_URL (see main.tsx).
//
// WHY THIS EXISTS (prod incident, 2026-08-14): a production build shipped with the
// CI variable VITE_API_BASE_URL set to `https://api.developershub.jp`. That custom
// domain is NOT DNS-configured (NXDOMAIN), so EVERY /api call from the deployed SPA
// — /me and login included — failed with ERR_NAME_NOT_RESOLVED. The shell chrome
// rendered but no data ever loaded: a broken/blank production. It was NOT a JS crash.
//
// This guard makes that class of outage impossible to ship: the known-dead custom
// domain can never be the runtime base, and any unset/garbage value falls back to
// the live workers.dev gateway. Remove the NXDOMAIN clause once api.developershub.jp
// is actually resolvable and fronting the gateway.

/** The live free-tier gateway on workers.dev — the safe, DNS-resolvable default. */
export const GATEWAY_FALLBACK = "https://dub-api-gateway.developershub-site.workers.dev";

/** Host that is known to be NXDOMAIN today; must never be the runtime API base. */
export const NXDOMAIN_HOST = "api.developershub.jp";

/**
 * Resolve the effective API base URL from the build-time value.
 * - unset / blank / unparseable → {@link GATEWAY_FALLBACK}
 * - hostname === {@link NXDOMAIN_HOST} → {@link GATEWAY_FALLBACK} (with a warning)
 * - otherwise the configured value, verbatim.
 */
export function resolveBaseUrl(
  configured: string | undefined,
  warn: (msg: string) => void = (m) => console.warn(m),
): string {
  const value = configured?.trim();
  if (!value) return GATEWAY_FALLBACK;
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    warn(`[fe2] VITE_API_BASE_URL="${value}" is not a valid URL; using ${GATEWAY_FALLBACK}`);
    return GATEWAY_FALLBACK;
  }
  if (host === NXDOMAIN_HOST) {
    warn(
      `[fe2] VITE_API_BASE_URL="${value}" points at ${NXDOMAIN_HOST} (NXDOMAIN); ` +
        `every /api call would fail. Falling back to ${GATEWAY_FALLBACK}.`,
    );
    return GATEWAY_FALLBACK;
  }
  return value;
}
