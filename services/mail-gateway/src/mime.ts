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

// ---- MIME structure walk (inbound body decode) ----
// Real inbound mail (Gmail/Outlook, and especially Japanese) arrives quoted-printable
// or base64 encoded in a charset that is not necessarily UTF-8. The old heuristic kept
// the raw encoded bytes ("=3D", "=\n", base64 blobs) which render as mojibake in the
// inbox. We now walk the MIME tree, pick the best text part, and decode it by its
// Content-Transfer-Encoding + charset. Malformed input falls back to the old heuristic.

interface MimeBlock {
  headers: Record<string, string>;
  body: string;
}

/** Split a raw block into unfolded lowercased headers + body at the first blank line. */
function splitHeadersBody(block: string): MimeBlock {
  const norm = block.replace(/\r\n/g, "\n");
  const idx = norm.indexOf("\n\n");
  if (idx < 0) return { headers: {}, body: norm };
  const rawH = norm.slice(0, idx);
  const body = norm.slice(idx + 2);
  const headers: Record<string, string> = {};
  let cur = "";
  const flush = (): void => {
    const c = cur.indexOf(":");
    if (c > 0) headers[cur.slice(0, c).trim().toLowerCase()] = cur.slice(c + 1).trim();
    cur = "";
  };
  for (const ln of rawH.split("\n")) {
    if (/^[ \t]/.test(ln) && cur) cur += " " + ln.trim(); // header folding continuation
    else {
      if (cur) flush();
      cur = ln;
    }
  }
  if (cur) flush();
  return { headers, body };
}

function charsetOf(contentType: string): string {
  const m = /charset="?([^";\s]+)"?/i.exec(contentType);
  return m && m[1] ? m[1].toLowerCase() : "utf-8";
}

/** Decode bytes with the declared charset; unknown/unsupported charset falls back to UTF-8. */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Quoted-printable -> string (charset-aware). Soft line breaks removed; =XX -> byte. */
export function decodeQuotedPrintable(input: string, charset = "utf-8"): string {
  const s = input.replace(/=\r?\n/g, ""); // soft line breaks
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x100) bytes.push(code);
    else for (const b of new TextEncoder().encode(ch)) bytes.push(b);
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}

/** Decode a leaf part body by its Content-Transfer-Encoding + charset. */
function decodeCte(body: string, cte: string, charset: string): string {
  const enc = (cte || "7bit").toLowerCase();
  if (enc === "quoted-printable") return decodeQuotedPrintable(body, charset);
  if (enc === "base64") {
    try {
      return decodeBytes(b64decodeToBytes(body), charset);
    } catch {
      return body;
    }
  }
  // 7bit / 8bit / binary: only re-decode when the charset is non-ASCII (bytes are latin1 here).
  if (charset !== "utf-8" && charset !== "us-ascii" && charset !== "ascii") {
    const raw = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) raw[i] = body.charCodeAt(i) & 0xff;
    return decodeBytes(raw, charset);
  }
  return body;
}

/** Split a multipart body into its raw child part blocks (headers+body each). */
function splitMultipart(body: string, boundary: string): string[] {
  const delim = "--" + boundary;
  const segments = body.replace(/\r\n/g, "\n").split(delim);
  const parts: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg.startsWith("--")) break; // closing "--boundary--" delimiter
    parts.push(seg.replace(/^\n/, "")); // drop the newline right after the boundary line
  }
  return parts;
}

/** Very small HTML -> text: strip tags + decode the handful of common entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Walk one MIME block (recursing into multipart) and return the best decoded text. */
function partToText(block: string): string {
  const { headers, body } = splitHeadersBody(block);
  const ct = headers["content-type"] ?? "text/plain";
  const bMatch = /boundary="?([^";\n]+)"?/i.exec(ct);
  if (/multipart\//i.test(ct) && bMatch && bMatch[1]) {
    const parts = splitMultipart(body, bMatch[1]).map((raw) => ({ raw, ct: splitHeadersBody(raw).headers["content-type"] ?? "" }));
    const plain = parts.find((p) => /text\/plain/i.test(p.ct));
    const nested = parts.find((p) => /multipart\//i.test(p.ct));
    const html = parts.find((p) => /text\/html/i.test(p.ct));
    const chosen = plain ?? nested ?? html ?? parts[0];
    return chosen ? partToText(chosen.raw) : "";
  }
  const decoded = decodeCte(body, headers["content-transfer-encoding"] ?? "", charsetOf(ct));
  return /text\/html/i.test(ct) ? htmlToText(decoded) : decoded;
}

/** Old heuristic body extract — retained as the fallback when the MIME walk yields nothing. */
function fallbackBody(rawText: string): string {
  const crlf = rawText.indexOf("\r\n\r\n");
  const lf = rawText.indexOf("\n\n");
  const sep = crlf >= 0 ? crlf + 4 : lf >= 0 ? lf + 2 : -1;
  const body = sep >= 0 ? rawText.slice(sep) : rawText;
  return body
    .replace(/^--[^\r\n]*$/gm, "")
    .replace(/^Content-[^\r\n]*$/gim, "")
    .replace(/\r\n/g, "\n");
}

/** Decoded, readable plain-text body: MIME-walked + transfer-decoded, line breaks
 *  preserved (unlike the snippet, which collapses whitespace). Capped to keep a runaway
 *  message off the D1 row. Malformed structure falls back to the raw-strip heuristic. */
export function extractBody(rawText: string, maxLen = 100_000): string {
  let text: string;
  try {
    text = partToText(rawText);
  } catch {
    text = "";
  }
  if (!text.trim()) text = fallbackBody(rawText);
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n") // trailing spaces per line
    .replace(/\n{3,}/g, "\n\n") // squeeze 3+ blank lines
    .trim();
  return text.slice(0, maxLen);
}

/** Best-effort snippet for the list view: the decoded body with whitespace collapsed. */
export function extractSnippet(rawText: string): string {
  return extractBody(rawText).replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

/** Lowercase-key header map from a Headers-like object (CF EmailMessage.headers). */
export function headersToMap(headers: { forEach: (cb: (v: string, k: string) => void) => void }): Record<string, string> {
  const map: Record<string, string> = {};
  headers.forEach((v, k) => {
    map[k.toLowerCase()] = v;
  });
  return map;
}
