// Plain-text mail body -> text/link segments. Pure (no React) so it is unit-testable.
//
// Rules:
//  - `<https://…>` (Gmail's text/plain form of an HTML link, RFC 3986 App. C) is one
//    link even when the client hard-wrapped it across lines; whitespace inside is
//    dropped from the href and the angle brackets are not shown.
//  - a bare http(s) URL is ASCII-only, so it stops at Japanese text and full-width
//    punctuation (「」（）、。) glued to it. Non-ASCII is allowed only inside a balanced
//    "(...)" group (e.g. Wikipedia `Cloudflare_(企業)`).
//  - trailing sentence punctuation (. , ; : ! ? ') and unbalanced `]` are not part of it.
// Only http(s) hrefs are ever produced (no javascript:/data:).

export type LinkSegment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const ANGLE_URL = String.raw`<(https?:\/\/[^\s<>]+(?:[ \t]*\r?\n[ \t]*[^\s<>]+)*)>`;
const BARE_URL = String.raw`https?:\/\/(?:[A-Za-z0-9\-._~:/?#\[\]@!$&'*+,;=%]|\([^\s()<>「」（）、。]*\))+`;
const LINK_RE = new RegExp(`${ANGLE_URL}|(${BARE_URL})`, "g");

const TRAILING_PUNCT = /[.,;:!?']$/;

function trimBareUrl(url: string): string {
  let u = url;
  for (;;) {
    if (TRAILING_PUNCT.test(u)) {
      u = u.slice(0, -1);
      continue;
    }
    if (u.endsWith("]") && (u.match(/\[/g)?.length ?? 0) < (u.match(/\]/g)?.length ?? 0)) {
      u = u.slice(0, -1);
      continue;
    }
    return u;
  }
}

/** A URL is only worth linking when it has a host after the scheme. */
function hasHost(url: string): boolean {
  return /^https?:\/\/[^/?#]+/.test(url);
}

export function linkifySegments(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  const pushText = (t: string): void => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  let cursor = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    if (m[1] !== undefined) {
      const href = m[1].replace(/\s+/g, "");
      if (!hasHost(href)) continue;
      pushText(text.slice(cursor, start));
      // "詳細<https://…>" -> keep the label and link visually apart once the brackets go.
      const prev = text[start - 1];
      if (prev !== undefined && !/\s/.test(prev)) pushText(" ");
      out.push({ kind: "link", text: href, href });
      cursor = start + m[0].length;
      continue;
    }
    const url = trimBareUrl(m[2] ?? "");
    if (!hasHost(url)) continue;
    pushText(text.slice(cursor, start));
    out.push({ kind: "link", text: url, href: url });
    cursor = start + url.length;
  }
  pushText(text.slice(cursor));
  return out;
}
