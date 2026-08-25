// Pure message-body parser for the Slack-style Markdown subset (design §1).
//
// Two levels:
//  - inline: bold *b* · italic _i_ · underline ++u++ · strike ~s~ · inline code `c`
//    · link [t](url) · mention <@id>. Rendered by MessageBody; kept pure & unit-tested.
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
  | { type: "code"; value: string };

export type BodyBlock =
  | { type: "paragraph"; lines: BodySegment[][] }
  | { type: "blockquote"; lines: BodySegment[][] }
  | { type: "bullet"; items: BodySegment[][] }
  | { type: "ordered"; items: BodySegment[][] }
  | { type: "codeblock"; value: string; lang: string | null };

// inline code + mention are tokenized first so their contents stay literal.
const TOKEN_RE = /(`[^`\n]+`)|(<@[A-Za-z0-9_]+>)/g;
// inline styles inside plain runs. Link first (so a URL isn't mis-split); then bold /
// italic / underline (++) / strike. Non-nested, single level — matches the toolbar.
const INLINE_RE =
  /(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)|(\+\+[^+\n]+\+\+)|(~[^~\n]+~)/g;

/** Split a plain-text run into text + inline-style segments (no code/mention here). */
function inlineStyles(text: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", value: text.slice(last, idx) });
    const token = m[0];
    if (token.startsWith("[")) {
      const close = token.indexOf("](");
      out.push({ type: "link", label: token.slice(1, close), href: token.slice(close + 2, -1) });
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

/** Parse one line of text into inline segments (code + mention + inline styles). */
export function inlineSegments(text: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(...inlineStyles(text.slice(last, idx)));
    const token = m[0];
    if (token.startsWith("`")) out.push({ type: "code", value: token.slice(1, -1) });
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
