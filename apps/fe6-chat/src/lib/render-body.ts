// Pure message-body parser for the Slack-style Markdown subset (design §1).
//
// Two levels:
//  - inline: bold *b* · italic _i_ · underline ++u++ · strike ~s~ · inline code `c`
//    · link [t](url) · mention <@id> · team mention <!team:id>. Rendered by
//    MessageBody; kept pure & unit-tested.
//  - block:  paragraph · blockquote (> ) · bullet list (- / *) · ordered list (1.) ·
//    fenced code block (```lang ... ```). Line-based, so it round-trips what the
//    composer toolbar inserts.
//
// Rendering to React (with escaping — no dangerouslySetInnerHTML, links sanitized to
// http(s)/relative) lives in components/MessageBody.tsx.

export type BodySegment =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "underline"; value: string }
  | { type: "strike"; value: string }
  | { type: "link"; href: string; label: string }
  | { type: "mention"; userId: string }
  | { type: "teamMention"; teamId: string }
  | { type: "code"; value: string };

export type BodyBlock =
  | { type: "paragraph"; lines: BodySegment[][] }
  | { type: "blockquote"; lines: BodySegment[][] }
  | { type: "bullet"; items: BodySegment[][] }
  | { type: "ordered"; items: BodySegment[][] }
  | { type: "codeblock"; value: string; lang: string | null };

// inline code + mentions (person / team) are tokenized first so their contents stay literal.
const TOKEN_RE = /(`[^`\n]+`)|(<@[A-Za-z0-9_]+>)|(<!team:[A-Za-z0-9_-]+>)/g;
// inline styles inside plain runs. Markdown link first, then a BARE URL (Slack parity:
// https?:// up to whitespace / < > " ' ` / full-width brackets & punctuation that follow a
// pasted link in Japanese text) — the URL alternative sits BEFORE bold/italic/strike so
// "_" / "~" / "*" inside a URL (wikipedia Foo_bar) can never split it; leftmost match
// wins, so "*see https://x*" is still bold and "[d](https://x_y)" still a markdown link.
// Non-nested, single level — matches the toolbar.
const INLINE_RE =
  /(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\))|(https?:\/\/[^\s<>"'`（）「」『』【】〔〕｛｝〈〉《》、。，！？：；…]+)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\+\+[^+\n]+\+\+)|(~[^~\n]+~)/g;
// Trailing ASCII punctuation that is almost always sentence punctuation, not the URL.
const URL_TRAIL_RE = /[.,;:!?)\]}]+$/;

/**
 * Trim sentence punctuation off a matched bare URL — except ")" that balance an open
 * "(" inside the URL (wiki-style paths): "(see https://x/y_(z))." -> ".../y_(z)".
 */
function trimBareUrl(match: string): string {
  let url = match.replace(URL_TRAIL_RE, "");
  for (;;) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (opens > closes && match[url.length] === ")") url += ")";
    else return url;
  }
}

/** Split a plain-text run into text + inline-style segments (no code/mention here). */
function inlineStyles(text: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", value: text.slice(last, idx) });
    let token = m[0];
    if (token.startsWith("[")) {
      const close = token.indexOf("](");
      out.push({ type: "link", label: token.slice(1, close), href: token.slice(close + 2, -1) });
    } else if (token.startsWith("http")) {
      token = trimBareUrl(token); // trimmed punctuation flows back into the text run
      out.push({ type: "link", href: token, label: token });
    } else if (token.startsWith("++")) {
      out.push({ type: "underline", value: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      out.push({ type: "bold", value: token.slice(1, -1) });
    } else if (token.startsWith("_")) {
      out.push({ type: "italic", value: token.slice(1, -1) });
    } else {
      out.push({ type: "strike", value: token.slice(1, -1) });
    }
    last = idx + token.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/**
 * URLs eligible for a link-preview card, in body order, de-duplicated, capped at
 * `max`. Skips code blocks / inline code (literal) and only counts http(s) links —
 * both bare URLs and [label](url). Pure; the card component decides rendering.
 */
export function extractPreviewUrls(body: string, max = 2): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of parseBlocks(body)) {
    if (block.type === "codeblock") continue;
    const lines = block.type === "paragraph" || block.type === "blockquote" ? block.lines : block.items;
    for (const segs of lines) {
      for (const seg of segs) {
        if (seg.type !== "link" || !/^https?:\/\//i.test(seg.href) || seen.has(seg.href)) continue;
        seen.add(seg.href);
        out.push(seg.href);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/** Parse one line of text into inline segments (code + mention + inline styles). */
export function inlineSegments(text: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(...inlineStyles(text.slice(last, idx)));
    const token = m[0];
    if (token.startsWith("`")) out.push({ type: "code", value: token.slice(1, -1) });
    else if (token.startsWith("<!team:")) out.push({ type: "teamMention", teamId: token.slice(7, -1) });
    else out.push({ type: "mention", userId: token.slice(2, -1) });
    last = idx + token.length;
  }
  if (last < text.length) out.push(...inlineStyles(text.slice(last)));
  return out;
}

const RE_FENCE = /^```/;
const RE_QUOTE = /^>\s?/;
const RE_BULLET = /^[-*]\s+/;
const RE_ORDERED = /^\d+\.\s+/;

/**
 * Body with ``` fenced blocks and `inline code` removed. Mention scanning (who is
 * notified / whose row lights up) must agree with what the renderer shows: a mention
 * typed inside code is documentation, not a ping. Line-based, same rule as parseBlocks
 * (an unclosed fence swallows the rest of the body).
 */
export function stripCodeSpans(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (RE_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push(line.replace(/`[^`\n]+`/g, " "));
  }
  return out.join("\n");
}

/** Parse a message body into block-level structures (paragraph/quote/list/code). */
export function parseBlocks(body: string): BodyBlock[] {
  const lines = body.split("\n");
  const blocks: BodyBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (RE_FENCE.test(line)) {
      const hint = line.slice(3).trim();
      const lang = /^[A-Za-z0-9_-]+$/.test(hint) ? hint : null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i]!)) buf.push(lines[i++]!);
      i++; // skip closing ```
      blocks.push({ type: "codeblock", value: buf.join("\n"), lang });
      continue;
    }
    if (RE_QUOTE.test(line)) {
      const qlines: BodySegment[][] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i]!)) qlines.push(inlineSegments(lines[i++]!.replace(RE_QUOTE, "")));
      blocks.push({ type: "blockquote", lines: qlines });
      continue;
    }
    if (RE_BULLET.test(line)) {
      const items: BodySegment[][] = [];
      while (i < lines.length && RE_BULLET.test(lines[i]!)) items.push(inlineSegments(lines[i++]!.replace(RE_BULLET, "")));
      blocks.push({ type: "bullet", items });
      continue;
    }
    if (RE_ORDERED.test(line)) {
      const items: BodySegment[][] = [];
      while (i < lines.length && RE_ORDERED.test(lines[i]!)) items.push(inlineSegments(lines[i++]!.replace(RE_ORDERED, "")));
      blocks.push({ type: "ordered", items });
      continue;
    }
    const para: BodySegment[][] = [];
    while (
      i < lines.length &&
      !RE_FENCE.test(lines[i]!) &&
      !RE_QUOTE.test(lines[i]!) &&
      !RE_BULLET.test(lines[i]!) &&
      !RE_ORDERED.test(lines[i]!)
    ) {
      para.push(inlineSegments(lines[i++]!));
    }
    blocks.push({ type: "paragraph", lines: para });
  }
  return blocks;
}
