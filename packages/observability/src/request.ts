// @dub/observability — request-correlation helpers. These READ and PROPAGATE the
// x-dub-* headers; they never mint a requestId (that is @dub/http's job, the single
// ULID entrypoint minter). Kept dependency-free so any Worker can correlate logs.
import { HDR_REQUEST_ID, HDR_USER_ID, HDR_CALLER } from "./index";
import type { HeaderSource } from "./logger";

function isHeaders(v: unknown): v is Headers {
  return typeof (v as { get?: unknown } | null)?.get === "function";
}

/** Read a single header (case-insensitive) from a Headers, Request, or plain map. */
export function readHeader(source: HeaderSource, name: string): string | undefined {
  if (!source) return undefined;
  const headers: unknown = source instanceof Request ? source.headers : source;
  if (isHeaders(headers)) {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | undefined>;
  const direct = rec[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, val] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) return val;
  }
  return undefined;
}

/** Read the correlation id (x-dub-request-id) off an incoming request, if present. */
export function readRequestId(source: HeaderSource): string | undefined {
  return readHeader(source, HDR_REQUEST_ID);
}

export interface Correlation {
  requestId?: string;
  userId?: string;
  caller?: string;
}

/**
 * Build the x-dub-* header pairs to attach to an OUTGOING request so the trace
 * propagates to the downstream service. Only defined fields are emitted.
 */
export function correlationHeaders(ctx: Correlation): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.requestId !== undefined) out[HDR_REQUEST_ID] = ctx.requestId;
  if (ctx.userId !== undefined) out[HDR_USER_ID] = ctx.userId;
  if (ctx.caller !== undefined) out[HDR_CALLER] = ctx.caller;
  return out;
}

/** Extract the correlation triplet from an incoming request in one call. */
export function readCorrelation(source: HeaderSource): Correlation {
  const out: Correlation = {};
  const requestId = readRequestId(source);
  const userId = readHeader(source, HDR_USER_ID);
  const caller = readHeader(source, HDR_CALLER);
  if (requestId !== undefined) out.requestId = requestId;
  if (userId !== undefined) out.userId = userId;
  if (caller !== undefined) out.caller = caller;
  return out;
}
