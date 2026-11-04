// Plain-text mail body -> text / link segments (pure, unit-tested). Same bare-URL rule as
// the chat body parser (fe6-chat render-body.ts): https?:// up to whitespace, < > " ' `,
// or the full-width brackets / punctuation that follow a URL in Japanese text, then
// trailing ASCII sentence punctuation trimmed (except ")" balancing a "(" in the URL).

export type BodyPart = { type: "text"; value: string } | { type: "link"; href: string };

const URL_RE = /https?:\/\/[^\s<>"'`（）「」『』【】〔〕｛｝〈〉《》、。，！？：；…]+/g;
const URL_TRAIL_RE = /[.,;:!?)\]}]+$/;

function trimUrl(match: string): string {
  let url = match.replace(URL_TRAIL_RE, "");
  for (;;) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (opens > closes && match[url.length] === ")") url += ")";
    else return url;
  }
}

export function linkifyBody(text: string): BodyPart[] {
  const out: BodyPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    const href = trimUrl(m[0]);
    // A bare scheme ("https://") is not a link.
    if (href.length <= href.indexOf("//") + 2) continue;
    if (idx > last) out.push({ type: "text", value: text.slice(last, idx) });
    out.push({ type: "link", href });
    last = idx + href.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
