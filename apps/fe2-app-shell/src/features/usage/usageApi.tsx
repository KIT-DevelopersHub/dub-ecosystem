// Usage API adapter — the only place the usage feature talks to the shell
// ApiClient. Mirrors features/mail/mailApi.tsx: a thin object built from the ONE
// session-wired api-client. It owns the *fallback* policy so screens never branch
// on transport: getSummary() returns { summary, source } and NEVER rejects —
//   • VITE_DEMO build            → mock, illustrative values (source:"demo")
//   • live GET succeeds          → wire summary               (source:"live")
//   • live GET fails/forbidden   → NEUTRAL summary            (source:"unavailable")
//
// Critically, a failed/forbidden live read must NOT surface the mock's illustrative
// warn/critical numbers: in production that read as a real "上限間近" alarm on an
// account that is actually fine. Outside a demo build we fall back to a NEUTRAL
// (all-unknown) summary and tag it `unavailable` so the screen shows a plain
// "取得できませんでした" state instead. The mock is confined to VITE_DEMO.
import { ApiError, type ApiClient } from "../../lib/api-client.tsx";
import { buildMockUsageSummary, buildNeutralUsageSummary } from "./mockUsageSummary.ts";
import type { UsageSummary, UsageSummaryResult, UsageUnavailableReason } from "./types.ts";

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

  /** Neutral, never-alarming fallback for a failed/forbidden/malformed live read. */
  function unavailable(reason: UsageUnavailableReason): UsageSummaryResult {
    return { summary: buildNeutralUsageSummary(), source: "unavailable", reason };
  }

  async function fetchLive(): Promise<UsageSummaryResult> {
    if (demo) return { summary: buildMockUsageSummary(), source: "demo" };
    try {
      const summary = await api.request<UsageSummary>({ method: "GET", path: USAGE_SUMMARY_PATH });
      // A malformed/empty payload is treated like a failure → neutral, not mock.
      if (!summary || !Array.isArray(summary.services)) {
        return unavailable("error");
      }
      return { summary, source: "live" };
    } catch (e) {
      // 401/403 mean "you may not view usage" (needs infra:read); anything else is a
      // transient/offline/contract failure. Both render neutrally, only the copy differs.
      const forbidden = ApiError.isApiError(e) && (e.status === 401 || e.status === 403);
      return unavailable(forbidden ? "forbidden" : "error");
    }
  }

  return {
    getSummary: fetchLive,
    refresh: fetchLive,
  };
}
