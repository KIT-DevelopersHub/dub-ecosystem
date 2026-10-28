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
// Raw UTF-8 bytes per encoded-word. 39 bytes -> 52 base64 chars + 12 for "=?UTF-8?B?" and
// "?=" = 64 chars, under the 75-char cap (RFC 2047 §2) with room for "Subject: " on line 1.
const WORD_BYTES = 39;

/** Unicode NFC: macOS input can be decomposed (か + ゛), which some clients render as two
 *  glyphs. Composed form is what every MUA expects. */
export function nfc(s: string): string {
  return s.normalize("NFC");
}

/** RFC2047 B encoded-words for a non-ASCII value, each <= 75 chars and never splitting a
 *  character (chunks break on code-point boundaries, by UTF-8 byte budget). ASCII -> [value]. */
export function encodeHeaderWords(value: string): string[] {
  const v = nfc(value);
  if (ASCII_PRINTABLE.test(v)) return [v];
  const enc = new TextEncoder();
  const words: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of v) {
    const n = enc.encode(ch).length;
    if (curBytes + n > WORD_BYTES && cur) {
      words.push(`=?UTF-8?B?${b64encodeUtf8(cur)}?=`);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  if (cur) words.push(`=?UTF-8?B?${b64encodeUtf8(cur)}?=`);
  return words;
}

/** Encode a header value as RFC2047 word(s) iff it contains non-ASCII. Adjacent words are
 *  space-separated (decoders drop that whitespace, RFC 2047 §6.2). */
export function encodeHeaderWord(value: string): string {
  return encodeHeaderWords(value).join(" ");
}

/** Header-folded form of a non-ASCII value: one encoded-word per physical line. */
function foldedWords(value: string): string {
  return encodeHeaderWords(value).join("\r\n ");
}

/** Decode bytes under an RFC2047 charset label; unknown labels fall back to UTF-8. */
function decodeWordBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.split("*")[0]!.trim().toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** Decode RFC2047 encoded-words (B and Q) honoring their charset (UTF-8, ISO-2022-JP,
 *  Shift_JIS, ...). Whitespace between adjacent encoded-words is dropped (RFC 2047 §6.2). */
export function decodeHeaderWord(value: string): string {
  if (!value.includes("=?")) return value;
  const WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  const joined = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g, "$1");
  return joined.replace(WORD, (_m, charset: string, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === "B") return decodeWordBytes(b64decodeToBytes(text), charset);
      // Q-encoding: "_" -> space, "=XX" -> byte.
      const bytes: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === "_") {
          bytes.push(0x20);
        } else if (ch === "=") {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(ch.charCodeAt(0));
        }
      }
      return decodeWordBytes(new Uint8Array(bytes), charset);
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

// RFC 5322 §3.2.3 specials: an ASCII display name containing any must be quoted.
const SPECIALS = /[()<>\[\]:;@\\,."]/;

/** Display name as a phrase: non-ASCII -> encoded-words (never inside quotes), ASCII with
 *  specials -> quoted-string, else as-is. */
export function formatDisplayName(name: string): string {
  const n = nfc(name).replace(/[\r\n]+/g, " ").trim();
  if (!ASCII_PRINTABLE.test(n)) return encodeHeaderWord(n);
  return SPECIALS.test(n) ? `"${n.replace(/(["\\])/g, "\\$1")}"` : n;
}

export function formatAddress(a: mail.MailAddress): string {
  return a.name ? `${formatDisplayName(a.name)} <${a.email}>` : a.email;
}

/** Address-list header, folded one address per line once it would exceed 78 chars. */
function addressHeader(name: string, list: mail.MailAddress[]): string {
  const items = list.map(formatAddress);
  const flat = `${name}: ${items.join(", ")}`;
  return flat.length <= 78 && !flat.includes("\r\n") ? flat : `${name}: ${items.join(",\r\n ")}`;
}

/** RFC 5322 §3.6.4 References: parent's chain + parent id, deduped, angle-bracketed and
 *  folded one id per line. Long chains keep the root plus the most recent ids. */
export function referencesHeader(ids: string[], max = 20): string | null {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().replace(/^<|>$/g, "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      clean.push(id);
    }
  }
  if (clean.length === 0) return null;
  const kept = clean.length > max ? [clean[0]!, ...clean.slice(clean.length - (max - 1))] : clean;
  return kept.map((id) => `<${id}>`).join("\r\n ");
}

/** Canonical text for the wire: NFC, CRLF line endings (RFC 2045 §6.8 canonical form). */
export function canonicalText(s: string): string {
  return nfc(s).replace(/\r\n|\r|\n/g, "\r\n");
}

/** Text for JSON-API providers (Resend/MailChannels build their own MIME): NFC + LF only.
 *  A stray CR ("\r\n" from a Windows paste) must not reach an ESP that adds its own CR. */
export function apiText(s: string): string {
  return nfc(s).replace(/\r\n|\r/g, "\n");
}

/** RFC 5322 date with a numeric zone ("+0000"), not the obsolete "GMT". */
export function rfc5322Date(d: Date = new Date()): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

// ---- outbound MIME assembly ----
/** A ready-to-attach outbound file: metadata + already-base64 bytes. */
export interface OutboundAttachment {
  filename: string;
  contentType: string;
  contentBase64: string; // standard-alphabet base64 of the raw bytes
}

export interface AssembleInput {
  from: string;
  to: mail.MailAddress[];
  cc: mail.MailAddress[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  messageId: string; // without angle brackets
  inReplyTo: string | null; // without angle brackets
  /** Full References chain (root..parent). Defaults to [inReplyTo] when omitted. */
  references?: string[];
  date?: string; // RFC822 date; defaults to now
  loopHeaders?: mail.MailLoopHeaders;
  attachments?: OutboundAttachment[]; // wrapped in multipart/mixed when present
}

function part(mime: string, body: string): string {
  return `Content-Type: ${mime}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${chunk76(b64encodeUtf8(canonicalText(body)))}`;
}
/** RFC 2046 §5.1.1 boundary chars exclude "@" (present in every Message-ID): keep alnum. */
function boundaryToken(messageId: string): string {
  return messageId.replace(/[^A-Za-z0-9]/g, "").slice(0, 50);
}
function chunk76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? [b64]).join("\r\n");
}

/** One attachment part (base64, Content-Disposition: attachment). */
function attachmentPart(a: OutboundAttachment): string {
  const filename = nfc(a.filename).replace(/[\r\n"\\]/g, "");
  const name = encodeHeaderWord(filename);
  const ct = a.contentType || "application/octet-stream";
  // RFC 2231 filename* for spec-compliant clients + the legacy encoded-word form.
  const ext = ASCII_PRINTABLE.test(filename) ? "" : `;\r\n filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  return (
    `Content-Type: ${ct}; name="${name}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${name}"${ext}\r\n\r\n` +
    `${chunk76(a.contentBase64.replace(/\s+/g, ""))}`
  );
}

/** The body section (self-contained MIME part incl. its own Content-Type). Nested inside
 *  multipart/mixed when attachments are present; otherwise inlined by assembleMime. */
function bodySection(input: AssembleInput): string {
  if (input.htmlBody) {
    const alt = `_dubalt_${boundaryToken(input.messageId)}`;
    return (
      `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\n${part("text/plain", input.textBody)}\r\n` +
      `--${alt}\r\n${part("text/html", input.htmlBody)}\r\n` +
      `--${alt}--\r\n`
    );
  }
  return part("text/plain", input.textBody);
}

/** A From given as "Name <addr>" / bare addr, re-emitted with a properly encoded name. */
function formatFrom(from: string): string {
  return formatAddress(parseAddress(from));
}

/** Assemble an RFC822 message. multipart/alternative when htmlBody is present, wrapped in
 *  multipart/mixed when attachments are present (body part first, then each file). */
export function assembleMime(input: AssembleInput): string {
  const h: string[] = [];
  h.push(`From: ${formatFrom(input.from)}`);
  h.push(addressHeader("To", input.to));
  if (input.cc.length > 0) h.push(addressHeader("Cc", input.cc));
  h.push(`Subject: ${foldedWords(input.subject)}`);
  h.push(`Message-ID: <${input.messageId}>`);
  h.push(`Date: ${input.date ?? rfc5322Date()}`);
  h.push("MIME-Version: 1.0");
  if (input.inReplyTo) {
    h.push(`In-Reply-To: <${input.inReplyTo}>`);
    const refs = referencesHeader(input.references && input.references.length > 0 ? input.references : [input.inReplyTo]);
    if (refs) h.push(`References: ${refs}`);
  }
  const loopMarker = input.loopHeaders?.["x-dub-mail-loop"];
  if (loopMarker) h.push(`X-Dub-Mail-Loop: ${loopMarker}`);
  const autoSub = input.loopHeaders?.["auto-submitted"];
  if (autoSub) h.push(`Auto-Submitted: ${autoSub}`);

  const atts = input.attachments ?? [];
  if (atts.length > 0) {
    const mixed = `_dubmix_${boundaryToken(input.messageId)}`;
    h.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    let body = `--${mixed}\r\n${bodySection(input)}\r\n`;
    for (const a of atts) body += `--${mixed}\r\n${attachmentPart(a)}\r\n`;
    body += `--${mixed}--\r\n`;
    return `${h.join("\r\n")}\r\n\r\n${body}`;
  }

  if (input.htmlBody) {
    const boundary = `_dub_${boundaryToken(input.messageId)}`;
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
  rawText: string; // raw RFC822 prefix (headers + body); used only for snippet/body
  rawSize: number;
  rawFull?: string; // full (capped) RFC822 buffer for attachment extraction (R2-bound only)
  truncated?: boolean; // true when rawSize exceeded the buffer cap (tail attachments lost, #2)
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

// ---- inbound attachment extraction (MIME multipart) ----
// Reuses the block/header/multipart helpers above (splitHeadersBody, splitMultipart) and
// adds a BYTES decoder (attachments are binary, so decodeCte's string path is unusable).
export interface ExtractedAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}
export interface ExtractLimits {
  maxCount: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}
/** An attachment part we SAW but could not store (over the per-file / per-message ceiling).
 *  Reported so the gateway can record a visible stub instead of dropping it silently (#2). */
export interface DroppedAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number; // decoded byte size we measured
  reason: "dropped_too_large";
}
export interface ExtractResult {
  attachments: ExtractedAttachment[];
  dropped: DroppedAttachment[];
}

/** Extract a parameter value from a structured header (boundary / filename / name).
 *  Handles quoted and bare forms; decodes RFC2047 words in the value. */
function headerParam(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const re = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i");
  const m = re.exec(value);
  const raw = m ? (m[1] ?? m[2] ?? null) : null;
  return raw !== null ? decodeHeaderWord(raw) : null;
}

/** Content-Type mediatype (lowercased, params stripped). */
function mediaType(value: string | undefined): string {
  return (value ?? "text/plain").split(";")[0]!.trim().toLowerCase();
}

/** Decode a leaf part body to raw BYTES by its Content-Transfer-Encoding. */
function decodePartBytes(body: string, cte: string): Uint8Array {
  const enc = (cte || "7bit").trim().toLowerCase();
  if (enc === "base64") return b64decodeToBytes(body);
  if (enc === "quoted-printable") {
    const s = body.replace(/=\r?\n/g, ""); // soft line breaks
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i] as string;
      if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
        continue;
      }
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
    return new Uint8Array(bytes);
  }
  // 7bit / 8bit / binary / none: raw octets from the char codes.
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

/** Recursively walk a MIME entity, collecting attachment leaves (Content-Disposition:
 *  attachment, or any non-text leaf carrying a filename). Bounded by ExtractLimits. */
function walkForAttachments(block: string, out: ExtractedAttachment[], dropped: DroppedAttachment[], limits: ExtractLimits, state: { total: number }, depth: number): void {
  if (depth > 12 || out.length >= limits.maxCount) return;
  const { headers, body } = splitHeadersBody(block);
  const ctype = headers["content-type"];
  const media = mediaType(ctype);

  if (media.startsWith("multipart/")) {
    const boundary = headerParam(ctype, "boundary");
    if (!boundary) return;
    for (const p of splitMultipart(body, boundary)) {
      if (out.length >= limits.maxCount) break;
      walkForAttachments(p, out, dropped, limits, state, depth + 1);
    }
    return;
  }

  const disposition = (headers["content-disposition"] ?? "").toLowerCase();
  const filename = headerParam(headers["content-disposition"], "filename") ?? headerParam(ctype, "name");
  const isAttachment = disposition.startsWith("attachment") || (filename !== null && !media.startsWith("text/"));
  if (!isAttachment || !filename) return;

  const bytes = decodePartBytes(body.trim(), headers["content-transfer-encoding"] ?? "7bit");
  if (bytes.byteLength === 0) return; // empty part: not a real attachment
  const contentType = media || "application/octet-stream";
  // Over the per-file OR the per-message ceiling: record it as DROPPED (visible stub) rather
  // than skipping silently (改善#2). Still enforce the ceilings — we never store the bytes.
  if (bytes.byteLength > limits.maxBytesPerFile || state.total + bytes.byteLength > limits.maxTotalBytes) {
    dropped.push({ filename, contentType, sizeBytes: bytes.byteLength, reason: "dropped_too_large" });
    return;
  }
  state.total += bytes.byteLength;
  out.push({ filename, contentType, bytes });
}

/** Extract attachment parts + the ones dropped for size from a full RFC822 message. Pure/
 *  synchronous (unit-testable without the Worker runtime). A non-multipart or attachment-
 *  free message yields empty arrays. */
export function extractAttachmentsDetailed(rawFull: string, limits: ExtractLimits): ExtractResult {
  const out: ExtractedAttachment[] = [];
  const dropped: DroppedAttachment[] = [];
  try {
    walkForAttachments(rawFull, out, dropped, limits, { total: 0 }, 0);
  } catch {
    /* best-effort: a malformed MIME never breaks ingest */
  }
  return { attachments: out, dropped };
}

/** Back-compat thin wrapper: just the stored attachments (frozen callers/tests). */
export function extractAttachments(rawFull: string, limits: ExtractLimits): ExtractedAttachment[] {
  return extractAttachmentsDetailed(rawFull, limits).attachments;
}
