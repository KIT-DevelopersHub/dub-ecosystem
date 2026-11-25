// lp-markdown — LP のお知らせ詳細（Markdown）を安全な HTML にする + 画像 URL の正規化（Google ドライブ）。
// LP Worker（workerd・`node --test` の strip-only TS）と LP管理（ブラウザのプレビュー）が同じこれを使う。
// そのため import なし・DOM / URL クラスに頼らない純粋な文字列処理にしている。
//
// 安全の考え方（サニタイズを後からかけるのではなく、作る段階で安全にする）:
// - 入力の文字はすべてエスケープしてから出す。生の HTML は書けない（<script> はそのまま文字として出る）。
// - 出すタグは下の決まったものだけ（h3 / h4 / p / br / strong / em / del / code / pre / blockquote / ul / ol / li /
//   hr / a / img / figure / figcaption）。属性も決まったものだけ。
// - リンク・画像は http(s) の絶対 URL だけ（javascript: / data: / 相対パスは文字として出す）。リンクは新しいタブ。

/** 描く文字数の上限（検証は lp.ts の LP_NEWS_BODY_MAX。ここは異常に長い入力から守るだけ）。 */
const RENDER_MAX = 8000;

const HTML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

const HTTP_URL_RE = /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?([/?#][^\s"'<>`\\]*)?$/i;
const URL_MAX = 2000;

/** http(s) の絶対 URL か（リンク・画像に使ってよいか）。 */
export function isHttpUrl(v: string): boolean {
  return v.length <= URL_MAX && HTTP_URL_RE.test(v);
}

// ---- Google ドライブの共有リンク → 画像として埋め込める URL ----
// 共有リンク（/file/d/<ID>/view・open?id=<ID> など）は HTML のページなので <img> に入れても出ない。
// lh3.googleusercontent.com/d/<ID> は「リンクを知っている全員」に共有した画像ならログインなしで画像を返す
// （2026-11 に実ファイルで確認: 200 image/jpeg。共有していない・存在しない ID は 500 の HTML = 画像が壊れる）。

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/** Google ドライブのファイル URL ならファイル ID。違えば null。 */
export function googleDriveFileId(url: string): string | null {
  const m = /^https?:\/\/(drive|docs)\.google\.com(\/[^?#]*)?(\?[^#]*)?/i.exec(url.trim());
  if (!m) return null;
  const path = m[2] ?? "";
  const query = m[3] ?? "";
  const byPath = /\/file\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(path);
  if (byPath && DRIVE_ID_RE.test(byPath[1]!)) return byPath[1]!;
  if (/^\/(open|uc|thumbnail)\/?$/.test(path) || /^\/u\/\d+\/(open|uc)\/?$/.test(path)) {
    const q = /[?&]id=([^&]+)/.exec(query);
    if (q && DRIVE_ID_RE.test(q[1]!)) return q[1]!;
  }
  return null;
}

/** 画像 URL を <img> に入れられる形に（Google ドライブの共有リンクだけ直す・ほかはそのまま）。 */
export function toEmbeddableImageUrl(url: string, width = 1600): string {
  const id = googleDriveFileId(url);
  return id ? `https://lh3.googleusercontent.com/d/${id}=w${width}` : url;
}

// ---- インライン ----

const INLINE_DEPTH_MAX = 4;
/** 自動リンクの末尾から外す文字（文の句読点・閉じ括弧）。 */
const AUTOLINK_TRAIL_RE = /[.,;:!?)\]）」』】、。！？]+$/;

function imgTag(src: string, alt: string): string {
  return `<img src="${esc(toEmbeddableImageUrl(src))}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

function linkTag(href: string, inner: string): string {
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

/** [text](url) / ![alt](url) の「(url)」部分を読む。url と次の位置、読めなければ null。 */
function readTarget(src: string, at: number): { url: string; end: number } | null {
  if (src[at] !== "(") return null;
  const close = src.indexOf(")", at + 1);
  if (close < 0) return null;
  // (url "title") の title は捨てる。
  const url = src.slice(at + 1, close).trim().split(/\s+/)[0] ?? "";
  return { url, end: close + 1 };
}

function renderInline(src: string, depth = 0): string {
  if (depth > INLINE_DEPTH_MAX) return esc(src);
  let out = "";
  let text = "";
  const flush = (): void => {
    out += esc(text);
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const rest = src.slice(i);
    // バックスラッシュで記号をそのまま出す
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~>|]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out += `<code>${esc(src.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (c === "!" && src[i + 1] === "[") {
      const close = src.indexOf("]", i + 2);
      const t = close > 0 ? readTarget(src, close + 1) : null;
      if (t) {
        flush();
        const alt = src.slice(i + 2, close);
        out += isHttpUrl(t.url) ? imgTag(t.url, alt) : esc(alt);
        i = t.end;
        continue;
      }
    }
    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      const t = close > 0 ? readTarget(src, close + 1) : null;
      if (t) {
        flush();
        const inner = renderInline(src.slice(i + 1, close), depth + 1);
        out += isHttpUrl(t.url) ? linkTag(t.url, inner) : inner;
        i = t.end;
        continue;
      }
    }
    const pair = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest.startsWith("~~") ? "~~" : null;
    if (pair) {
      const end = src.indexOf(pair, i + 2);
      if (end > i + 2) {
        flush();
        const tag = pair === "~~" ? "del" : "strong";
        out += `<${tag}>${renderInline(src.slice(i + 2, end), depth + 1)}</${tag}>`;
        i = end + 2;
        continue;
      }
    }
    // *強調* / _強調_（_ は英数字の途中では強調にしない: snake_case を守る）
    if ((c === "*" || (c === "_" && !/[A-Za-z0-9]/.test(src[i - 1] ?? ""))) && src[i + 1] !== " " && src[i + 1] !== c) {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1 && src[end - 1] !== " " && !(c === "_" && /[A-Za-z0-9]/.test(src[end + 1] ?? ""))) {
        flush();
        out += `<em>${renderInline(src.slice(i + 1, end), depth + 1)}</em>`;
        i = end + 1;
        continue;
      }
    }
    // 素の URL は自動でリンクに
    if ((c === "h" || c === "H") && /^https?:\/\//i.test(rest) && !/[A-Za-z0-9]/.test(src[i - 1] ?? "")) {
      const raw = /^https?:\/\/[^\s<>"'`（）「」『』【】、。]+/i.exec(rest)![0];
      const url = raw.replace(AUTOLINK_TRAIL_RE, "");
      if (isHttpUrl(url)) {
        flush();
        out += linkTag(url, esc(url));
        i += url.length;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

// ---- ブロック ----

const BLOCK_DEPTH_MAX = 4;
const FENCE_RE = /^\s{0,3}```/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;

function startsBlock(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || UL_RE.test(line) || OL_RE.test(line);
}

/** 箇条書き（同じ種類が続くあいだ）。深い字下げの行は直前の項目の中身として入れ子で描く。 */
function renderList(lines: readonly string[], start: number, depth: number): { html: string; next: number } {
  const first = lines[start]!;
  const ordered = !UL_RE.test(first);
  const base = indentOf(first);
  const items: string[][] = [];
  let i = start;
  let olStart = 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // 空行の次も同じ箇条書きが続くなら続ける
      const nxt = lines[i + 1];
      if (nxt !== undefined && indentOf(nxt) >= base && (ordered ? OL_RE : UL_RE).test(nxt)) {
        i += 1;
        continue;
      }
      break;
    }
    const ind = indentOf(line);
    const m = ordered ? OL_RE.exec(line) : UL_RE.exec(line);
    if (m && ind === base) {
      if (items.length === 0 && ordered) olStart = Number(m[2]);
      items.push([ordered ? m[3]! : m[2]!]);
    } else if (ind > base && items.length > 0) {
      items[items.length - 1]!.push(line.slice(Math.min(ind, base + 4)));
    } else if (ind <= base && !startsBlock(line) && items.length > 0) {
      // 字下げなしの続きの行（遅延継続）
      items[items.length - 1]!.push(line.trim());
    } else break;
    i += 1;
  }
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && olStart !== 1 ? ` start="${olStart}"` : "";
  const lis = items.map(([head, ...body]) => {
    const subStart = body.findIndex((l) => startsBlock(l));
    const textLines = subStart < 0 ? [head!, ...body] : [head!, ...body.slice(0, subStart)];
    const sub = subStart < 0 ? "" : renderBlocks(body.slice(subStart), depth + 1);
    return `<li>${textLines.map((l) => renderInline(l.trim())).join("<br>")}${sub}</li>`;
  });
  return { html: `<${tag}${startAttr}>${lis.join("")}</${tag}>`, next: i };
}

function renderParagraph(lines: readonly string[]): string {
  const only = lines.length === 1 ? /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)$/.exec(lines[0]!.trim()) : null;
  // 画像だけの段落は図として大きく出す（alt を説明文に）。
  if (only && isHttpUrl(only[2]!)) {
    const cap = only[1]!.trim();
    return `<figure>${imgTag(only[2]!, cap)}${cap ? `<figcaption>${esc(cap)}</figcaption>` : ""}</figure>`;
  }
  return `<p>${lines.map((l) => renderInline(l.trim())).join("<br>")}</p>`;
}

function renderBlocks(lines: readonly string[], depth: number): string {
  if (depth > BLOCK_DEPTH_MAX) return `<p>${esc(lines.join("\n"))}</p>`;
  const out: string[] = [];
  let para: string[] = [];
  const endPara = (): void => {
    if (para.length > 0) out.push(renderParagraph(para));
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      endPara();
      i += 1;
      continue;
    }
    if (FENCE_RE.test(line)) {
      endPara();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) body.push(lines[i++]!);
      i += 1; // 閉じの ```（無ければ末尾まで）
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      endPara();
      // ダイアログの題名が見出しの最上位なので、# / ## は h3、### 以下は h4。
      const tag = h[1]!.length <= 2 ? "h3" : "h4";
      out.push(`<${tag}>${renderInline(h[2]!)}</${tag}>`);
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      endPara();
      out.push("<hr>");
      i += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      endPara();
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE_RE, ""));
      out.push(`<blockquote>${renderBlocks(body, depth + 1)}</blockquote>`);
      continue;
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      endPara();
      const list = renderList(lines, i, depth);
      out.push(list.html);
      i = list.next;
      continue;
    }
    para.push(line);
    i += 1;
  }
  endPara();
  return out.join("");
}

/**
 * Markdown → 安全な HTML（見出し・段落・太字・斜体・取り消し線・コード・箇条書き・番号付き・引用・区切り線・リンク・画像）。
 * 段落の中の改行はそのまま改行（<br>）にする（note のように書いたとおりに見せる）。
 */
export function renderLpMarkdown(src: string): string {
  const text = src.slice(0, RENDER_MAX).replace(/\r\n?/g, "\n");
  return renderBlocks(text.split("\n"), 0);
}
