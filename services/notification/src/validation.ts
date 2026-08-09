// HTTP input validation, adhering to the frozen @dub/types notification contracts.
// Hand-rolled (no zod: @dub/types ships zod-free; keeping the service dependency-light
// avoids lockfile churn across the parallel unit build). Each failure → a FieldError
// with the NOTIF_VALIDATION_FAILED envelope (design §6).
import { DubError, errors, type FieldError } from "@dub/errors";
import type { notification } from "@dub/types";
import { CHANNELS, MAX_DIRECT_RECIPIENTS, MAX_QUERY_LIMIT, DEFAULT_QUERY_LIMIT, TITLE_MAX, TITLE_MIN } from "./config";
import { isValidTypePattern } from "./preferences";
import type { NotificationChannel } from "./types";

const CHANNEL_SET: ReadonlySet<string> = new Set(CHANNELS);
// type is open vocabulary but must be a non-empty dot-separated token string.
const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// NOTIF_VALIDATION_FAILED (design §6). errors.validationFailed uses the common
// VALIDATION_FAILED code; the notification contract wants the NOTIF_ prefix.
function notifValidationFailed(fe: FieldError[], message = "notification validation failed"): DubError {
  return new DubError("NOTIF_VALIDATION_FAILED", message, { status: 400, details: fe });
}

/** Validate POST /notify (frozen notification.NotifyRequest). */
export function parseNotifyRequest(body: unknown): notification.NotifyRequest {
  if (!isPlainObject(body)) throw notifValidationFailed([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  const b = body;

  const type = b.type;
  if (typeof type !== "string" || type.length === 0) fe.push({ field: "type", reason: "required" });
  else if (!TYPE_RE.test(type)) fe.push({ field: "type", reason: "invalid_format", message: "dot-separated lowercase tokens" });

  const recipientIds = b.recipientIds;
  if (!Array.isArray(recipientIds)) {
    fe.push({ field: "recipientIds", reason: "required" });
  } else {
    if (recipientIds.length > MAX_DIRECT_RECIPIENTS) fe.push({ field: "recipientIds", reason: "too_long", message: `<= ${MAX_DIRECT_RECIPIENTS}` });
    if (!recipientIds.every((r) => typeof r === "string" && r.length > 0)) fe.push({ field: "recipientIds", reason: "invalid_type" });
  }

  const title = b.title;
  if (typeof title !== "string" || title.length < TITLE_MIN || title.length > TITLE_MAX) {
    fe.push({ field: "title", reason: "invalid_length", message: `${TITLE_MIN}..${TITLE_MAX}` });
  }

  const bodyText = b.body;
  if (typeof bodyText !== "string") fe.push({ field: "body", reason: "required" });

  const channels = b.channels;
  if (channels !== undefined) {
    if (!Array.isArray(channels) || !channels.every((ch) => typeof ch === "string" && CHANNEL_SET.has(ch))) {
      fe.push({ field: "channels", reason: "invalid_enum", message: `subset of ${CHANNELS.join(",")}` });
    }
  }

  const dedupKey = b.dedupKey;
  if (dedupKey !== undefined && typeof dedupKey !== "string") fe.push({ field: "dedupKey", reason: "invalid_type" });

  const resourceType = b.resourceType;
  if (resourceType !== undefined && typeof resourceType !== "string") fe.push({ field: "resourceType", reason: "invalid_type" });
  const resourceId = b.resourceId;
  if (resourceId !== undefined && typeof resourceId !== "string") fe.push({ field: "resourceId", reason: "invalid_type" });

  if (fe.length > 0) throw notifValidationFailed(fe);

  const out: notification.NotifyRequest = {
    type: type as string,
    recipientIds: recipientIds as string[],
    title: title as string,
    body: bodyText as string,
  };
  if (channels !== undefined) out.channels = channels as NotificationChannel[];
  if (dedupKey !== undefined) out.dedupKey = dedupKey as string;
  if (resourceType !== undefined) out.resourceType = resourceType as string;
  if (resourceId !== undefined) out.resourceId = resourceId as string;
  return out;
}

/** Validate GET /inbox query params (frozen ListInboxQuery + CursorQuery). */
export function parseListInboxQuery(q: Record<string, string | undefined>): notification.ListInboxQuery & { limit: number } {
  const fe: FieldError[] = [];
  const out: notification.ListInboxQuery & { limit: number } = { limit: DEFAULT_QUERY_LIMIT };

  if (q.unreadOnly !== undefined && q.unreadOnly !== "") {
    if (q.unreadOnly !== "true" && q.unreadOnly !== "false") fe.push({ field: "unreadOnly", reason: "invalid_bool" });
    else out.unreadOnly = q.unreadOnly === "true";
  }
  if (q.cursor !== undefined && q.cursor !== "") out.cursor = q.cursor;

  if (q.limit !== undefined && q.limit !== "") {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1) fe.push({ field: "limit", reason: "invalid_range" });
    else if (n > MAX_QUERY_LIMIT) fe.push({ field: "limit", reason: "too_large", message: `<= ${MAX_QUERY_LIMIT}` });
    else out.limit = n;
  }

  if (fe.length > 0) throw notifValidationFailed(fe);
  return out;
}

/** Validate POST /inbox/read-all body ({ type?: prefix }). */
export function parseReadAll(body: unknown): { type?: string } {
  if (body === null || body === undefined || body === "") return {};
  if (!isPlainObject(body)) throw notifValidationFailed([{ field: "(root)", reason: "invalid_type" }]);
  const type = body.type;
  if (type === undefined) return {};
  if (typeof type !== "string" || !isValidTypePattern(type)) {
    throw notifValidationFailed([{ field: "type", reason: "invalid_format" }]);
  }
  return { type };
}

/** Validate PATCH /preferences body ({ entries: PreferenceEntry[] }). */
export function parsePreferencesUpdate(body: unknown): notification.PreferenceEntry[] {
  if (!isPlainObject(body) || !Array.isArray(body.entries)) {
    throw notifValidationFailed([{ field: "entries", reason: "required" }]);
  }
  const fe: FieldError[] = [];
  const out: notification.PreferenceEntry[] = [];
  body.entries.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      fe.push({ field: `entries[${i}]`, reason: "invalid_type" });
      return;
    }
    const type = raw.type;
    if (typeof type !== "string" || !isValidTypePattern(type)) {
      // design §6: NOTIF_UNKNOWN_TYPE_PATTERN for pattern-shape violations.
      throw new DubError("NOTIF_UNKNOWN_TYPE_PATTERN", `invalid preference type pattern at entries[${i}]`, {
        status: 400,
        details: [{ field: `entries[${i}].type`, reason: "invalid_pattern" }],
      });
    }
    const channels = raw.channels;
    if (!Array.isArray(channels) || !channels.every((ch) => typeof ch === "string" && CHANNEL_SET.has(ch))) {
      fe.push({ field: `entries[${i}].channels`, reason: "invalid_enum" });
      return;
    }
    out.push({ type, channels: channels as NotificationChannel[] });
  });
  if (fe.length > 0) throw notifValidationFailed(fe);
  return out;
}

export { notifValidationFailed };
