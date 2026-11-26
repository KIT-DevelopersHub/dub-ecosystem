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
import type { UsageIssue, UsageIssuesResult, UsageSummary, UsageSummaryResult, UsageUnavailableReason } from "./types.ts";

/** Gateway path for the summary (contract: GET /usage/summary, /api/v1 prefixed). */
export const USAGE_SUMMARY_PATH = "/api/v1/usage/summary" as const;

/** Open escalation Issues (#902). The repo is public, so this is an unauthenticated read of
 *  GitHub's REST API from the browser (60/h per viewer IP — one call per /usage view). */
export const USAGE_ISSUES_URL =
  "https://api.github.com/repos/KIT-DevelopersHub/dub-ecosystem/issues?state=open&labels=area:usage&per_page=100" as const;

const ISSUE_TITLE_RE = /^\[usage:([a-z0-9_]+)\]/;

/** GitHub issues payload → open Issue per metric (first match wins; PRs skipped). */
export function parseUsageIssues(payload: unknown): UsageIssuesResult {
  if (!Array.isArray(payload)) return { available: false, byMetric: {} };
  const byMetric: Record<string, UsageIssue> = {};
  for (const raw of payload) {
    const r = raw as { number?: unknown; html_url?: unknown; title?: unknown; pull_request?: unknown };
    if (r.pull_request || typeof r.title !== "string" || typeof r.number !== "number" || typeof r.html_url !== "string") continue;
    const m = ISSUE_TITLE_RE.exec(r.title);
    if (m && !byMetric[m[1]!]) byMetric[m[1]!] = { metricKey: m[1]!, number: r.number, url: r.html_url, title: r.title };
  }
  return { available: true, byMetric };
}

/** Demo build: one illustrative open Issue (the critical KV card). */
function demoIssues(): UsageIssuesResult {
  return {
    available: true,
    byMetric: {
      kv_reads_day: {
        metricKey: "kv_reads_day",
        number: 902,
        url: "https://github.com/KIT-DevelopersHub/dub-ecosystem/issues/902",
        title: "[usage:kv_reads_day] KV 読み取り(日) が無料枠の 96.5%（危険）",
      },
    },
  };
}

export interface UsageApi {
  /** Fetch the current snapshot. Resolves always (mock fallback on failure). */
  getSummary(): Promise<UsageSummaryResult>;
  /** "今すぐ更新": ask upstream to re-meter, then read. No gateway-exposed refresh
   *  endpoint exists yet, so this is a plain re-GET (contract: "無ければ再GETのみ").
   *  When the gateway later exposes POST /internal/meter/refresh, wire it here. */
  refresh(): Promise<UsageSummaryResult>;
  /** Open escalation Issues per metric. Resolves always ({available:false} on failure). */
  getOpenIssues?(): Promise<UsageIssuesResult>;
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
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch.bind(globalThis) : undefined,
): UsageApi {
  const demo = isDemo(env);

  /** Neutral, never-alarming fallback for a failed/forbidden/malformed live read. */
  function unavailable(reason: UsageUnavailableReason): UsageSummaryResult {
    return { summary: buildNeutralUsageSummary(), source: "unavailable", reason };
  }

  async function fetchLive(): Promise<UsageSummaryResult> {
    if (demo) {
      // ?usage-stale=1 previews the "collection stopped" state in a demo build.
      const stale = new URLSearchParams(globalThis.location?.search ?? "").get("usage-stale") === "1";
      return { summary: buildMockUsageSummary(new Date(), { stale }), source: "demo" };
    }
    try {
      const summary = await api.request<UsageSummary>({ method: "GET", path: USAGE_SUMMARY_PATH });
      // A malformed/empty payload is treated like a failure → neutral, not mock.
      if (!summary || !Array.isArray(summary.services)) {
        return unavailable("error");
      }
      return { summary, source: "live" };
    } catch (e) {
      // 401/403 mean the session lapsed / the caller is not authenticated (viewing needs
      // no special permission anymore, only sign-in); anything else is a transient/offline/
      // contract failure. Both render neutrally, only the copy differs.
      const forbidden = ApiError.isApiError(e) && (e.status === 401 || e.status === 403);
      return unavailable(forbidden ? "forbidden" : "error");
    }
  }

  async function getOpenIssues(): Promise<UsageIssuesResult> {
    if (demo) return demoIssues();
    if (!fetchImpl) return { available: false, byMetric: {} };
    try {
      const res = await fetchImpl(USAGE_ISSUES_URL, { headers: { accept: "application/vnd.github+json" } });
      if (!res.ok) return { available: false, byMetric: {} };
      return parseUsageIssues(await res.json());
    } catch {
      return { available: false, byMetric: {} };
    }
  }

  return {
    getSummary: fetchLive,
    refresh: fetchLive,
    getOpenIssues,
  };
}
