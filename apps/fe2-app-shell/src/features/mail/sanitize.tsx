// Conservative HTML sanitizer for rendering inbound message bodies. Inbound mail is
// UNTRUSTED, so we never inject its markup raw. Rather than pull a third-party lib into
// the shell bundle, this is a small allowlist sanitizer built on the platform DOM
// parser (available in the browser and in the jsdom test env):
//   - only a fixed set of formatting/structure tags survive; everything else is
//     unwrapped to its text (so content is never lost, only its dangerous markup);
//   - <script>/<style>/<iframe>/<object>/<embed> and their contents are dropped whole;
//   - every attribute is stripped except href/title on links and alt on images, and a
//     surviving href/src must be an http(s) or mailto URL (javascript:/data: rejected);
//   - links are forced to rel="noopener noreferrer" target="_blank".
// The default render path prefers the plain-text body; this HTML path is the fallback
// (and defense-in-depth) for messages that only carry HTML.

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "br", "p", "div", "span", "blockquote",
  "ul", "ol", "li", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img",
  "table", "thead", "tbody", "tr", "td", "th",
]);
const DROP_WHOLE = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math"]);

function safeUrl(value: string): string | null {
  const v = value.trim();
  // Allow relative-less schemes we trust; reject javascript:, data:, vbscript:, etc.
  if (/^(https?:|mailto:)/i.test(v)) return v;
  return null;
}

function scrubAttributes(el: Element): void {
  const tag = el.tagName.toLowerCase();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (tag === "a" && (name === "href" || name === "title")) {
      if (name === "href") {
        const url = safeUrl(attr.value);
        if (url) el.setAttribute("href", url);
        else el.removeAttribute("href");
      }
      continue;
    }
    if (tag === "img" && (name === "src" || name === "alt")) {
      if (name === "src") {
        const url = safeUrl(attr.value);
        if (url) el.setAttribute("src", url);
        else el.removeAttribute("src");
      }
      continue;
    }
    // Everything else (on* handlers, style, class, id, data-*, srcset, ...) is removed.
    el.removeAttribute(attr.name);
  }
  if (tag === "a") {
    el.setAttribute("rel", "noopener noreferrer");
    el.setAttribute("target", "_blank");
  }
}

function walk(node: Node, doc: Document): void {
  // Iterate over a snapshot: we mutate the tree as we go.
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* text */ || child.nodeType === 8 /* comment */) {
      if (child.nodeType === 8) child.parentNode?.removeChild(child); // strip comments
      continue;
    }
    if (child.nodeType !== 1 /* element */) {
      child.parentNode?.removeChild(child);
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WHOLE.has(tag)) {
      el.parentNode?.removeChild(el);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: replace the element with its (recursively-sanitized) children.
      walk(el, doc);
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
      continue;
    }
    scrubAttributes(el);
    walk(el, doc);
  }
}

/** Sanitize an untrusted HTML string into a safe subset. Returns "" when the platform
 *  DOM parser is unavailable (SSR) — callers fall back to the plain-text body. */
export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  walk(doc.body, doc);
  return doc.body.innerHTML;
}
