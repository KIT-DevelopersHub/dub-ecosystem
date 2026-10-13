/// <reference lib="dom" />
// WYSIWYG composer <-> Markdown-subset bridge (Slack-style: the draft shows *bold*
// as bold, not as asterisks). The wire / draft format stays the same Markdown subset
// render-body.ts parses, so sending, draft persistence and rendering are unchanged.
//
// Editor DOM shape (what renderEditor builds and serializeEditor reads):
//   root > div[data-block?]   one div per line; data-block = quote | bullet | ordered | code
//   inline: b/strong · i/em · u · s/strike/del · code · a[href] · span[data-md] (mention chip)
// The serializer also tolerates what browsers produce while typing (bare text / <br>
// directly under root, nested divs), so it never has to trust the DOM shape.
import { parseBlocks, type BodySegment } from "./render-body";

export type LineBlock = "quote" | "bullet" | "ordered" | "code";
const LINE_BLOCKS: readonly string[] = ["quote", "bullet", "ordered", "code"];

type Mark = "bold" | "italic" | "underline" | "strike" | "code";
// Outer -> inner marker order when one run carries several marks.
const MARK_ORDER: readonly Mark[] = ["bold", "italic", "underline", "strike"];
const MARKER: Record<Exclude<Mark, "code">, string> = { bold: "*", italic: "_", underline: "++", strike: "~" };

type Piece =
  | { kind: "text"; text: string; marks: ReadonlySet<Mark>; href?: string }
  | { kind: "raw"; md: string };

interface Line {
  block: LineBlock | null;
  pieces: Piece[];
}

const ZWSP = /\u200B/g;

export interface MentionLabels {
  user?: (id: string) => string | undefined;
  team?: (id: string) => string | undefined;
}

// ---------------------------------------------------------------- DOM -> Markdown

function tagMark(el: Element): Mark | null {
  switch (el.tagName) {
    case "B":
    case "STRONG":
      return "bold";
    case "I":
    case "EM":
      return "italic";
    case "U":
      return "underline";
    case "S":
    case "STRIKE":
    case "DEL":
      return "strike";
    case "CODE":
      return "code";
    default:
      return null;
  }
}

function isLineElement(el: Element): boolean {
  return ["DIV", "P", "LI", "PRE", "BLOCKQUOTE", "UL", "OL", "H1", "H2", "H3"].includes(el.tagName);
}

function blockOf(el: Element, inherited: LineBlock | null): LineBlock | null {
  const own = (el as HTMLElement).dataset?.block;
  if (own && LINE_BLOCKS.includes(own)) return own as LineBlock;
  if (el.tagName === "BLOCKQUOTE") return "quote";
  if (el.tagName === "PRE") return "code";
  if (el.tagName === "LI") return el.parentElement?.tagName === "OL" ? "ordered" : "bullet";
  return inherited;
}

function collectLines(root: Element): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  const open = (block: LineBlock | null): Line => (cur ??= { block, pieces: [] });
  const flush = () => {
    if (cur) lines.push(cur);
    cur = null;
  };

  const visit = (node: Node, block: LineBlock | null, marks: ReadonlySet<Mark>, href?: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(ZWSP, "");
      if (text) open(block).pieces.push({ kind: "text", text, marks, href });
      return;
    }
    if (!(node instanceof Element)) return;
    const md = (node as HTMLElement).dataset?.md;
    if (md) {
      open(block).pieces.push({ kind: "raw", md });
      return;
    }
    if (node.tagName === "BR") {
      // A <br> closing its block (Chrome's "<div>x<br></div>" / empty-line "<div><br></div>")
      // only marks the line as existing; a <br> mid-line is a real line break.
      open(block);
      if (node.nextSibling || !node.parentElement || node.parentElement === root) flush();
      return;
    }
    if (isLineElement(node)) {
      const inner = blockOf(node, block);
      const container = ["UL", "OL", "BLOCKQUOTE", "PRE"].includes(node.tagName) && node.firstElementChild;
      flush();
      if (!container) open(inner);
      node.childNodes.forEach((c) => visit(c, inner, marks, href));
      flush();
      return;
    }
    const mark = tagMark(node);
    const nextMarks = mark ? new Set([...marks, mark]) : marks;
    const nextHref = node.tagName === "A" ? (node.getAttribute("href") ?? undefined) : href;
    node.childNodes.forEach((c) => visit(c, block, nextMarks, nextHref));
  };

  root.childNodes.forEach((c) => visit(c, null, new Set()));
  flush();
  return lines;
}

function sameMarks(a: ReadonlySet<Mark>, b: ReadonlySet<Mark>): boolean {
  return a.size === b.size && [...a].every((m) => b.has(m));
}

/** Inline Markdown for one line (code-block lines are emitted raw by the caller). */
function lineMarkdown(pieces: Piece[]): string {
  // Merge adjacent runs with identical formatting so "<b>a</b><b>b</b>" -> "*ab*".
  const merged: Piece[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (p.kind === "text" && prev?.kind === "text" && prev.href === p.href && sameMarks(prev.marks, p.marks)) {
      merged[merged.length - 1] = { ...prev, text: prev.text + p.text };
    } else merged.push(p);
  }
  let out = "";
  for (const p of merged) {
    if (p.kind === "raw") {
      out += p.md;
      continue;
    }
    if (p.marks.has("code")) {
      out += `\`${p.text}\``;
      continue;
    }
    // Markers must hug non-space text ("* a*" is not bold) — keep edge spaces outside.
    const lead = /^\s*/.exec(p.text)![0];
    const trail = p.text.length > lead.length ? /\s*$/.exec(p.text)![0] : "";
    const core = p.text.slice(lead.length, p.text.length - trail.length);
    let body = core;
    // A link can't carry marks in the subset ("*[a](u)*" renders as literal bold text).
    if (core && p.href) body = core === p.href ? core : `[${core}](${p.href})`;
    else if (core) {
      for (const m of [...MARK_ORDER].reverse()) {
        const k = MARKER[m as Exclude<Mark, "code">];
        if (p.marks.has(m)) body = `${k}${body}${k}`;
      }
    }
    out += lead + body + trail;
  }
  return out;
}

/** Serialize the editor's DOM to the Markdown subset render-body parses. */
export function serializeEditor(root: Element): string {
  const lines = collectLines(root);
  // Trailing empty lines (any block) are just where the caret sat — never part of the message.
  while (lines.length > 0 && lines[lines.length - 1]!.pieces.every((p) => p.kind === "text" && p.text.trim() === "")) lines.pop();
  const out: string[] = [];
  let ordinal = 0;
  let inCode = false;
  for (const line of lines) {
    if (line.block === "code") {
      if (!inCode) out.push("```");
      inCode = true;
      out.push(line.pieces.map((p) => (p.kind === "raw" ? p.md : p.text)).join(""));
      continue;
    }
    if (inCode) out.push("```");
    inCode = false;
    ordinal = line.block === "ordered" ? ordinal + 1 : 0;
    const md = lineMarkdown(line.pieces);
    if (line.block === "quote") out.push(`> ${md}`);
    else if (line.block === "bullet") out.push(`- ${md}`);
    else if (line.block === "ordered") out.push(`${ordinal}. ${md}`);
    else out.push(md);
  }
  if (inCode) out.push("```");
  return out.join("\n");
}

// ---------------------------------------------------------------- Markdown -> DOM

/** A mention chip: atomic (caret cannot enter), carries its wire token in data-md. */
export function mentionChip(doc: Document, token: string, label: string, kind: "user" | "team"): HTMLElement {
  const chip = doc.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.md = token;
  chip.dataset.mention = kind;
  chip.textContent = `@${label}`;
  return chip;
}

function appendInline(doc: Document, parent: Element, segs: BodySegment[], labels: MentionLabels): void {
  for (const seg of segs) {
    const wrap = (tag: string, text: string) => {
      const el = doc.createElement(tag);
      el.textContent = text;
      parent.appendChild(el);
    };
    switch (seg.type) {
      case "bold":
        wrap("b", seg.value);
        break;
      case "italic":
        wrap("i", seg.value);
        break;
      case "underline":
        wrap("u", seg.value);
        break;
      case "strike":
        wrap("s", seg.value);
        break;
      case "code":
        wrap("code", seg.value);
        break;
      case "link": {
        const a = doc.createElement("a");
        a.setAttribute("href", seg.href);
        a.textContent = seg.label;
        parent.appendChild(a);
        break;
      }
      case "mention":
        parent.appendChild(mentionChip(doc, `<@${seg.userId}>`, labels.user?.(seg.userId) ?? seg.userId, "user"));
        break;
      case "teamMention":
        parent.appendChild(mentionChip(doc, `<!team:${seg.teamId}>`, labels.team?.(seg.teamId) ?? seg.teamId, "team"));
        break;
      default:
        parent.appendChild(doc.createTextNode(seg.value));
    }
  }
}

/** Build one editor line. Empty lines get a <br> so the caret has somewhere to sit. */
export function lineElement(doc: Document, block: LineBlock | null): HTMLDivElement {
  const div = doc.createElement("div");
  if (block) div.dataset.block = block;
  return div;
}

function finishLine(div: HTMLElement): HTMLElement {
  if (!div.firstChild) div.appendChild(div.ownerDocument.createElement("br"));
  return div;
}

/** Replace the editor's content with the WYSIWYG rendering of a Markdown body. */
export function renderEditor(root: Element, markdown: string, labels: MentionLabels = {}): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  if (markdown === "") {
    root.appendChild(finishLine(lineElement(doc, null)));
    return;
  }
  const push = (block: LineBlock | null, segs: BodySegment[] | null, raw?: string) => {
    const div = lineElement(doc, block);
    if (segs) appendInline(doc, div, segs, labels);
    else if (raw) div.textContent = raw;
    root.appendChild(finishLine(div));
  };
  for (const b of parseBlocks(markdown)) {
    if (b.type === "codeblock") b.value.split("\n").forEach((ln) => push("code", null, ln));
    else if (b.type === "paragraph") b.lines.forEach((l) => push(null, l));
    else if (b.type === "blockquote") b.lines.forEach((l) => push("quote", l));
    else b.items.forEach((l) => push(b.type === "bullet" ? "bullet" : "ordered", l));
  }
}

// ---------------------------------------------------------------- caret / line editing
// Small DOM operations the composer needs beyond what the browser does natively.
// All of them leave the caret somewhere sensible and keep root > div lines intact.

/** The selection's range, only when it sits inside `root`. */
export function rangeIn(root: Element): Range | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  return root.contains(r.startContainer) && root.contains(r.endContainer) ? r : null;
}

export function placeCaret(node: Node, offset: number): void {
  const doc = node.ownerDocument ?? (node as Document);
  const sel = doc.getSelection();
  if (!sel) return;
  const r = doc.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Caret at the very end of the editor (last line). */
export function caretToEnd(root: Element): void {
  const last = root.lastChild;
  if (!last) return placeCaret(root, 0);
  const brTail = last.lastChild?.nodeName === "BR";
  placeCaret(last, Math.max(0, last.childNodes.length - (brTail ? 1 : 0)));
}

function isLineEmpty(line: Element): boolean {
  return (line.textContent ?? "").replace(ZWSP, "") === "" && !line.querySelector("[data-md]");
}

/**
 * Wrap stray root-level inline nodes into line divs (browsers leave bare text / <br>
 * under root after select-all + delete, Firefox splits lines with <br>). No-op when
 * the root is already line-shaped, so it is cheap to call before structural edits.
 */
export function ensureLines(root: Element): void {
  const doc = root.ownerDocument;
  const stray = [...root.childNodes].some((c) => !(c instanceof Element && c.tagName === "DIV"));
  if (!stray && root.firstChild) return;
  const sel = doc.getSelection();
  const anchor = sel && sel.rangeCount > 0 ? { node: sel.anchorNode, offset: sel.anchorOffset } : null;
  let run: HTMLDivElement | null = null;
  for (const child of [...root.childNodes]) {
    if (child instanceof Element && child.tagName === "DIV") {
      run = null;
      continue;
    }
    if (child instanceof Element && child.tagName === "BR") {
      // A <br> ends the current run; on its own it is an empty line.
      if (run) child.remove();
      else {
        const empty = lineElement(doc, null);
        root.insertBefore(empty, child);
        empty.appendChild(child);
      }
      run = null;
      continue;
    }
    if (!run) {
      // Text typed next to an empty line (caret parked on root) belongs in that line.
      const adjacent = [child.previousSibling, child.nextSibling].find(
        (n): n is HTMLDivElement => n instanceof HTMLDivElement && isLineEmpty(n),
      );
      if (adjacent) adjacent.replaceChildren();
      if (adjacent && adjacent === child.nextSibling) {
        adjacent.appendChild(child);
        continue;
      }
      run = adjacent ?? lineElement(doc, null);
      if (!adjacent) root.insertBefore(run, child);
    }
    run.appendChild(child);
  }
  if (!root.firstChild) root.appendChild(finishLine(lineElement(doc, null)));
  if (anchor?.node && anchor.node !== root && root.contains(anchor.node)) placeCaret(anchor.node, anchor.offset);
  else if (anchor && rangeIn(root) === null && doc.activeElement === root) caretToEnd(root);
}

/** The root-level line div holding the caret. */
export function caretLine(root: Element, r: Range | null = rangeIn(root)): HTMLElement | null {
  if (!r) return null;
  let n: Node | null = r.startContainer;
  if (n === root) n = root.childNodes[r.startOffset] ?? root.lastChild;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n instanceof HTMLElement ? n : null;
}

/** Visible text of the caret's line up to the caret (mention chips count as one U+FFFC). */
export function textBeforeCaret(root: Element): string {
  const r = rangeIn(root);
  const line = caretLine(root, r);
  if (!r || !line) return "";
  const pre = root.ownerDocument.createRange();
  pre.selectNodeContents(line);
  pre.setEnd(r.startContainer, r.startOffset);
  const frag = pre.cloneContents();
  frag.querySelectorAll("[data-md]").forEach((c) => c.replaceWith("￼"));
  return (frag.textContent ?? "").replace(ZWSP, "");
}

/** Range covering the last `count` visible characters before the caret on its line. */
function rangeBack(root: Element, count: number): Range | null {
  const r = rangeIn(root);
  const line = caretLine(root, r);
  if (!r || !line) return null;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  const out = doc.createRange();
  out.setEnd(r.startContainer, r.startOffset);
  let remaining = count;
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!;
    if (t.parentElement?.closest("[data-md]")) continue;
    let end: number;
    if (t === r.startContainer) end = r.startOffset;
    else if (r.comparePoint(t, t.length) <= 0) end = t.length;
    else continue;
    for (let j = end - 1; j >= 0; j--) {
      if (t.data[j] === "\u200B") continue;
      if (--remaining === 0) {
        out.setStart(t, j);
        return out;
      }
    }
  }
  return null;
}

/** Put the caret right after `el` without letting the next keystroke inherit its formatting. */
function caretAfter(el: Node): void {
  // The caret sits after a zero-width pad: browsers resolve a caret at the edge of
  // <b> (or in an empty text node) to inside it, so the next keystroke would stay bold.
  const next = el.nextSibling;
  if (next instanceof Text) {
    if (!next.data.startsWith("\u200B")) next.insertData(0, "\u200B");
    return placeCaret(next, 1);
  }
  const pad = el.ownerDocument!.createTextNode("\u200B");
  el.parentNode!.insertBefore(pad, next);
  placeCaret(pad, 1);
}

/** Replace the last `count` visible chars before the caret with `nodes`. */
export function replaceBeforeCaret(root: Element, count: number, nodes: Node[]): boolean {
  const r = count > 0 ? rangeBack(root, count) : rangeIn(root);
  if (!r) return false;
  r.deleteContents();
  const frag = root.ownerDocument.createDocumentFragment();
  nodes.forEach((n) => frag.appendChild(n));
  const last = nodes[nodes.length - 1];
  r.insertNode(frag);
  if (last instanceof Text) placeCaret(last, last.length);
  else if (last) caretAfter(last);
  return true;
}

/** Insert plain text at the caret (native insertText keeps the browser's undo stack). */
export function insertText(root: Element, text: string): void {
  const doc = root.ownerDocument;
  let ok = false;
  try {
    ok = typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }
  if (ok) return;
  const r = rangeIn(root);
  if (!r) return;
  r.deleteContents();
  const node = doc.createTextNode(text);
  r.insertNode(node);
  placeCaret(node, node.length);
}

/**
 * Shift+Enter: split the caret's line, carrying its block type (list / quote / code
 * continue like Slack). On an empty block line it just drops the block instead.
 */
export function splitLine(root: Element): void {
  ensureLines(root);
  const r = rangeIn(root);
  const line = caretLine(root, r);
  if (!r || !line) return;
  r.deleteContents();
  const block = (line.dataset.block as LineBlock | undefined) ?? null;
  if (block && isLineEmpty(line)) {
    delete line.dataset.block;
    return;
  }
  const doc = root.ownerDocument;
  const tail = doc.createRange();
  tail.setStart(r.startContainer, r.startOffset);
  tail.setEnd(line, line.childNodes.length);
  const next = lineElement(doc, block);
  next.appendChild(tail.extractContents());
  for (const el of [line, next]) {
    if (isLineEmpty(el)) el.replaceChildren(doc.createElement("br"));
  }
  line.after(next);
  placeCaret(next, 0);
}

/** Backspace at the start of a block line removes the block (bullet / quote) first. */
export function unblockAtLineStart(root: Element): boolean {
  const r = rangeIn(root);
  const line = caretLine(root, r);
  if (!r?.collapsed || !line?.dataset.block || textBeforeCaret(root) !== "") return false;
  delete line.dataset.block;
  return true;
}

/** Toolbar block buttons: set `block` on every selected line, or clear it if all have it. */
export function toggleLineBlock(root: Element, block: LineBlock): void {
  ensureLines(root);
  const r = rangeIn(root);
  if (!r) return;
  const lines = [...root.children].filter((c): c is HTMLElement => c instanceof HTMLElement && r.intersectsNode(c));
  const target = lines.length > 0 ? lines : [caretLine(root, r)].filter((l): l is HTMLElement => !!l);
  const allOn = target.every((l) => l.dataset.block === block);
  for (const l of target) {
    if (allOn) delete l.dataset.block;
    else l.dataset.block = block;
  }
}

/** Inline-code toggle (no execCommand for <code>): wrap / unwrap the selection. */
export function toggleInlineCode(root: Element): void {
  const r = rangeIn(root);
  if (!r) return;
  const doc = root.ownerDocument;
  const startEl = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
  const inCode = startEl?.closest("code");
  if (inCode && root.contains(inCode)) {
    if (r.collapsed) return caretAfter(inCode);
    const text = doc.createTextNode(inCode.textContent ?? "");
    inCode.replaceWith(text);
    placeCaret(text, text.length);
    return;
  }
  const code = doc.createElement("code");
  if (r.collapsed) {
    const pad = doc.createTextNode("\u200B");
    code.appendChild(pad);
    r.insertNode(code);
    placeCaret(pad, 1);
    return;
  }
  code.textContent = r.toString();
  r.deleteContents();
  r.insertNode(code);
  caretAfter(code);
}

/** Wrap the selection in a link (or insert the URL itself when nothing is selected). */
export function insertLink(root: Element, href: string): void {
  const r = rangeIn(root);
  if (!r) return;
  const a = root.ownerDocument.createElement("a");
  a.setAttribute("href", href);
  a.textContent = r.collapsed ? href : r.toString();
  r.deleteContents();
  r.insertNode(a);
  caretAfter(a);
}

// Typed-Markdown shortcuts (Slack converts as you type). Same delimiters the renderer
// uses, so what the draft shows is what the message will show.
const INLINE_RULES: { re: RegExp; tag: string }[] = [
  { re: /`([^`\n]+)`$/, tag: "code" },
  { re: /\+\+([^+\n]+)\+\+$/, tag: "u" },
  { re: /\*([^*\n]+)\*$/, tag: "b" },
  { re: /_([^_\n]+)_$/, tag: "i" },
  { re: /~([^~\n]+)~$/, tag: "s" },
];
const LINE_RULES: { re: RegExp; block: LineBlock }[] = [
  { re: /^[-*] $/, block: "bullet" },
  { re: /^1\. $/, block: "ordered" },
  { re: /^> $/, block: "quote" },
  { re: /^```$/, block: "code" },
];

/** Apply typed-Markdown shortcuts after a keystroke. Returns true when the DOM changed. */
export function applyInputRules(root: Element): boolean {
  const r = rangeIn(root);
  const line = caretLine(root, r);
  if (!r?.collapsed || !line) return false;
  const before = textBeforeCaret(root);
  if (!line.dataset.block) {
    const rule = LINE_RULES.find((x) => x.re.test(before));
    if (rule && replaceBeforeCaret(root, before.length, [])) {
      line.dataset.block = rule.block;
      if (isLineEmpty(line)) {
        line.replaceChildren(root.ownerDocument.createElement("br"));
        placeCaret(line, 0);
      }
      return true;
    }
  }
  if (line.dataset.block === "code" || r.startContainer.nodeType !== Node.TEXT_NODE) return false;
  const node = r.startContainer as Text;
  if (node.parentElement?.closest("code, a, [data-md]")) return false;
  const typed = node.data.slice(0, r.startOffset).replace(ZWSP, "");
  for (const { re, tag } of INLINE_RULES) {
    const m = re.exec(typed);
    if (!m) continue;
    // Leave URLs alone ("https://x/a_b_" is a link, not italic).
    const word = typed.slice(0, m.index).split(/\s/).pop() ?? "";
    if (word.includes("://")) return false;
    const el = root.ownerDocument.createElement(tag);
    el.textContent = m[1]!;
    return replaceBeforeCaret(root, m[0].length, [el]);
  }
  return false;
}
