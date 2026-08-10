// @dub/observability — createLogger: a tiny structured logger that binds a
// requestId (and other correlation fields) into every line and redacts secrets.
// Cloudflare Workers–safe, zero runtime deps. requestId minting lives in @dub/http
// (the ULID entrypoint minter); this logger only *carries* whatever id it is given.
import type { LogEntry, LogLevel, LogSink } from "./index";
import { consoleSink, redactSecrets } from "./index";
import { readRequestId, readHeader } from "./request";
import { HDR_USER_ID, HDR_CALLER } from "./index";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Anything a Worker fetch handler already holds that carries x-dub-* headers. */
export type HeaderSource = Headers | Request | Record<string, string | undefined> | undefined;

export interface LoggerContext {
  /** Correlation id echoed on every line. Read from headers via `requestLogger`. */
  requestId?: string;
  /** Verified end-user id (never a secret; safe to log). */
  userId?: string;
  /** Originating service name (e.g. "api-gateway"). */
  caller?: string;
  /** Logical service emitting the line; defaults to `caller`. */
  service?: string;
  /** Fields merged into every line; per-call fields win on key collision. */
  fields?: Record<string, unknown>;
  /** Where lines go. Defaults to {@link consoleSink} (JSON line, redacted). */
  sink?: LogSink;
  /** Extra key names to redact on top of the built-in defaults. */
  redactKeys?: readonly string[];
  /** Drop lines below this level. Defaults to "debug" (emit everything). */
  minLevel?: LogLevel;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Derive a child logger with additional permanently-bound fields. */
  child(fields: Record<string, unknown>): Logger;
  /** The requestId this logger stamps onto every line, if any. */
  readonly requestId: string | undefined;
  /** The permanently-bound fields (frozen snapshot). */
  readonly bindings: Readonly<Record<string, unknown>>;
}

/**
 * Create a structured logger. Every `info/warn/error/debug` call emits one
 * {@link LogEntry} to the sink with the bound requestId/userId/service and a
 * `time` stamp; secrets in fields are redacted by the sink.
 */
export function createLogger(ctx: LoggerContext = {}): Logger {
  const sink = ctx.sink ?? consoleSink;
  const service = ctx.service ?? ctx.caller;
  const bound = { ...(ctx.fields ?? {}) };
  const floor = LEVEL_ORDER[ctx.minLevel ?? "debug"];

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < floor) return;
    const merged =
      fields || Object.keys(bound).length > 0 ? { ...bound, ...(fields ?? {}) } : undefined;
    const entry: LogEntry = {
      level,
      message,
      time: new Date().toISOString(),
    };
    if (ctx.requestId !== undefined) entry.requestId = ctx.requestId;
    if (ctx.userId !== undefined) entry.userId = ctx.userId;
    if (ctx.caller !== undefined) entry.caller = ctx.caller;
    if (service !== undefined) entry.service = service;
    if (merged && Object.keys(merged).length > 0) {
      // Redact eagerly so a custom (non-console) sink can never see raw secrets.
      entry.fields = redactSecrets(merged, ctx.redactKeys);
    }
    sink(entry);
  };

  const make = (localBound: Record<string, unknown>): Logger => ({
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) =>
      createLogger({
        ...ctx,
        fields: { ...localBound, ...fields },
      }),
    get requestId() {
      return ctx.requestId;
    },
    get bindings() {
      return Object.freeze({ ...localBound });
    },
  });

  return make(bound);
}

/**
 * Convenience: build a request-scoped logger straight from the incoming request's
 * x-dub-* headers, so log lines correlate with the caller's trace automatically.
 * Does not mint a requestId — if the header is absent, `requestId` is left unset
 * (mint it upstream at the entrypoint with @dub/http `newRequestId`).
 */
export function requestLogger(source: HeaderSource, base: Omit<LoggerContext, "requestId" | "userId" | "caller"> = {}): Logger {
  const requestId = readRequestId(source);
  const userId = readHeader(source, HDR_USER_ID);
  const caller = readHeader(source, HDR_CALLER);
  const ctx: LoggerContext = { ...base };
  if (requestId !== undefined) ctx.requestId = requestId;
  if (userId !== undefined) ctx.userId = userId;
  if (caller !== undefined) ctx.caller = caller;
  return createLogger(ctx);
}
