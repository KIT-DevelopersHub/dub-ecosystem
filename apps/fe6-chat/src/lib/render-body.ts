// Pure message-body segmenter for the Markdown subset (design §1: Md subset).
// Splits into text / mention / inline-code / fenced-code-block segments, and
// within plain text further into inline styles (bold / italic / strike / link)
// so the formatting the composer toolbar inserts (*b* _i_ ~s~ [t](url)) renders.
// Rendering to React is done in MessageItem; keeping the split pure makes it
// unit-testable.
export type BodySegment =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "strike"; value: string }
  | { type: "link"; href: string; label: string }
  | { type: "mention"; userId: string }
  | { type: "code"; value: string }
  | { type: "codeblock"; value: string; lang: string | null };

// order matters:
//   1. fenced code block ```lang\n...``` (Slack-style multi-line code)
//   2. inline code `...` (so `<@x>` inside backticks stays literal)
//   3. mention <@userId>
const TOKEN_RE = /(```(?:[A-Za-z0-9_-]*)\n?[\s\S]*?```)|(`[^`\n]+`)|(<@[A-Za-z0-9_]+>)/g;

// Inline styles inside plain-text runs. Links first so a URL isn't mistaken for
// other markers; then bold / italic / strike. Non-nested (single level), which
// matches how the composer toolbar wraps a selection.
const INLINE_RE = /(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)/g;

/** Split a plain-text run into text + inline-style segments. */
function inlineSegments(text: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", value: text.slice(last, idx) });
    const token = m[0];
    if (token.startsWith("[")) {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      out.push({ type: "link", href, label });
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

export function segmentBody(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  const pushText = (value: string): void => {
    if (value.length > 0) out.push(...inlineSegments(value));
  };
  for (const m of body.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) pushText(body.slice(last, idx));
    const token = m[0];
    if (token.startsWith("```")) {
      const inner = token.slice(3, -3);
      const nl = inner.indexOf("\n");
      // first line may carry a language hint (```ts\n...```)
      const firstLine = nl >= 0 ? inner.slice(0, nl) : "";
      const lang = /^[A-Za-z0-9_-]+$/.test(firstLine.trim()) && firstLine.trim().length > 0 ? firstLine.trim() : null;
      const value = nl >= 0 ? inner.slice(nl + 1) : inner;
      out.push({ type: "codeblock", value: value.replace(/\n$/, ""), lang });
    } else if (token.startsWith("`")) {
      out.push({ type: "code", value: token.slice(1, -1) });
    } else {
      out.push({ type: "mention", userId: token.slice(2, -1) });
    }
    last = idx + token.length;
  }
  if (last < body.length) pushText(body.slice(last));
  return out;
}
