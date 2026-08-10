// @dub/observability — lightweight metrics. Counters / gauges / timings emitted as
// structured lines (one JSON object per metric) so they ride the same log pipeline
// a Worker already has. No aggregation backend, no deps, no background timers.
import type { Correlation } from "./request";

/** Wall-clock now in ms; prefers monotonic performance.now() for durations. */
function nowMs(): number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === "function" ? p.now() : Date.now();
}

export type MetricType = "count" | "gauge" | "timing";

export interface MetricEntry {
  type: MetricType;
  name: string;
  /** count: increment; gauge: absolute value; timing: milliseconds. */
  value: number;
  tags?: Record<string, string>;
  requestId?: string;
  service?: string;
  time: string;
}

export type MetricSink = (metric: MetricEntry) => void;

/** Default sink: one JSON line per metric under a `metric` key. */
export const consoleMetricSink: MetricSink = (metric) => {
  console.log(JSON.stringify({ metric }));
};

export interface MetricsContext {
  requestId?: string;
  service?: string;
  /** Tags merged into every metric; per-call tags win on collision. */
  tags?: Record<string, string>;
  sink?: MetricSink;
}

export interface Metrics {
  /** Increment a counter (default +1). */
  count(name: string, value?: number, tags?: Record<string, string>): void;
  /** Record an absolute value. */
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  /** Record a duration in milliseconds. */
  timing(name: string, ms: number, tags?: Record<string, string>): void;
  /** Start a timer; call the returned fn to record elapsed ms as a timing. */
  startTimer(name: string, tags?: Record<string, string>): () => number;
  /** Derive a child recorder with additional permanently-bound tags. */
  child(tags: Record<string, string>): Metrics;
}

/** Create a metrics recorder that emits structured metric lines to a sink. */
export function createMetrics(ctx: MetricsContext = {}): Metrics {
  const sink = ctx.sink ?? consoleMetricSink;
  const baseTags = ctx.tags ?? {};

  const emit = (type: MetricType, name: string, value: number, tags?: Record<string, string>): void => {
    const merged = { ...baseTags, ...(tags ?? {}) };
    const entry: MetricEntry = { type, name, value, time: new Date().toISOString() };
    if (Object.keys(merged).length > 0) entry.tags = merged;
    if (ctx.requestId !== undefined) entry.requestId = ctx.requestId;
    if (ctx.service !== undefined) entry.service = ctx.service;
    sink(entry);
  };

  return {
    count: (name, value = 1, tags) => emit("count", name, value, tags),
    gauge: (name, value, tags) => emit("gauge", name, value, tags),
    timing: (name, ms, tags) => emit("timing", name, ms, tags),
    startTimer: (name, tags) => {
      const start = nowMs();
      return () => {
        const elapsed = nowMs() - start;
        emit("timing", name, elapsed, tags);
        return elapsed;
      };
    },
    child: (tags) =>
      createMetrics({
        ...ctx,
        tags: { ...baseTags, ...tags },
      }),
  };
}

/** Build a metrics recorder from a correlation triplet (see @dub/observability request helpers). */
export function metricsFor(correlation: Correlation, base: Omit<MetricsContext, "requestId"> = {}): Metrics {
  const ctx: MetricsContext = { ...base };
  if (correlation.requestId !== undefined) ctx.requestId = correlation.requestId;
  if (correlation.caller !== undefined && ctx.service === undefined) ctx.service = correlation.caller;
  return createMetrics(ctx);
}
