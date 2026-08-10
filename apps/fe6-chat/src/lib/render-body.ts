// Pure message-body segmenter for the Markdown subset (design §1: Md subset).
// Splits into text / mention / inline-code / fenced-code-block segments.
// Rendering to React is done in MessageItem; keeping the split pure makes it
// unit-testable.
export type BodySegment =
  | { type: "text"; value: string }
  | { type: "mention"; userId: string }
  | { type: "code"; value: string }
  | { type: "codeblock"; value: string; lang: string | null };

// order matters:
//   1. fenced code block ```lang\n...``` (Slack-style multi-line code)
//   2. inline code `...` (so `<@x>` inside backticks stays literal)
//   3. mention <@userId>
const TOKEN_RE = /(```(?:[A-Za-z0-9_-]*)\n?[\s\S]*?```)|(`[^`\n]+`)|(<@[A-Za-z0-9_]+>)/g;

export function segmentBody(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", value: body.slice(last, idx) });
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
  if (last < body.length) out.push({ type: "text", value: body.slice(last) });
  return out;
}
