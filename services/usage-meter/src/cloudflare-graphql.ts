// Cloudflare GraphQL Analytics collector. One POST to the account-scoped GraphQL endpoint
// returns usage across several adaptive datasets; we map each into our metric keys.
//
// GRACEFUL BY DESIGN: this never throws. A network/auth error returns {} (every CF metric
// then renders as status="unknown"); a per-dataset shape mismatch simply omits that metric
// (also -> unknown). So a Cloudflare schema drift or an API hiccup can never break the
// dashboard — it degrades to "unknown", exactly the spec requirement.
//
// !! FIELD NAMES ARE BEST-EFFORT 2026 !! The dataset/field names below (workersInvocations
// Adaptive.sum.requests, d1AnalyticsAdaptiveGroups.sum.read/writeQueries, kvOperations
// AdaptiveGroups, r2OperationsAdaptiveGroups, r2StorageAdaptiveGroups.max.payloadSize) match
// Cloudflare's published Analytics schema at time of writing. The GraphQL endpoint auth was
// verified with the existing deploy token (only arg errors returned, i.e. the token has
// access). Any field that Cloudflare renames just yields an "unknown" metric until updated.
import { startOfUtcDay, startOfUtcMonth, utcDayString } from "./time";

export const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Cloudflare Class A operations (mutations/list). Everything else counts as Class B. */
const R2_CLASS_A_ACTIONS = new Set([
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "UploadPart",
  "UploadPartCopy",
  "ListBuckets",
  "ListObjects",
  "ListMultipartUploads",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);

export interface UsageWindow {
  /** ISO datetime start of today (UTC). */
  dayStart: string;
  /** ISO datetime "now" (UTC). */
  dayEnd: string;
  /** YYYY-MM-DD today (UTC). */
  today: string;
  /** YYYY-MM-DD first of month (UTC). */
  monthStart: string;
}

export function usageWindow(now: Date): UsageWindow {
  return {
    dayStart: startOfUtcDay(now).toISOString(),
    dayEnd: now.toISOString(),
    today: utcDayString(now),
    monthStart: utcDayString(startOfUtcMonth(now)),
  };
}

/** The account-scoped GraphQL query + variables. Pure (unit-tested). */
export function buildUsageQuery(accountTag: string, now: Date): { query: string; variables: Record<string, unknown> } {
  const w = usageWindow(now);
  const query = `
    query UsageMeter($tag: String!, $dayStart: Time!, $dayEnd: Time!, $today: Date!, $monthStart: Date!) {
      viewer {
        accounts(filter: { accountTag: $tag }) {
          workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
            sum { requests }
          }
          d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $today, date_leq: $today }) {
            sum { readQueries writeQueries }
          }
          kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $today, date_leq: $today }) {
            sum { requests }
            dimensions { actionType }
          }
          r2OperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $monthStart, date_leq: $today }) {
            sum { requests }
            dimensions { actionType }
          }
          r2StorageAdaptiveGroups(limit: 1, filter: { date_geq: $today, date_leq: $today }, orderBy: [date_DESC]) {
            max { payloadSize }
            dimensions { date }
          }
          durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date_geq: $today, date_leq: $today }) {
            sum { requests }
          }
        }
      }
    }`;
  return {
    query,
    variables: { tag: accountTag, dayStart: w.dayStart, dayEnd: w.dayEnd, today: w.today, monthStart: w.monthStart },
  };
}

// ---- defensive extraction helpers ----
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function sumField(groups: unknown, field: string): number | null {
  if (!Array.isArray(groups)) return null;
  let total = 0;
  let seen = false;
  for (const g of groups) {
    const v = num((g as { sum?: Record<string, unknown> })?.sum?.[field]);
    if (v !== null) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Parse a GraphQL response body into whatever metrics we can read. Missing/misshaped
 *  datasets are simply absent from the result (-> unknown downstream). Never throws. */
export function extractMetrics(body: unknown): Partial<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const account = (body as { data?: { viewer?: { accounts?: unknown[] } } })?.data?.viewer?.accounts?.[0] as
      | Record<string, unknown>
      | undefined;
    if (!account) return out;

    // Workers requests (day)
    const workers = sumField(account.workersInvocationsAdaptive, "requests");
    if (workers !== null) out.workers_requests_day = workers;

    // D1 rows read / written (day)
    const d1Read = sumField(account.d1AnalyticsAdaptiveGroups, "readQueries");
    if (d1Read !== null) out.d1_rows_read_day = d1Read;
    const d1Write = sumField(account.d1AnalyticsAdaptiveGroups, "writeQueries");
    if (d1Write !== null) out.d1_rows_written_day = d1Write;

    // KV reads / writes (day) — split by actionType dimension
    const kv = account.kvOperationsAdaptiveGroups;
    if (Array.isArray(kv)) {
      let reads = 0;
      let writes = 0;
      let seenR = false;
      let seenW = false;
      for (const g of kv) {
        const action = String((g as { dimensions?: { actionType?: unknown } })?.dimensions?.actionType ?? "").toLowerCase();
        const v = num((g as { sum?: { requests?: unknown } })?.sum?.requests) ?? 0;
        if (action === "read" || action === "list") {
          reads += v;
          seenR = true;
        } else if (action === "write" || action === "delete") {
          writes += v;
          seenW = true;
        }
      }
      if (seenR) out.kv_reads_day = reads;
      if (seenW) out.kv_writes_day = writes;
    }

    // R2 Class A / B (month) — classify by actionType
    const r2ops = account.r2OperationsAdaptiveGroups;
    if (Array.isArray(r2ops)) {
      let classA = 0;
      let classB = 0;
      let seen = false;
      for (const g of r2ops) {
        const action = String((g as { dimensions?: { actionType?: unknown } })?.dimensions?.actionType ?? "");
        const v = num((g as { sum?: { requests?: unknown } })?.sum?.requests) ?? 0;
        if (R2_CLASS_A_ACTIONS.has(action)) classA += v;
        else classB += v;
        seen = true;
      }
      if (seen) {
        out.r2_class_a_month = classA;
        out.r2_class_b_month = classB;
      }
    }

    // R2 storage (bytes, latest snapshot)
    const r2storage = account.r2StorageAdaptiveGroups;
    if (Array.isArray(r2storage) && r2storage.length > 0) {
      const bytes = num((r2storage[0] as { max?: { payloadSize?: unknown } })?.max?.payloadSize);
      if (bytes !== null) out.r2_storage = bytes;
    }

    // Durable Objects requests (day)
    const doReq = sumField(account.durableObjectsInvocationsAdaptiveGroups, "requests");
    if (doReq !== null) out.do_requests_day = doReq;
  } catch {
    // any structural surprise -> return whatever we already collected (rest -> unknown)
  }
  return out;
}

export interface CfFetchDeps {
  token: string;
  accountId: string;
  fetchImpl?: typeof fetch;
}

/** Fetch usage from Cloudflare GraphQL. Never throws: returns {} on any failure so every
 *  affected metric degrades to status="unknown". */
export async function fetchCloudflareUsage(
  deps: CfFetchDeps,
  now: Date,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<Partial<Record<string, number>>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const { query, variables } = buildUsageQuery(deps.accountId, now);
  try {
    const res = await doFetch(CF_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      log?.("cf graphql non-2xx", { status: res.status });
      return {};
    }
    const body = (await res.json().catch(() => null)) as unknown;
    const errs = (body as { errors?: unknown[] })?.errors;
    if (Array.isArray(errs) && errs.length > 0) {
      // partial data may still be present; extract what we can and note the errors
      log?.("cf graphql returned errors", { errors: errs.length });
    }
    return extractMetrics(body);
  } catch (err) {
    log?.("cf graphql fetch failed", { error: err instanceof Error ? err.message : String(err) });
    return {};
  }
}
