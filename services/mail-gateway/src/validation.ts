// HTTP input validation against the frozen @dub/types mail contracts. Hand-rolled (no
// zod: @dub/types ships zod-free; keeping the service dependency-light avoids lockfile
// churn across the parallel unit build). Each failure -> a FieldError with the
// MAIL_INVALID_REQUEST envelope (design §6).
import { DubError, type FieldError } from "@dub/errors";
import type { mail } from "@dub/types";
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, MAX_RECIPIENTS, OUTBOUND_HEADER_ALLOWLIST, SUBJECT_MAX } from "./config";
import { INBOX_FOLDERS, type InboxFolder } from "./ops-dto";
import type { ListMessagesQuery } from "./repo";

const HEADER_ALLOW: ReadonlySet<string> = new Set(OUTBOUND_HEADER_ALLOWLIST);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function mailInvalid(fe: FieldError[], message = "mail request invalid"): DubError {
  return new DubError("MAIL_INVALID_REQUEST", message, { status: 400, details: fe });
}

function parseAddressField(v: unknown, field: string, fe: FieldError[]): mail.MailAddress[] | null {
  if (!Array.isArray(v)) {
    fe.push({ field, reason: "invalid_type", message: "expected array" });
    return null;
  }
  const out: mail.MailAddress[] = [];
  v.forEach((raw, i) => {
    if (!isPlainObject(raw) || typeof raw.email !== "string" || !EMAIL_RE.test(raw.email)) {
      fe.push({ field: `${field}[${i}].email`, reason: "invalid_email" });
      return;
    }
    const addr: mail.MailAddress = { email: raw.email };
    if (raw.name !== undefined) {
      if (typeof raw.name !== "string") fe.push({ field: `${field}[${i}].name`, reason: "invalid_type" });
      else addr.name = raw.name;
    }
    out.push(addr);
  });
  return out;
}

/** Validate POST /send body (frozen mail.SendMailRequest). */
export function parseSendMailRequest(body: unknown): mail.SendMailRequest {
  if (!isPlainObject(body)) throw mailInvalid([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  const b = body;

  const to = parseAddressField(b.to, "to", fe);
  if (to !== null && to.length === 0) fe.push({ field: "to", reason: "required", message: "at least one recipient" });
  if (to !== null && to.length > MAX_RECIPIENTS) fe.push({ field: "to", reason: "too_long", message: `<= ${MAX_RECIPIENTS}` });

  let cc: mail.MailAddress[] | undefined;
  if (b.cc !== undefined) {
    const parsed = parseAddressField(b.cc, "cc", fe);
    if (parsed) cc = parsed;
  }

  const subject = b.subject;
  if (typeof subject !== "string" || subject.length < 1 || subject.length > SUBJECT_MAX) {
    fe.push({ field: "subject", reason: "invalid_length", message: `1..${SUBJECT_MAX}` });
  }

  const textBody = b.textBody;
  if (typeof textBody !== "string" || textBody.length === 0) fe.push({ field: "textBody", reason: "required" });

  let htmlBody: string | undefined;
  if (b.htmlBody !== undefined) {
    if (typeof b.htmlBody !== "string") fe.push({ field: "htmlBody", reason: "invalid_type" });
    else htmlBody = b.htmlBody;
  }

  let inReplyTo: string | undefined;
  if (b.inReplyTo !== undefined) {
    if (typeof b.inReplyTo !== "string") fe.push({ field: "inReplyTo", reason: "invalid_type" });
    else inReplyTo = b.inReplyTo;
  }

  let loopHeaders: mail.MailLoopHeaders | undefined;
  if (b.loopHeaders !== undefined) {
    if (!isPlainObject(b.loopHeaders)) {
      fe.push({ field: "loopHeaders", reason: "invalid_type" });
    } else {
      loopHeaders = {};
      for (const [k, v] of Object.entries(b.loopHeaders)) {
        const key = k.toLowerCase();
        if (!HEADER_ALLOW.has(key)) {
          fe.push({ field: `loopHeaders.${k}`, reason: "not_allowlisted", message: `allowed: ${OUTBOUND_HEADER_ALLOWLIST.join(",")}` });
        } else if (typeof v !== "string") {
          fe.push({ field: `loopHeaders.${k}`, reason: "invalid_type" });
        } else if (key === "x-dub-mail-loop") {
          loopHeaders["x-dub-mail-loop"] = v;
        } else if (key === "auto-submitted") {
          loopHeaders["auto-submitted"] = v;
        }
      }
    }
  }

  if (fe.length > 0) throw mailInvalid(fe);

  const out: mail.SendMailRequest = {
    to: to as mail.MailAddress[],
    subject: subject as string,
    textBody: textBody as string,
  };
  if (cc !== undefined) out.cc = cc;
  if (htmlBody !== undefined) out.htmlBody = htmlBody;
  if (inReplyTo !== undefined) out.inReplyTo = inReplyTo;
  if (loopHeaders !== undefined) out.loopHeaders = loopHeaders;
  return out;
}

/** Validate GET /messages query params (threadId? / cursor? / limit / folder? / q? / label?). */
export function parseListMessagesQuery(q: Record<string, string | undefined>): ListMessagesQuery {
  const fe: FieldError[] = [];
  const out: ListMessagesQuery = { limit: DEFAULT_QUERY_LIMIT };

  if (q.threadId !== undefined && q.threadId !== "") out.threadId = q.threadId;
  if (q.cursor !== undefined && q.cursor !== "") out.cursor = q.cursor;
  if (q.label !== undefined && q.label !== "") out.label = q.label;
  if (q.q !== undefined && q.q !== "") out.q = q.q;

  if (q.folder !== undefined && q.folder !== "") {
    if ((INBOX_FOLDERS as readonly string[]).includes(q.folder)) out.folder = q.folder as InboxFolder;
    else fe.push({ field: "folder", reason: "invalid_value", message: `one of: ${INBOX_FOLDERS.join(",")}` });
  }

  if (q.limit !== undefined && q.limit !== "") {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1) fe.push({ field: "limit", reason: "invalid_range" });
    else if (n > MAX_QUERY_LIMIT) fe.push({ field: "limit", reason: "too_large", message: `<= ${MAX_QUERY_LIMIT}` });
    else out.limit = n;
  }

  if (fe.length > 0) throw mailInvalid(fe);
  return out;
}

// ---- Gmail-parity操作系 body validators ----

const COLOR_RE = /^#?[0-9a-fA-F]{3,8}$/;

/** Reply / replyAll body: { textBody (required), htmlBody? }. Recipients are derived
 *  from the referenced message server-side, so the caller only supplies the new body. */
export function parseReplyRequest(body: unknown): { textBody: string; htmlBody?: string } {
  if (!isPlainObject(body)) throw mailInvalid([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  if (typeof body.textBody !== "string" || body.textBody.length === 0) fe.push({ field: "textBody", reason: "required" });
  let htmlBody: string | undefined;
  if (body.htmlBody !== undefined) {
    if (typeof body.htmlBody !== "string") fe.push({ field: "htmlBody", reason: "invalid_type" });
    else htmlBody = body.htmlBody;
  }
  if (fe.length > 0) throw mailInvalid(fe);
  const out: { textBody: string; htmlBody?: string } = { textBody: body.textBody as string };
  if (htmlBody !== undefined) out.htmlBody = htmlBody;
  return out;
}

/** Forward body: { to (required, >=1), textBody?, htmlBody? }. The original message is
 *  quoted server-side; the caller may add a leading note via textBody. */
export function parseForwardRequest(body: unknown): { to: mail.MailAddress[]; textBody?: string; htmlBody?: string } {
  if (!isPlainObject(body)) throw mailInvalid([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  const to = parseAddressField(body.to, "to", fe);
  if (to !== null && to.length === 0) fe.push({ field: "to", reason: "required", message: "at least one recipient" });
  if (to !== null && to.length > MAX_RECIPIENTS) fe.push({ field: "to", reason: "too_long", message: `<= ${MAX_RECIPIENTS}` });
  let textBody: string | undefined;
  if (body.textBody !== undefined) {
    if (typeof body.textBody !== "string") fe.push({ field: "textBody", reason: "invalid_type" });
    else textBody = body.textBody;
  }
  let htmlBody: string | undefined;
  if (body.htmlBody !== undefined) {
    if (typeof body.htmlBody !== "string") fe.push({ field: "htmlBody", reason: "invalid_type" });
    else htmlBody = body.htmlBody;
  }
  if (fe.length > 0) throw mailInvalid(fe);
  const out: { to: mail.MailAddress[]; textBody?: string; htmlBody?: string } = { to: to as mail.MailAddress[] };
  if (textBody !== undefined) out.textBody = textBody;
  if (htmlBody !== undefined) out.htmlBody = htmlBody;
  return out;
}

/** Draft body: everything optional (a draft may be a blank shell). to/cc validated when
 *  present; subject/textBody default to "". */
export function parseDraftRequest(body: unknown): {
  to: mail.MailAddress[];
  cc?: mail.MailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  threadId?: string;
} {
  if (!isPlainObject(body)) throw mailInvalid([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  let to: mail.MailAddress[] = [];
  if (body.to !== undefined) {
    const parsed = parseAddressField(body.to, "to", fe);
    if (parsed) to = parsed;
  }
  let cc: mail.MailAddress[] | undefined;
  if (body.cc !== undefined) {
    const parsed = parseAddressField(body.cc, "cc", fe);
    if (parsed) cc = parsed;
  }
  const subject = body.subject === undefined ? "" : body.subject;
  if (typeof subject !== "string" || subject.length > SUBJECT_MAX) fe.push({ field: "subject", reason: "invalid_length", message: `0..${SUBJECT_MAX}` });
  const textBody = body.textBody === undefined ? "" : body.textBody;
  if (typeof textBody !== "string") fe.push({ field: "textBody", reason: "invalid_type" });
  let htmlBody: string | undefined;
  if (body.htmlBody !== undefined) {
    if (typeof body.htmlBody !== "string") fe.push({ field: "htmlBody", reason: "invalid_type" });
    else htmlBody = body.htmlBody;
  }
  let inReplyTo: string | undefined;
  if (body.inReplyTo !== undefined) {
    if (typeof body.inReplyTo !== "string") fe.push({ field: "inReplyTo", reason: "invalid_type" });
    else inReplyTo = body.inReplyTo;
  }
  let threadId: string | undefined;
  if (body.threadId !== undefined) {
    if (typeof body.threadId !== "string") fe.push({ field: "threadId", reason: "invalid_type" });
    else threadId = body.threadId;
  }
  if (fe.length > 0) throw mailInvalid(fe);
  const out = { to, subject: subject as string, textBody: textBody as string } as {
    to: mail.MailAddress[];
    cc?: mail.MailAddress[];
    subject: string;
    textBody: string;
    htmlBody?: string;
    inReplyTo?: string;
    threadId?: string;
  };
  if (cc !== undefined) out.cc = cc;
  if (htmlBody !== undefined) out.htmlBody = htmlBody;
  if (inReplyTo !== undefined) out.inReplyTo = inReplyTo;
  if (threadId !== undefined) out.threadId = threadId;
  return out;
}

/** Create-label body: { name (required, 1..64), color? (hex) }. */
export function parseCreateLabelRequest(body: unknown): { name: string; color: string | null } {
  if (!isPlainObject(body)) throw mailInvalid([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  const name = body.name;
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 64) fe.push({ field: "name", reason: "invalid_length", message: "1..64" });
  const color = parseColor(body.color, fe);
  if (fe.length > 0) throw mailInvalid(fe);
  return { name: (name as string).trim(), color };
}

/** Update-label body: { name?, color? } — at least one field required. */
export function parseUpdateLabelRequest(body: unknown): { name?: string; color?: string | null } {
  if (!isPlainObject(body)) throw mailInvalid([{ field: "(root)", reason: "invalid_type" }]);
  const fe: FieldError[] = [];
  const out: { name?: string; color?: string | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.length > 64) fe.push({ field: "name", reason: "invalid_length", message: "1..64" });
    else out.name = body.name.trim();
  }
  if (body.color !== undefined) out.color = parseColor(body.color, fe);
  if (out.name === undefined && out.color === undefined && fe.length === 0) fe.push({ field: "(root)", reason: "empty_patch", message: "name or color required" });
  if (fe.length > 0) throw mailInvalid(fe);
  return out;
}

/** Apply-label body: { labelId (required) }. */
export function parseApplyLabelRequest(body: unknown): { labelId: string } {
  if (!isPlainObject(body) || typeof body.labelId !== "string" || body.labelId.length === 0) {
    throw mailInvalid([{ field: "labelId", reason: "required" }]);
  }
  return { labelId: body.labelId };
}

/** color: accepts null (clear) or a hex string; anything else -> field error. */
function parseColor(v: unknown, fe: FieldError[]): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !COLOR_RE.test(v)) {
    fe.push({ field: "color", reason: "invalid_color", message: "hex like #4285F4" });
    return null;
  }
  return v.startsWith("#") ? v : `#${v}`;
}

export { mailInvalid };
