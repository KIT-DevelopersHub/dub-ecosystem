// MIME assembly (outbound) + RFC822 normalization (inbound). Deliberately compact:
// mail-gateway is a thin adapter, so this covers the P0 cases the design tests call
// out (text / text+html multipart, RFC2047 Japanese subjects, In-Reply-To/References,
// loop headers) without pulling a MIME library into the parallel unit build.
import type { mail } from "@dub/types";
import { SNIPPET_MAX } from "./config";

// ---- base64 (UTF-8 safe) ----
export function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function b64decodeToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64decodeUtf8(b64: string): string {
  return new TextDecoder().decode(b64decodeToBytes(b64));
}

// ---- RFC2047 ----
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** Encode a header value as a single RFC2047 base64 word iff it contains non-ASCII. */
export function encodeHeaderWord(value: string): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  return `=?UTF-8?B?${b64encodeUtf8(value)}?=`;
}

/** Decode RFC2047 encoded-words (B and Q, UTF-8/latin1) embedded in a header value. */
export function decodeHeaderWord(value: string): string {
  if (!value.includes("=?")) return value;
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") return b64decodeUtf8(text);
      // Q-encoding: "_" -> space, "=XX" -> byte.
      const bytes: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "_") {
          bytes.push(0x20);
        } else if (ch === "=") {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(ch.charCodeAt(0));
        }
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch {
      return text;
    }
  });
}

// ---- address parsing / formatting ----
const ADDR_RE = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/;

/** Parse a single "Name <email>" / "email" token into MailAddress. */
export function parseAddress(raw: string): mail.MailAddress {
  const s = raw.trim();
  const m = ADDR_RE.exec(s);
  if (m && m[2]) {
    const name = decodeHeaderWord((m[1] ?? "").trim());
    return name ? { email: m[2].trim(), name } : { email: m[2].trim() };
  }
  return { email: s.replace(/[<>]/g, "").trim() };
}

/** Parse a comma-separated address list (best-effort; ignores commas inside quotes). */
export function parseAddressList(raw: string | null | undefined): mail.MailAddress[] {
  if (!raw) return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === '"') depth ^= 1;
    if (ch === "," && depth === 0) {
      if (cur.trim()) parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(parseAddress);
}

export function formatAddress(a: mail.MailAddress): string {
  return a.name ? `${encodeHeaderWord(a.name)} <${a.email}>` : a.email;
}

// ---- outbound MIME assembly ----
export interface AssembleInput {
  from: string;
  to: mail.MailAddress[];
  cc: mail.MailAddress[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  messageId: string; // without angle brackets
  inReplyTo: string | null; // without angle brackets
  date?: string; // RFC822 date; defaults to now
  loopHeaders?: mail.MailLoopHeaders;
}

function part(mime: string, body: string): string {
  return `Content-Type: ${mime}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${chunk76(b64encodeUtf8(body))}`;
}
function chunk76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? [b64]).join("\r\n");
}

/** Assemble an RFC822 message. multipart/alternative when htmlBody is present. */
export function assembleMime(input: AssembleInput): string {
  const h: string[] = [];
  h.push(`From: ${input.from}`);
  h.push(`To: ${input.to.map(formatAddress).join(", ")}`);
  if (input.cc.length > 0) h.push(`Cc: ${input.cc.map(formatAddress).join(", ")}`);
  h.push(`Subject: ${encodeHeaderWord(input.subject)}`);
  h.push(`Message-ID: <${input.messageId}>`);
  h.push(`Date: ${input.date ?? new Date().toUTCString()}`);
  h.push("MIME-Version: 1.0");
  if (input.inReplyTo) {
    h.push(`In-Reply-To: <${input.inReplyTo}>`);
    h.push(`References: <${input.inReplyTo}>`);
  }
  const loopMarker = input.loopHeaders?.["x-dub-mail-loop"];
  if (loopMarker) h.push(`X-Dub-Mail-Loop: ${loopMarker}`);
  const autoSub = input.loopHeaders?.["auto-submitted"];
  if (autoSub) h.push(`Auto-Submitted: ${autoSub}`);

  if (input.htmlBody) {
    const boundary = `--_dub_${input.messageId}`;
    h.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body =
      `--${boundary}\r\n${part('text/plain', input.textBody)}\r\n` +
      `--${boundary}\r\n${part('text/html', input.htmlBody)}\r\n` +
      `--${boundary}--\r\n`;
    return `${h.join("\r\n")}\r\n\r\n${body}`;
  }
  return `${h.join("\r\n")}\r\n${part("text/plain", input.textBody)}\r\n`;
}

// ---- inbound normalization ----
export interface RawInbound {
  from: string; // envelope/header From
  to: string; // envelope To (the destination address)
  headers: Record<string, string>; // lowercased header names -> value
  rawText: string; // raw RFC822 (headers + body); used only for the snippet
  rawSize: number;
}

function stripAngle(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim();
}
function firstMessageIdToken(value: string | undefined): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  return m && m[1] ? m[1].trim() : stripAngle(value.split(/\s+/)[0] ?? "") || null;
}

/** Best-effort snippet: first non-empty body text after the header/body separator. */
export function extractSnippet(rawText: string): string {
  const sep = rawText.indexOf("\r\n\r\n") >= 0 ? rawText.indexOf("\r\n\r\n") + 4 : rawText.indexOf("\n\n") + 2;
  const body = sep > 1 ? rawText.slice(sep) : rawText;
  const text = body
    .replace(/^--.*$/gm, " ") // drop MIME boundary lines
    .replace(/^Content-[^\r\n]*$/gim, " ") // drop part headers
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, SNIPPET_MAX);
}

/** Best-effort plain-text body: everything after the header/body separator, with MIME
 *  boundary + part-header lines dropped but line breaks PRESERVED (unlike the snippet,
 *  which collapses whitespace). Capped to keep a runaway message off the D1 row. */
export function extractBody(rawText: string, maxLen = 100_000): string {
  const crlf = rawText.indexOf("\r\n\r\n");
  const lf = rawText.indexOf("\n\n");
  const sep = crlf >= 0 ? crlf + 4 : lf >= 0 ? lf + 2 : -1;
  const body = sep >= 0 ? rawText.slice(sep) : rawText;
  const text = body
    .replace(/^--[^\r\n]*$/gm, "") // drop MIME boundary lines
    .replace(/^Content-[^\r\n]*$/gim, "") // drop part headers
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n") // squeeze 3+ blank lines
    .trim();
  return text.slice(0, maxLen);
}

/** Lowercase-key header map from a Headers-like object (CF EmailMessage.headers). */
export function headersToMap(headers: { forEach: (cb: (v: string, k: string) => void) => void }): Record<string, string> {
  const map: Record<string, string> = {};
  headers.forEach((v, k) => {
    map[k.toLowerCase()] = v;
  });
  return map;
}
