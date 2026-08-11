// Usage API adapter — the only place the usage feature talks to the shell
// ApiClient. Mirrors features/mail/mailApi.tsx: a thin object built from the ONE
// session-wired api-client. It owns the *fallback* policy so screens never branch
// on transport: getSummary() returns { summary, source } and NEVER rejects —
//   • VITE_DEMO build            → mock (source:"demo")
//   • live GET succeeds          → wire summary (source:"live")
//   • live GET fails / offline   → mock (source:"mock")
// so the dashboard is always renderable, with a "sample data" notice when degraded.
import type { ApiClient } from "../../lib/api-client.tsx";
import { buildMockUsageSummary } from "./mockUsageSummary.ts";
import type { UsageSummary, UsageSummaryResult } from "./types.ts";

/** Gateway path for the summary (contract: GET /usage/summary, /api/v1 prefixed). */
export const USAGE_SUMMARY_PATH = "/api/v1/usage/summary" as const;

export interface UsageApi {
  /** Fetch the current snapshot. Resolves always (mock fallback on failure). */
  getSummary(): Promise<UsageSummaryResult>;
  /** "今すぐ更新": ask upstream to re-meter, then read. No gateway-exposed refresh
   *  endpoint exists yet, so this is a plain re-GET (contract: "無ければ再GETのみ").
   *  When the gateway later exposes POST /internal/meter/refresh, wire it here. */
  refresh(): Promise<UsageSummaryResult>;
}

function isDemo(env: { VITE_DEMO?: string } | undefined): boolean {
  return env?.VITE_DEMO === "true" || env?.VITE_DEMO === "1";
}

export function createUsageApi(
  api: ApiClient,
  // Injectable for tests; defaults to Vite's build-time env.
  env: { VITE_DEMO?: string } | undefined = typeof import.meta !== "undefined"
    ? (import.meta.env as { VITE_DEMO?: string })
    : undefined,
): UsageApi {
  const demo = isDemo(env);

  async function fetchLive(): Promise<UsageSummaryResult> {
    if (demo) return { summary: buildMockUsageSummary(), source: "demo" };
    try {
      const summary = await api.request<UsageSummary>({ method: "GET", path: USAGE_SUMMARY_PATH });
      // A malformed/empty payload is treated like a failure → fall back to mock.
      if (!summary || !Array.isArray(summary.services)) {
        return { summary: buildMockUsageSummary(), source: "mock" };
      }
      return { summary, source: "live" };
    } catch {
      return { summary: buildMockUsageSummary(), source: "mock" };
    }
  }

  return {
    getSummary: fetchLive,
    refresh: fetchLive,
  };
}
