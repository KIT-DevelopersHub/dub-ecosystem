// @dub/observability — canonical source of the x-dub-* header constants plus the
// secret-redaction helper reused by @dub/events publishAudit sanitizer.
// @dub/http and @dub/errors re-export / mirror these; duplicate literals are forbidden.

export const HDR_REQUEST_ID = "x-dub-request-id";
export const HDR_USER_ID = "x-dub-user-id";
export const HDR_CALLER = "x-dub-caller";
export const HDR_INTERNAL = "x-dub-internal";
export const HDR_IDEMPOTENCY_KEY = "x-dub-idempotency-key";

/** Presence-only marker value for x-dub-internal (theme6: no signature in P0). */
export const INTERNAL_HEADER_VALUE = "1";

export const HEADERS = {
  requestId: HDR_REQUEST_ID,
  userId: HDR_USER_ID,
  caller: HDR_CALLER,
  internal: HDR_INTERNAL,
  idempotencyKey: HDR_IDEMPOTENCY_KEY,
} as const;

/** Keys whose values must never reach logs / audit records (case-insensitive). */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
  "private_key",
  "session",
];

const REDACTED = "[REDACTED]";

function isRedactedKey(key: string, keys: ReadonlySet<string>): boolean {
  return keys.has(key.toLowerCase());
}

/**
 * Deep-clone `value`, replacing any property whose key matches a redact key with
 * "[REDACTED]". Cycles are handled; non-plain values pass through by reference.
 */
export function redactSecrets<T>(value: T, redactKeys: readonly string[] = DEFAULT_REDACT_KEYS): T {
  const keys = new Set(redactKeys.map((k) => k.toLowerCase()));
  const seen = new WeakMap<object, unknown>();

  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return seen.get(v as object);
    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      seen.set(v as object, arr);
      for (const item of v) arr.push(walk(item));
      return arr;
    }
    const out: Record<string, unknown> = {};
    seen.set(v as object, out);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isRedactedKey(k, keys) ? REDACTED : walk(val);
    }
    return out;
  };

  return walk(value) as T;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  requestId?: string;
  userId?: string;
  service?: string;
  fields?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

/** Default structured sink: JSON line to console with secrets redacted. */
export const consoleSink: LogSink = (entry) => {
  const safe = redactSecrets(entry);
  console.log(JSON.stringify(safe));
};
