// HTTP input validation against the frozen @dub/types mail contracts. Hand-rolled (no
// zod: @dub/types ships zod-free; keeping the service dependency-light avoids lockfile
// churn across the parallel unit build). Each failure -> a FieldError with the
// MAIL_INVALID_REQUEST envelope (design §6).
import { DubError, type FieldError } from "@dub/errors";
import type { mail } from "@dub/types";
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, MAX_RECIPIENTS, OUTBOUND_HEADER_ALLOWLIST, SUBJECT_MAX } from "./config";

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
