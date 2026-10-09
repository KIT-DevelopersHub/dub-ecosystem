// Operate executor: plan -> preview (reads run, writes resolved, nothing written) ->
// execute (writes run one call per target, then every target is read back) -> verdict.
//
// Guarantees, in order of the incident they prevent:
//   - only catalog routes are callable (parsePlan rejects anything else);
//   - read results are bound into later steps; a value still looking like a placeholder
//     blocks the preview, so `<EVENT_ID>` can never reach the API;
//   - at most MAX_WRITE_CALLS writes per execution (bulk work must be narrowed first);
//   - a preview executes at most once and expires;
//   - every write is verified by re-reading it, and the verdict is always one of
//     反映できた / 一部できなかった / できなかった with per-target outcomes;
//   - every execution is appended to the audit log.

import { randomUUID } from "node:crypto";
import { findEntry, pathParams, type CatalogEntry, type OpKind, type OpRisk, type VerifyValue } from "./catalog.ts";
import { describeFailure, environmentLabel, type GatewayClient, type GatewayResponse } from "./gateway.ts";
import { findPlaceholders, getPath, matchesWhere, resolveValue, type Plan } from "./plan.ts";

export const MAX_WRITE_CALLS = 20;
export const MAX_READ_CALLS = 30;
export const PREVIEW_TTL_MS = 30 * 60_000;
const SAMPLE_CHARS = 1500;

export interface PreviewCall {
  callId: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  params: Record<string, string>;
  /** Who/what this call touches, in words. */
  target: string;
  /** Current values of the fields being changed (when the target was read first). */
  before?: Record<string, unknown>;
}

export interface PreviewWrite {
  stepId: string;
  entryId: string;
  kind: OpKind;
  risk: OpRisk;
  reversible: boolean;
  description: string;
  impact: string;
  fieldLabels?: Record<string, string>;
  calls: PreviewCall[];
}

export interface ReadSummary {
  stepId: string;
  entryId: string;
  description: string;
  ok: boolean;
  count?: number;
  /** Truncated JSON for the planner's context; the UI keeps it under 詳細. */
  sample?: string;
  error?: string;
}

export interface Preview {
  previewId: string;
  summary: string;
  environment: string;
  reads: ReadSummary[];
  writes: PreviewWrite[];
  blockers: string[];
  expiresAt: string;
}

export type CallOutcome = "ok" | "unverified" | "failed" | "skipped";
export interface CallResult {
  callId: string;
  stepId: string;
  target: string;
  outcome: CallOutcome;
  message: string;
}

export type Verdict = "done" | "partial" | "failed";
export interface ExecutionResult {
  previewId: string;
  verdict: Verdict;
  headline: string;
  results: CallResult[];
  executedAt: string;
}

export interface AuditSink {
  append(record: Record<string, unknown>): void;
}

const itemsOf = (data: unknown): unknown[] | undefined =>
  Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : undefined;

/** No answer, or a gateway/upstream failure: the write may or may not have been applied. */
const isAmbiguous = (status: number): boolean => status === 0 || status >= 500;

const stripBraces = (expr: string): string => expr.replace(/^\s*\{\{\s*|\s*\}\}\s*$/g, "");

function buildPath(entry: CatalogEntry, params: Record<string, string>): string {
  return entry.path.replace(/:([A-Za-z]+)/g, (_m, p: string) => encodeURIComponent(params[p] ?? ""));
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries((v ?? {}) as Record<string, unknown>)) {
    if (x !== undefined && x !== null) out[k] = typeof x === "string" ? x : JSON.stringify(x);
  }
  return out;
}

function defaultTarget(entry: CatalogEntry, params: Record<string, string>, item: unknown): string {
  const it = (item ?? {}) as Record<string, unknown>;
  const name = [it.title, it.displayName, it.name, it.address, it.email].find((x) => typeof x === "string");
  return (name as string | undefined) ?? (Object.values(params)[0] || entry.description);
}

export class OperateExecutor {
  private readonly previews = new Map<string, { preview: Preview; expires: number }>();
  // Plain fields, not parameter properties: the daemon runs under node's strip-only TS.
  private readonly gateway: GatewayClient;
  private readonly audit: AuditSink;
  private readonly now: () => number;

  constructor(gateway: GatewayClient, audit: AuditSink, now: () => number = Date.now) {
    this.gateway = gateway;
    this.audit = audit;
    this.now = now;
  }

  /** Run the reads, resolve every write into concrete calls, write nothing. */
  async preview(plan: Plan): Promise<Preview> {
    const scope: Record<string, unknown> = {};
    const reads: ReadSummary[] = [];
    const writes: PreviewWrite[] = [];
    const blockers: string[] = [];
    let readCalls = 0;

    for (const [i, step] of plan.steps.entries()) {
      const at = `手順${i + 1}`;
      const entry = findEntry(step.op)!;
      let items: unknown[] = [undefined];
      if (step.forEach) {
        const list = getPath(scope, stripBraces(step.forEach));
        const arr = itemsOf(list);
        if (!arr) {
          blockers.push(`${at}: 繰り返し対象「${step.forEach}」が前の読み取り結果にありません`);
          continue;
        }
        items = arr.filter((item) => matchesWhere(item, step.where ?? [], scope));
      }

      const calls: PreviewCall[] = [];
      for (const item of items) {
        const local = item === undefined ? scope : { ...scope, item };
        const params = stringRecord(resolveValue(step.params ?? {}, local));
        const query = stringRecord(resolveValue(step.query ?? {}, local));
        const body = step.body ? (resolveValue(step.body, local) as Record<string, unknown>) : undefined;
        const problems = findPlaceholders({ params, query, ...(body ? { body } : {}) });
        for (const p of pathParams(entry.path)) if (!params[p]) problems.push(`params.${p}`);
        for (const k of entry.body?.required ?? []) if (body?.[k] === undefined || body[k] === "") problems.push(`body.${k}`);
        if (problems.length) {
          blockers.push(`${at}: ${[...new Set(problems)].join("・")} が決まっていません（読み取り結果から埋められませんでした）`);
          break;
        }
        const before =
          body && item && typeof item === "object"
            ? Object.fromEntries(Object.keys(body).filter((k) => k !== "version" && k in item).map((k) => [k, (item as Record<string, unknown>)[k]]))
            : undefined;
        calls.push({
          callId: `${step.id}#${calls.length + 1}`,
          method: entry.method,
          path: buildPath(entry, params),
          ...(Object.keys(query).length ? { query } : {}),
          ...(body ? { body } : {}),
          params,
          target: step.label ? String(resolveValue(step.label, local)) : defaultTarget(entry, params, item),
          ...(before && Object.keys(before).length ? { before } : {}),
        });
      }
      if (blockers.length) break;

      if (entry.kind === "read") {
        readCalls += calls.length;
        if (readCalls > MAX_READ_CALLS) {
          blockers.push(`${at}: 読み取りが上限（${MAX_READ_CALLS}回）を超えます。対象を絞ってください`);
          break;
        }
        const results: unknown[] = [];
        let failure: string | undefined;
        for (const c of calls) {
          const res = await this.call(c);
          if (!res.ok) {
            failure = describeFailure(res);
            break;
          }
          results.push(res.data);
        }
        const data = step.forEach ? results : results[0];
        scope[step.id] = data;
        const count = step.forEach ? results.length : itemsOf(data)?.length;
        reads.push({
          stepId: step.id,
          entryId: entry.id,
          description: entry.description,
          ok: !failure,
          ...(count !== undefined ? { count } : {}),
          ...(failure ? { error: failure } : { sample: JSON.stringify(data).slice(0, SAMPLE_CHARS) }),
        });
        if (failure) {
          blockers.push(`${at}: 読み取りに失敗しました — ${failure}`);
          break;
        }
        continue;
      }

      writes.push({
        stepId: step.id,
        entryId: entry.id,
        kind: entry.kind,
        risk: entry.risk,
        reversible: entry.reversible,
        description: entry.description,
        impact: entry.impact.replace("{count}", String(calls.length)),
        ...(entry.fieldLabels ? { fieldLabels: entry.fieldLabels } : {}),
        calls,
      });
    }

    const writeCalls = writes.reduce((n, w) => n + w.calls.length, 0);
    if (writeCalls > MAX_WRITE_CALLS) {
      blockers.push(`書き込みが${writeCalls}件あり、1回の上限（${MAX_WRITE_CALLS}件）を超えています。対象を絞ってください`);
    }
    if (writes.length > 0 && writeCalls === 0 && blockers.length === 0) {
      blockers.push("条件に合う対象が0件でした。何も変更しません");
    }

    const expires = this.now() + PREVIEW_TTL_MS;
    const preview: Preview = {
      previewId: randomUUID(),
      summary: plan.summary,
      environment: environmentLabel(this.gateway.baseUrl),
      reads,
      writes,
      blockers,
      expiresAt: new Date(expires).toISOString(),
    };
    if (writes.length && !blockers.length) this.previews.set(preview.previewId, { preview, expires });
    return preview;
  }

  /** Execute a stored preview once. `skip` = callIds the operator removed (対象を減らす). */
  async execute(previewId: string, skip: string[] = []): Promise<ExecutionResult | { error: string }> {
    const stored = this.previews.get(previewId);
    this.previews.delete(previewId);
    if (!stored || stored.expires < this.now()) {
      return { error: "この計画は期限切れか、すでに実行済みです。もう一度確認してから実行してください" };
    }
    const skipped = new Set(skip);
    const results: CallResult[] = [];
    const written: { entry: CatalogEntry; call: PreviewCall; result: CallResult; ambiguous: boolean }[] = [];

    // Write everything first, then read back once per list (a list re-read after all
    // writes reflects every target, so it is fetched a single time).
    for (const w of stored.preview.writes) {
      const entry = findEntry(w.entryId)!;
      for (const c of w.calls) {
        const base = { callId: c.callId, stepId: w.stepId, target: c.target };
        if (skipped.has(c.callId)) {
          results.push({ ...base, outcome: "skipped", message: "対象から外しました" });
          continue;
        }
        const res = await this.call(c);
        const ambiguous = !res.ok && isAmbiguous(res.status);
        const result: CallResult = res.ok
          ? { ...base, outcome: "ok", message: "反映を確認しました" }
          : { ...base, outcome: "failed", message: describeFailure(res) };
        results.push(result);
        if (res.ok || ambiguous) written.push({ entry, call: c, result, ambiguous });
      }
    }
    const readCache = new Map<string, GatewayResponse>();
    for (const { entry, call, result, ambiguous } of written) {
      const mismatch = await this.verify(entry, call, readCache);
      if (ambiguous) {
        // A timeout/5xx says nothing about whether the write landed; the read-back decides.
        if (!mismatch) {
          result.outcome = "ok";
          result.message = "応答はエラーでしたが、読み直すと反映されていました";
        } else {
          result.message = `${result.message}。読み直しても反映は確認できませんでした`;
        }
      } else if (mismatch) {
        result.outcome = "unverified";
        result.message = `書き込みは受け付けられましたが、読み直すと反映を確認できませんでした（${mismatch}）`;
      }
    }

    const done = results.filter((r) => r.outcome !== "skipped");
    const ok = done.filter((r) => r.outcome === "ok").length;
    const ng = done.length - ok;
    const verdict: Verdict = done.length > 0 && ng === 0 ? "done" : ok > 0 ? "partial" : "failed";
    const headline =
      verdict === "done" ? `反映できました（${ok}件すべて読み直して確認済み）`
      : verdict === "partial" ? `一部できませんでした（反映 ${ok}件／未反映 ${ng}件）`
      : `できませんでした（${done.length}件すべて未反映）`;
    const result: ExecutionResult = { previewId, verdict, headline, results, executedAt: new Date(this.now()).toISOString() };

    this.audit.append({
      at: result.executedAt,
      previewId,
      environment: stored.preview.environment,
      apiBase: this.gateway.baseUrl,
      summary: stored.preview.summary,
      verdict,
      calls: stored.preview.writes.flatMap((w) =>
        w.calls.map((c) => ({
          entryId: w.entryId,
          method: c.method,
          path: c.path,
          body: c.body,
          outcome: results.find((r) => r.callId === c.callId)?.outcome,
        })),
      ),
    });
    return result;
  }

  private async call(c: { method: string; path: string; query?: Record<string, string>; body?: unknown }): Promise<GatewayResponse> {
    try {
      return await this.gateway.request(c);
    } catch (e) {
      return { status: 0, ok: false, data: { error: (e as Error).message } };
    }
  }

  /** Re-read the target; returns a Japanese mismatch reason, or null when it matches. */
  private async verify(entry: CatalogEntry, c: PreviewCall, cache: Map<string, GatewayResponse>): Promise<string | null> {
    const spec = entry.verify;
    if (!spec) return null;
    const read = findEntry(spec.read)!;
    const src = (v: VerifyValue): VerifyValue | undefined =>
      typeof v === "string" && v.startsWith("$params.") ? c.params[v.slice(8)]
      : typeof v === "string" && v.startsWith("$body.") ? (c.body?.[v.slice(6)] as VerifyValue | undefined)
      : v;
    const params = Object.fromEntries(Object.entries(spec.params ?? {}).map(([k, v]) => [k, String(src(v) ?? "")]));
    const req = { method: "GET", path: buildPath(read, params), ...(spec.query ? { query: spec.query } : {}) };
    const key = `${req.path}?${JSON.stringify(spec.query ?? {})}`;
    let res = cache.get(key);
    if (!res) {
      res = await this.call(req);
      cache.set(key, res);
    }
    if (!res.ok) return `読み直しに失敗: ${describeFailure(res)}`;
    let target: unknown = res.data;
    if (spec.findIn && spec.findBy) {
      const [field, source] = spec.findBy;
      const want = src(source);
      target = itemsOf(getPath(res.data, spec.findIn) ?? res.data)?.find((x) => getPath(x, field) === want);
      if (!target) return "読み直した一覧に対象が見つかりません";
    }
    const expected: Record<string, VerifyValue | undefined> = {};
    for (const [k, v] of Object.entries(spec.expect ?? {})) expected[k] = v === "$notNull" ? v : src(v);
    if (spec.expectBody) {
      for (const [k, v] of Object.entries(c.body ?? {})) if (!spec.expectBody.except.includes(k)) expected[k] = v as VerifyValue;
    }
    for (const [k, want] of Object.entries(expected)) {
      const got = getPath(target, k);
      const same =
        want === "$notNull" ? got != null
        : got === want || (typeof got === "string" && typeof want === "string" && !Number.isNaN(Date.parse(want)) && Date.parse(got) === Date.parse(want));
      if (!same) return `${entry.fieldLabels?.[k] ?? k} が期待した値になっていません`;
    }
    return null;
  }
}
