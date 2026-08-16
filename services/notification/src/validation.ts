// HTTP input validation, adhering to the frozen @dub/types notification contracts.
// Hand-rolled (no zod: @dub/types ships zod-free; keeping the service dependency-light
// avoids lockfile churn across the parallel unit build). Each failure → a FieldError
// with the NOTIF_VALIDATION_FAILED envelope (design §6).
import { DubError, errors, type FieldError } from "@dub/errors";
import type { notification } from "@dub/types";
import {
  CHANNELS,
  MAX_DIRECT_RECIPIENTS,
  MAX_QUERY_LIMIT,
  DEFAULT_QUERY_LIMIT,
  TITLE_MAX,
  TITLE_MIN,
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_PAGE_URL_MAX,
  FEEDBACK_PAGE_NAME_MAX,
  RELEASE_TITLE_MAX,
  RELEASE_BODY_MAX,
  RELEASE_APP_MAX,
} from "./config";
import type { ReleaseInput } from "./release";
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

  // Optional role fan-out: expanded to user ids by the ingest recipient resolver. When
  // present + non-empty, recipientIds may be empty (at least one of the two must resolve).
  const recipientRoles = b.recipientRoles;
  let hasRoles = false;
  if (recipientRoles !== undefined) {
    if (!Array.isArray(recipientRoles) || !recipientRoles.every((r) => typeof r === "string" && r.length > 0)) {
      fe.push({ field: "recipientRoles", reason: "invalid_type" });
    } else {
      if (recipientRoles.length > MAX_DIRECT_RECIPIENTS) fe.push({ field: "recipientRoles", reason: "too_long", message: `<= ${MAX_DIRECT_RECIPIENTS}` });
      hasRoles = recipientRoles.length > 0;
    }
  }
  // Require at least one recipient source (ids or roles).
  if (Array.isArray(recipientIds) && recipientIds.length === 0 && !hasRoles) {
    fe.push({ field: "recipientIds", reason: "required", message: "recipientIds or recipientRoles must be non-empty" });
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
  if (hasRoles) out.recipientRoles = recipientRoles as string[];
  if (channels !== undefined) out.channels = channels as NotificationChannel[];
  if (dedupKey !== undefined) out.dedupKey = dedupKey as string;
  if (resourceType !== undefined) out.resourceType = resourceType as string;
  if (resourceId !== undefined) out.resourceId = resourceId as string;
  return out;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/** Validate POST /release body (admin release-note publish). */
export function parseReleaseRequest(body: unknown): ReleaseInput {
  if (!isPlainObject(body)) throw notifValidationFailed([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  const b = body;

  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title || title.length > RELEASE_TITLE_MAX) {
    fe.push({ field: "title", reason: "invalid_length", message: `1..${RELEASE_TITLE_MAX}` });
  }

  const bodyText = typeof b.body === "string" ? b.body.trim() : "";
  if (!bodyText || bodyText.length > RELEASE_BODY_MAX) {
    fe.push({ field: "body", reason: "invalid_length", message: `1..${RELEASE_BODY_MAX}` });
  }

  let app: string | undefined;
  if (b.app !== undefined && b.app !== null && b.app !== "") {
    if (typeof b.app !== "string" || b.app.length > RELEASE_APP_MAX) {
      fe.push({ field: "app", reason: "invalid_length", message: `<= ${RELEASE_APP_MAX}` });
    } else {
      app = b.app.trim();
    }
  }

  let publishedAt: string | undefined;
  if (b.publishedAt !== undefined && b.publishedAt !== null && b.publishedAt !== "") {
    if (typeof b.publishedAt !== "string" || !ISO_DATE_RE.test(b.publishedAt)) {
      fe.push({ field: "publishedAt", reason: "invalid_format", message: "ISO8601 date/datetime" });
    } else {
      publishedAt = b.publishedAt;
    }
  }

  let dedupKey: string | undefined;
  if (b.dedupKey !== undefined && b.dedupKey !== null && b.dedupKey !== "") {
    if (typeof b.dedupKey !== "string") fe.push({ field: "dedupKey", reason: "invalid_type" });
    else dedupKey = b.dedupKey;
  }

  if (fe.length > 0) throw notifValidationFailed(fe);

  const out: ReleaseInput = { title, body: bodyText };
  if (app !== undefined) out.app = app;
  if (publishedAt !== undefined) out.publishedAt = publishedAt;
  if (dedupKey !== undefined) out.dedupKey = dedupKey;
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
  if (q.sort !== undefined && q.sort !== "") {
    if (q.sort !== "newest" && q.sort !== "oldest") fe.push({ field: "sort", reason: "invalid_enum" });
    else out.sort = q.sort;
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

const FEEDBACK_CATEGORY_SET: ReadonlySet<string> = new Set(FEEDBACK_CATEGORIES);

/** Validate POST /feedback body (notification.CreateFeedbackRequest). */
export function parseCreateFeedback(body: unknown): notification.CreateFeedbackRequest {
  if (!isPlainObject(body)) throw notifValidationFailed([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  const b = body;

  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) fe.push({ field: "message", reason: "required" });
  else if (message.length > FEEDBACK_MESSAGE_MAX) {
    fe.push({ field: "message", reason: "too_long", message: `<= ${FEEDBACK_MESSAGE_MAX}` });
  }

  let category: notification.FeedbackCategory | undefined;
  if (b.category !== undefined) {
    if (typeof b.category !== "string" || !FEEDBACK_CATEGORY_SET.has(b.category)) {
      fe.push({ field: "category", reason: "invalid_enum", message: `one of ${FEEDBACK_CATEGORIES.join(",")}` });
    } else {
      category = b.category as notification.FeedbackCategory;
    }
  }

  let page: { url?: string; name?: string } | undefined;
  if (b.page !== undefined && b.page !== null) {
    if (!isPlainObject(b.page)) {
      fe.push({ field: "page", reason: "invalid_type" });
    } else {
      const url = b.page.url;
      const name = b.page.name;
      if (url !== undefined) {
        if (typeof url !== "string") fe.push({ field: "page.url", reason: "invalid_type" });
        else if (url.length > FEEDBACK_PAGE_URL_MAX) fe.push({ field: "page.url", reason: "too_long", message: `<= ${FEEDBACK_PAGE_URL_MAX}` });
      }
      if (name !== undefined) {
        if (typeof name !== "string") fe.push({ field: "page.name", reason: "invalid_type" });
        else if (name.length > FEEDBACK_PAGE_NAME_MAX) fe.push({ field: "page.name", reason: "too_long", message: `<= ${FEEDBACK_PAGE_NAME_MAX}` });
      }
      const p: { url?: string; name?: string } = {};
      if (typeof url === "string" && url.trim()) p.url = url.trim();
      if (typeof name === "string" && name.trim()) p.name = name.trim();
      if (p.url !== undefined || p.name !== undefined) page = p;
    }
  }

  if (fe.length > 0) throw notifValidationFailed(fe);

  const out: notification.CreateFeedbackRequest = { message };
  if (category !== undefined) out.category = category;
  if (page !== undefined) out.page = page;
  return out;
}

/** Validate GET /feedback query params (notification.ListFeedbackQuery + CursorQuery). */
export function parseListFeedbackQuery(q: Record<string, string | undefined>): notification.ListFeedbackQuery & { limit: number } {
  const fe: FieldError[] = [];
  const out: notification.ListFeedbackQuery & { limit: number } = { limit: DEFAULT_QUERY_LIMIT };

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

/** Validate GET /manage query params (admin notification list; CursorQuery only). */
export function parseListManageQuery(
  q: Record<string, string | undefined>,
): notification.ListAdminNotificationsQuery & { limit: number } {
  const fe: FieldError[] = [];
  const out: notification.ListAdminNotificationsQuery & { limit: number } = { limit: DEFAULT_QUERY_LIMIT };

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

/** Validate POST /manage/publish-batch body ({ ids: string[] }, 1..MAX_DIRECT_RECIPIENTS). */
export function parsePublishBatch(body: unknown): notification.PublishBroadcastBatchRequest {
  if (!isPlainObject(body)) throw notifValidationFailed([{ field: "(root)", reason: "invalid_type" }]);
  const ids = body.ids;
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string" && i.length > 0)) {
    throw notifValidationFailed([{ field: "ids", reason: "invalid_type", message: "non-empty string array" }]);
  }
  if (ids.length === 0) {
    throw notifValidationFailed([{ field: "ids", reason: "required", message: "at least one id" }]);
  }
  if (ids.length > MAX_DIRECT_RECIPIENTS) {
    throw notifValidationFailed([{ field: "ids", reason: "too_long", message: `<= ${MAX_DIRECT_RECIPIENTS}` }]);
  }
  return { ids: ids as string[] };
}

/** Validate POST /manage/unpublish-batch body ({ ids: string[] }, same shape as publish). */
export function parseUnpublishBatch(body: unknown): notification.UnpublishBroadcastBatchRequest {
  return parsePublishBatch(body) as notification.UnpublishBroadcastBatchRequest;
}

export { notifValidationFailed };
