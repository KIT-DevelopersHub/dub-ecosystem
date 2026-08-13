// Cloudflare GraphQL Analytics — DATA-DRIVEN. One POST to the account-scoped GraphQL
// endpoint returns usage across several adaptive datasets; a single config (CF_METRIC_MAP
// + CF_CLASSIFIERS) drives BOTH the query we send AND how we extract each metric key.
// Adding a straightforward CF metric = ONE row in CF_METRIC_MAP (dataset+agg+field+window
// +reduce). Classified metrics (KV read/write split, R2 Class A/B) stay as small
// dataset-level handlers keyed by metricKey — the only non-generic bits.
//
// GRACEFUL BY DESIGN: this never throws. A network/auth error returns {} (every CF metric
// then renders as status="unknown"); a per-dataset shape mismatch simply omits that metric
// (also -> unknown). So Cloudflare schema drift or an API hiccup can never break the
// dashboard — it degrades to "unknown", exactly the spec requirement.
//
// The dataset/field names below were verified against the live account GraphQL API (0
// errors, real values returned). Notably: r2StorageAdaptiveGroups is queried WITHOUT an
// orderBy (ordering by `date` there is rejected and null-nukes the WHOLE response); D1 rows
// use rowsRead/rowsWritten (the metered dimension), NOT read/writeQueries.
import { startOfUtcDay, startOfUtcMonth, utcDayString } from "./time";

export const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Cloudflare Class A operations (mutations/list). Everything else counts as Class B.
 *  R2 actionType values are S3-style names (e.g. "HeadBucket" -> Class B via default). */
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

// ---------------------------------------------------------------------------
// Config model
// ---------------------------------------------------------------------------

/** The three usage windows a dataset can be filtered by. Each maps to a GraphQL filter
 *  clause + the variables it needs. Adding a provider with new windows = extend this. */
type CfWindow = "dayDatetime" | "dayDate" | "monthToDate";

/** How to combine the returned rows of a dataset into one number for a metric. */
type CfReduce = "sum" | "sumGroups" | "maxRows";

/** One generic CF metric: dataset + aggregate field + window + row-reduce. One row here
 *  = one metric that appears in the query and is extracted automatically. */
interface CfMetric {
  metricKey: string;
  dataset: string;
  /** aggregate wrapper in the GraphQL selection: sum { field } or max { field }. */
  agg: "sum" | "max";
  field: string;
  window: CfWindow;
  /** sum = add row.sum[field] across rows; sumGroups = add row[agg][field] across grouped
   *  rows (e.g. per-databaseId max); maxRows = take the max row[agg][field]. */
  reduce: CfReduce;
  /** dimensions to group by (required so reduce:"sumGroups" returns one row per group). */
  dimensions?: string[];
}

/** A dataset whose rows are split into MULTIPLE metric keys by a dimension (KV/R2 ops).
 *  Kept as a small special-case handler — the only non-generic extraction. */
interface CfClassifier {
  dataset: string;
  window: CfWindow;
  /** sum fields to request under sum { }. */
  sumFields: string[];
  dimensions: string[];
  /** classify the returned rows into metric keys (never throws; caller guards). */
  extract(rows: unknown[]): Partial<Record<string, number>>;
}

/** GENERIC CF metrics — the common case. Add a new straightforward metric with ONE row. */
export const CF_METRIC_MAP: readonly CfMetric[] = [
  { metricKey: "workers_requests_day", dataset: "workersInvocationsAdaptive", agg: "sum", field: "requests", window: "dayDatetime", reduce: "sum" },
  { metricKey: "d1_rows_read_day", dataset: "d1AnalyticsAdaptiveGroups", agg: "sum", field: "rowsRead", window: "dayDate", reduce: "sum" },
  { metricKey: "d1_rows_written_day", dataset: "d1AnalyticsAdaptiveGroups", agg: "sum", field: "rowsWritten", window: "dayDate", reduce: "sum" },
  // Account-wide D1 storage = SUM of each database's max size (one row per databaseId).
  { metricKey: "d1_storage", dataset: "d1StorageAdaptiveGroups", agg: "max", field: "databaseSizeBytes", window: "dayDate", reduce: "sumGroups", dimensions: ["databaseId"] },
  // R2 stored bytes = the largest snapshot in the window (no orderBy — that errors).
  { metricKey: "r2_storage", dataset: "r2StorageAdaptiveGroups", agg: "max", field: "payloadSize", window: "dayDate", reduce: "maxRows" },
  { metricKey: "do_requests_day", dataset: "durableObjectsInvocationsAdaptiveGroups", agg: "sum", field: "requests", window: "dayDate", reduce: "sum" },
];

// --- number helpers (defensive; never throw) ---
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function aggValue(row: unknown, agg: "sum" | "max", field: string): number | null {
  return num((row as { sum?: Record<string, unknown>; max?: Record<string, unknown> })?.[agg]?.[field]);
}
function dimValue(row: unknown, dim: string): string {
  return String((row as { dimensions?: Record<string, unknown> })?.dimensions?.[dim] ?? "");
}

/** CLASSIFIED CF metrics — dataset rows split by a dimension into several keys. */
export const CF_CLASSIFIERS: readonly CfClassifier[] = [
  {
    // KV: split reads (read/list) vs writes (write/delete). actionType is lower-case.
    dataset: "kvOperationsAdaptiveGroups",
    window: "dayDate",
    sumFields: ["requests"],
    dimensions: ["actionType"],
    extract(rows) {
      let reads = 0;
      let writes = 0;
      let seenR = false;
      let seenW = false;
      for (const g of rows) {
        const action = dimValue(g, "actionType").toLowerCase();
        const v = aggValue(g, "sum", "requests") ?? 0;
        if (action === "read" || action === "list") {
          reads += v;
          seenR = true;
        } else if (action === "write" || action === "delete") {
          writes += v;
          seenW = true;
        }
      }
      const out: Partial<Record<string, number>> = {};
      if (seenR) out.kv_reads_day = reads;
      if (seenW) out.kv_writes_day = writes;
      return out;
    },
  },
  {
    // R2 operations: classify by S3 actionType into Class A vs Class B (default -> B).
    dataset: "r2OperationsAdaptiveGroups",
    window: "monthToDate",
    sumFields: ["requests"],
    dimensions: ["actionType"],
    extract(rows) {
      let classA = 0;
      let classB = 0;
      let seen = false;
      for (const g of rows) {
        const action = dimValue(g, "actionType");
        const v = aggValue(g, "sum", "requests") ?? 0;
        if (R2_CLASS_A_ACTIONS.has(action)) classA += v;
        else classB += v;
        seen = true;
      }
      return seen ? { r2_class_a_month: classA, r2_class_b_month: classB } : {};
    },
  },
];

// ---------------------------------------------------------------------------
// Query builder (from config)
// ---------------------------------------------------------------------------

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

// window -> { GraphQL filter clause, GraphQL var declarations it needs }.
const WINDOW_FILTER: Record<CfWindow, string> = {
  dayDatetime: "datetime_geq: $dayStart, datetime_leq: $dayEnd",
  dayDate: "date_geq: $today, date_leq: $today",
  monthToDate: "date_geq: $monthStart, date_leq: $today",
};
const WINDOW_VARS: Record<CfWindow, { name: string; type: string }[]> = {
  dayDatetime: [
    { name: "dayStart", type: "Time!" },
    { name: "dayEnd", type: "Time!" },
  ],
  dayDate: [{ name: "today", type: "Date!" }],
  monthToDate: [
    { name: "monthStart", type: "Date!" },
    { name: "today", type: "Date!" },
  ],
};

interface DatasetBlock {
  dataset: string;
  window: CfWindow;
  sum: Set<string>;
  max: Set<string>;
  dims: Set<string>;
}

/** Fold the config into one query block per dataset (union of its fields/dimensions). */
function datasetBlocks(): DatasetBlock[] {
  const byDataset = new Map<string, DatasetBlock>();
  const block = (dataset: string, window: CfWindow): DatasetBlock => {
    let b = byDataset.get(dataset);
    if (!b) {
      b = { dataset, window, sum: new Set(), max: new Set(), dims: new Set() };
      byDataset.set(dataset, b);
    }
    return b;
  };
  for (const m of CF_METRIC_MAP) {
    const b = block(m.dataset, m.window);
    (m.agg === "sum" ? b.sum : b.max).add(m.field);
    for (const d of m.dimensions ?? []) b.dims.add(d);
  }
  for (const c of CF_CLASSIFIERS) {
    const b = block(c.dataset, c.window);
    for (const f of c.sumFields) b.sum.add(f);
    for (const d of c.dimensions) b.dims.add(d);
  }
  return [...byDataset.values()];
}

function renderBlock(b: DatasetBlock): string {
  const parts: string[] = [];
  if (b.sum.size) parts.push(`sum { ${[...b.sum].join(" ")} }`);
  if (b.max.size) parts.push(`max { ${[...b.max].join(" ")} }`);
  if (b.dims.size) parts.push(`dimensions { ${[...b.dims].join(" ")} }`);
  return `          ${b.dataset}(limit: 10000, filter: { ${WINDOW_FILTER[b.window]} }) {
            ${parts.join("\n            ")}
          }`;
}

/** The account-scoped GraphQL query + variables, assembled FROM the config. Pure. */
export function buildUsageQuery(accountTag: string, now: Date): { query: string; variables: Record<string, unknown> } {
  const w = usageWindow(now);
  const blocks = datasetBlocks();

  // Only declare/pass the variables the used windows actually need (avoids GraphQL
  // "variable never used" errors if a metric/dataset is later removed).
  const varDecls = new Map<string, string>([["tag", "String!"]]);
  for (const b of blocks) for (const v of WINDOW_VARS[b.window]) varDecls.set(v.name, v.type);
  const declStr = [...varDecls].map(([n, t]) => `$${n}: ${t}`).join(", ");

  const query = `
    query UsageMeter(${declStr}) {
      viewer {
        accounts(filter: { accountTag: $tag }) {
${blocks.map(renderBlock).join("\n")}
        }
      }
    }`;

  const allVars: Record<string, unknown> = {
    tag: accountTag,
    dayStart: w.dayStart,
    dayEnd: w.dayEnd,
    today: w.today,
    monthStart: w.monthStart,
  };
  const variables: Record<string, unknown> = {};
  for (const name of varDecls.keys()) variables[name] = allVars[name];
  return { query, variables };
}

// ---------------------------------------------------------------------------
// Extraction (driven by the SAME config)
// ---------------------------------------------------------------------------

/** Combine a dataset's rows into one number per the metric's reduce rule. */
function reduceRows(rows: unknown[], m: CfMetric): number | null {
  let acc: number | null = null;
  for (const row of rows) {
    const v = aggValue(row, m.agg, m.field);
    if (v === null) continue;
    if (acc === null) acc = v;
    else acc = m.reduce === "maxRows" ? Math.max(acc, v) : acc + v; // sum + sumGroups both add
  }
  return acc;
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

    // generic sum/max metrics
    for (const m of CF_METRIC_MAP) {
      const rows = account[m.dataset];
      if (!Array.isArray(rows)) continue;
      const v = reduceRows(rows, m);
      if (v !== null) out[m.metricKey] = v;
    }

    // classified metrics (KV split, R2 class A/B)
    for (const c of CF_CLASSIFIERS) {
      const rows = account[c.dataset];
      if (!Array.isArray(rows)) continue;
      for (const [k, v] of Object.entries(c.extract(rows))) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
    }
  } catch {
    // any structural surprise -> return whatever we already collected (rest -> unknown)
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch (never throws)
// ---------------------------------------------------------------------------

export interface CfFetchDeps {
  token: string;
  accountId: string;
  fetchImpl?: typeof fetch;
}

/** Fetch usage from Cloudflare GraphQL. Never throws: returns {} on any failure so every
 *  affected metric degrades to status="unknown". A partial (per-dataset) error still
 *  yields the metrics that DID resolve. */
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
