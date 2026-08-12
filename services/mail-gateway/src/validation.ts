// HTTP input validation against the frozen @dub/types mail contracts. Hand-rolled (no
// zod: @dub/types ships zod-free; keeping the service dependency-light avoids lockfile
// churn across the parallel unit build). Each failure -> a FieldError with the
// MAIL_INVALID_REQUEST envelope (design §6).
import { DubError, type FieldError } from "@dub/errors";
import type { mail } from "@dub/types";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_QUERY_LIMIT,
  MAX_RECIPIENTS,
  OUTBOUND_HEADER_ALLOWLIST,
  SUBJECT_MAX,
} from "./config";

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

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const FILENAME_MAX = 255;

/** Byte length a standard base64 string decodes to (without allocating the bytes). */
function base64ByteLength(b64: string): number {
  const s = b64.replace(/\s+/g, "");
  if (s.length === 0) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

/** Validate the optional attachments array (base64 bodies + bounds). */
function parseAttachments(v: unknown, fe: FieldError[]): mail.MailAttachmentInput[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    fe.push({ field: "attachments", reason: "invalid_type", message: "expected array" });
    return undefined;
  }
  if (v.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    fe.push({ field: "attachments", reason: "too_many", message: `<= ${MAX_ATTACHMENTS_PER_MESSAGE}` });
  }
  const out: mail.MailAttachmentInput[] = [];
  let total = 0;
  v.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      fe.push({ field: `attachments[${i}]`, reason: "invalid_type" });
      return;
    }
    const { filename, contentType, contentBase64 } = raw as Record<string, unknown>;
    if (typeof filename !== "string" || filename.length === 0 || filename.length > FILENAME_MAX) {
      fe.push({ field: `attachments[${i}].filename`, reason: "invalid_length", message: `1..${FILENAME_MAX}` });
    }
    if (typeof contentType !== "string" || contentType.length === 0) {
      fe.push({ field: `attachments[${i}].contentType`, reason: "required" });
    }
    if (typeof contentBase64 !== "string" || contentBase64.length === 0 || !BASE64_RE.test(contentBase64.replace(/\s+/g, ""))) {
      fe.push({ field: `attachments[${i}].contentBase64`, reason: "invalid_base64" });
      return;
    }
    const size = base64ByteLength(contentBase64);
    if (size === 0) {
      fe.push({ field: `attachments[${i}].contentBase64`, reason: "empty" });
      return;
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      fe.push({ field: `attachments[${i}]`, reason: "too_large", message: `<= ${MAX_ATTACHMENT_BYTES} bytes` });
      return;
    }
    total += size;
    if (typeof filename === "string" && typeof contentType === "string") {
      out.push({ filename, contentType, contentBase64: contentBase64.replace(/\s+/g, "") });
    }
  });
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    fe.push({ field: "attachments", reason: "too_large_total", message: `<= ${MAX_ATTACHMENTS_TOTAL_BYTES} bytes total` });
  }
  return out.length > 0 ? out : undefined;
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

  const attachments = parseAttachments(b.attachments, fe);

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
  if (attachments !== undefined) out.attachments = attachments;
  return out;
}

/** Validate GET /messages query params (threadId? / cursor? / limit). */
export function parseListMessagesQuery(q: Record<string, string | undefined>): { threadId?: string; cursor?: string; limit: number } {
  const fe: FieldError[] = [];
  const out: { threadId?: string; cursor?: string; limit: number } = { limit: DEFAULT_QUERY_LIMIT };

  if (q.threadId !== undefined && q.threadId !== "") out.threadId = q.threadId;
  if (q.cursor !== undefined && q.cursor !== "") out.cursor = q.cursor;

  if (q.limit !== undefined && q.limit !== "") {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1) fe.push({ field: "limit", reason: "invalid_range" });
    else if (n > MAX_QUERY_LIMIT) fe.push({ field: "limit", reason: "too_large", message: `<= ${MAX_QUERY_LIMIT}` });
    else out.limit = n;
  }

  if (fe.length > 0) throw mailInvalid(fe);
  return out;
}

export { mailInvalid };
