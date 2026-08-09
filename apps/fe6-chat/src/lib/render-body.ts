// Pure message-body segmenter for the Markdown subset (design §1: Md subset).
// Splits into text / mention / inline-code segments. Rendering to React is done in
// MessageItem; keeping the split pure makes it unit-testable.
export type BodySegment =
  | { type: "text"; value: string }
  | { type: "mention"; userId: string }
  | { type: "code"; value: string };

// order matters: inline code first (so `<@x>` inside backticks stays literal)
const TOKEN_RE = /(`[^`]+`)|(<@[A-Za-z0-9_]+>)/g;

export function segmentBody(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", value: body.slice(last, idx) });
    const token = m[0];
    if (token.startsWith("`")) {
      out.push({ type: "code", value: token.slice(1, -1) });
    } else {
      out.push({ type: "mention", userId: token.slice(2, -1) });
    }
    last = idx + token.length;
  }
  if (last < body.length) out.push({ type: "text", value: body.slice(last) });
  return out;
}
