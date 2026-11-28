// "What is consuming" for the escalation Issue (#902): the top contributors of a metric
// from Cloudflare GraphQL Analytics. Used by the usage-escalation workflow (not the Worker).
// Each kind is its own request so one bad dataset never blanks the others; failures come
// back as { error } and the Issue says to run the runbook query by hand.
// The d1QueriesAdaptiveGroups query is the one used to find PR #911's top queries.
import type { ConsumerKind } from "./playbook";
import { startOfUtcDay, startOfUtcMonth, utcDayString } from "./time";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const TOP_N = 5;
const QUERY_TEXT_MAX = 160;

export interface ConsumerLine {
  name: string;
  value: number;
  /** share of the listed total, 0-100 (1 decimal). */
  share: number;
}

export type ConsumerResult = { lines: ConsumerLine[]; note?: string } | { error: string };

interface Spec {
  query: string;
  variables: (accountTag: string, now: Date) => Record<string, unknown>;
  rows: (account: Record<string, unknown>) => unknown[];
  name: (row: Row) => string;
  value: (row: Row) => number;
}

type Row = { dimensions?: Record<string, unknown>; sum?: Record<string, unknown>; max?: Record<string, unknown> };

const dayTime = (accountTag: string, now: Date) => ({
  a: accountTag,
  s: startOfUtcDay(now).toISOString(),
  e: now.toISOString(),
});
const dayDate = (accountTag: string, now: Date) => ({ a: accountTag, s: utcDayString(now), e: utcDayString(now) });
const monthDate = (accountTag: string, now: Date) => ({
  a: accountTag,
  s: utcDayString(startOfUtcMonth(now)),
  e: utcDayString(now),
});

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const dim = (r: Row, k: string) => s(r.dimensions?.[k]);
const list = (key: string) => (acc: Record<string, unknown>) => (Array.isArray(acc[key]) ? (acc[key] as unknown[]) : []);

function shorten(q: string): string {
  const one = q.replace(/\s+/g, " ").trim();
  return one.length > QUERY_TEXT_MAX ? `${one.slice(0, QUERY_TEXT_MAX)}…` : one;
}

const d1Queries = (field: "rowsRead" | "rowsWritten"): Spec => ({
  query: `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){d1QueriesAdaptiveGroups(limit:${TOP_N},filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[sum_${field}_DESC]){sum{rowsRead rowsWritten} count dimensions{databaseId query}}}}}`,
  variables: dayTime,
  rows: list("d1QueriesAdaptiveGroups"),
  name: (r) => `\`${shorten(dim(r, "query"))}\``,
  value: (r) => n(r.sum?.[field]),
});

const SPECS: Partial<Record<ConsumerKind, Spec>> = {
  d1_rows_read: d1Queries("rowsRead"),
  d1_rows_written: d1Queries("rowsWritten"),
  d1_storage: {
    query: `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){d1StorageAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){max{databaseSizeBytes} dimensions{databaseId}}}}}`,
    variables: dayDate,
    rows: list("d1StorageAdaptiveGroups"),
    name: (r) => `D1 ${dim(r, "databaseId")}`,
    value: (r) => n(r.max?.databaseSizeBytes),
  },
  workers: {
    query: `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests} dimensions{scriptName}}}}}`,
    variables: dayTime,
    rows: list("workersInvocationsAdaptive"),
    name: (r) => `Worker ${dim(r, "scriptName")}`,
    value: (r) => n(r.sum?.requests),
  },
  durable_objects: {
    query: `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{scriptName}}}}}`,
    variables: dayDate,
    rows: list("durableObjectsInvocationsAdaptiveGroups"),
    name: (r) => `Worker ${dim(r, "scriptName")}`,
    value: (r) => n(r.sum?.requests),
  },
  kv: {
    query: `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){kvOperationsAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{namespaceId actionType}}}}}`,
    variables: dayDate,
    rows: list("kvOperationsAdaptiveGroups"),
    name: (r) => `KV ${dim(r, "namespaceId")} (${dim(r, "actionType")})`,
    value: (r) => n(r.sum?.requests),
  },
  r2_ops: {
    query: `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){r2OperationsAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{bucketName actionType}}}}}`,
    variables: monthDate,
    rows: list("r2OperationsAdaptiveGroups"),
    name: (r) => `R2 ${dim(r, "bucketName")} (${dim(r, "actionType")})`,
    value: (r) => n(r.sum?.requests),
  },
  r2_storage: {
    query: `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){r2StorageAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){max{payloadSize} dimensions{bucketName}}}}}`,
    variables: dayDate,
    rows: list("r2StorageAdaptiveGroups"),
    name: (r) => `R2 ${dim(r, "bucketName")}`,
    value: (r) => n(r.max?.payloadSize),
  },
};

/** Kinds with no GraphQL breakdown (answered by the runbook instead). */
const MANUAL_NOTE: Partial<Record<ConsumerKind, string>> = {
  email: "メール送信の内訳は D1 の mail_send_log で見ます（手順書「調べ方」の SQL）。",
  google: "Google API の内訳は GCP コンソールの「API とサービス → 指標」で見ます。",
};

/** Merge same-name rows, take the top N, and add each one's share of the total. */
export function topLines(rows: readonly { name: string; value: number }[], topN = TOP_N): ConsumerLine[] {
  const merged = new Map<string, number>();
  for (const r of rows) merged.set(r.name, (merged.get(r.name) ?? 0) + r.value);
  const total = [...merged.values()].reduce((a, b) => a + b, 0);
  return [...merged.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name, value]) => ({ name, value, share: total > 0 ? Math.round((value / total) * 1000) / 10 : 0 }));
}

export interface ConsumerOptions {
  token: string | null;
  accountId: string | null;
  now: Date;
  fetch?: typeof fetch;
}

export async function fetchTopConsumers(kind: ConsumerKind, opts: ConsumerOptions): Promise<ConsumerResult> {
  const manual = MANUAL_NOTE[kind];
  if (manual) return { lines: [], note: manual };
  const spec = SPECS[kind];
  if (!spec) return { error: "この項目の内訳クエリはありません" };
  if (!opts.token || !opts.accountId) return { error: "Cloudflare のトークンかアカウント ID が無いため取得していません" };
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await f(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: spec.query, variables: spec.variables(opts.accountId, opts.now) }),
    });
    if (!res.ok) return { error: `GraphQL HTTP ${res.status}` };
    const json = (await res.json()) as {
      data?: { viewer?: { accounts?: Record<string, unknown>[] } } | null;
      errors?: { message?: string }[] | null;
    };
    if (json.errors && json.errors.length > 0) return { error: `GraphQL: ${s(json.errors[0]?.message)}` };
    const account = json.data?.viewer?.accounts?.[0];
    if (!account) return { error: "GraphQL の応答にアカウントがありません" };
    const rows = spec.rows(account) as Row[];
    return { lines: topLines(rows.map((r) => ({ name: spec.name(r), value: spec.value(r) }))) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
