// Minimal Markdown renderer for run reports (headings, lists, tables, code, quotes,
// links, emphasis). Builds React elements only — never injects HTML — so a run's output
// can't script the page. Covers what Claude's reports actually use; not full CommonMark.
import type { CSSProperties, ReactNode } from "react";
import { t } from "./lib/theme.ts";

type Align = "left" | "center" | "right" | undefined;

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

const s = {
  root: { fontSize: 13, lineHeight: 1.7, wordBreak: "break-word" } as CSSProperties,
  p: { margin: `0 0 ${t.space3}` } as CSSProperties,
  h: { margin: `${t.space4} 0 ${t.space2}`, lineHeight: 1.4 } as CSSProperties,
  list: { margin: `0 0 ${t.space3}`, paddingLeft: 22 } as CSSProperties,
  quote: {
    margin: `0 0 ${t.space3}`,
    padding: `0 ${t.space3}`,
    borderLeft: `3px solid ${t.borderStrong}`,
    color: t.textMuted,
  } as CSSProperties,
  pre: {
    margin: `0 0 ${t.space3}`,
    padding: t.space3,
    borderRadius: t.radius,
    background: t.sunken,
    border: `1px solid ${t.border}`,
    overflowX: "auto",
    fontSize: 12,
    fontFamily: mono,
    whiteSpace: "pre",
  } as CSSProperties,
  code: {
    padding: "1px 5px",
    borderRadius: 4,
    background: t.sunken,
    border: `1px solid ${t.border}`,
    fontSize: "0.92em",
    fontFamily: mono,
  } as CSSProperties,
  tableWrap: { overflowX: "auto", margin: `0 0 ${t.space3}` } as CSSProperties,
  table: { borderCollapse: "collapse", fontSize: 12.5 } as CSSProperties,
  cell: {
    border: `1px solid ${t.border}`,
    padding: `${t.space1} ${t.space2}`,
    verticalAlign: "top",
  } as CSSProperties,
  hr: { border: 0, borderTop: `1px solid ${t.border}`, margin: `${t.space4} 0` } as CSSProperties,
  link: { color: t.primary },
};

const HEADING_SIZE = [0, 18, 16, 14.5, 13.5, 13, 13];

// ── inline ────────────────────────────────────────────────────────────────

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()\]）」、。]+)|\*([^*\s](?:[^*]*[^*\s])?)\*/;

function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url) ? url : null;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" style={s.link}>
      {children}
    </a>
  );
}

function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) out.push(<code key={key} style={s.code}>{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<strong key={key}>{inline(m[3], key)}</strong>);
    else if (m[4] !== undefined) out.push(<del key={key}>{inline(m[4], key)}</del>);
    else if (m[5] !== undefined) out.push(<Link key={key} href={m[6]!}>{inline(m[5], key)}</Link>);
    else if (m[7] !== undefined) out.push(<Link key={key} href={m[7]}>{m[7]}</Link>);
    else out.push(<em key={key}>{inline(m[8]!, key)}</em>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Inline content with single newlines kept as line breaks (reports are written that way). */
function lines(text: string, key: string): ReactNode[] {
  return text.split("\n").flatMap((ln, i) => (i === 0 ? inline(ln, `${key}.${i}`) : [<br key={`${key}br${i}`} />, ...inline(ln, `${key}.${i}`)]));
}

// ── blocks ────────────────────────────────────────────────────────────────

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function alignOf(sep: string): Align {
  const c = sep.trim();
  if (c.startsWith(":") && c.endsWith(":")) return "center";
  if (c.endsWith(":")) return "right";
  if (c.startsWith(":")) return "left";
  return undefined;
}

function isBlockStart(ln: string, next: string | undefined): boolean {
  return (
    FENCE.test(ln) ||
    HEADING.test(ln) ||
    HR.test(ln) ||
    LIST_ITEM.test(ln) ||
    QUOTE.test(ln) ||
    (ln.includes("|") && next !== undefined && TABLE_SEP.test(next))
  );
}

interface ListNode {
  ordered: boolean;
  start: number;
  items: { text: string; children: ListNode[] }[];
}

/** Parse list lines (already known to belong to one list block) into a tree by indent. */
function parseList(src: string[]): ListNode {
  const indentOf = (ln: string) => ln.match(/^\s*/)![0].replace(/\t/g, "  ").length;
  const first = LIST_ITEM.exec(src[0]!)!;
  const base = indentOf(src[0]!);
  const root: ListNode = { ordered: /\d/.test(first[2]!), start: parseInt(first[2]!, 10) || 1, items: [] };
  let i = 0;
  while (i < src.length) {
    const m = LIST_ITEM.exec(src[i]!);
    if (m && indentOf(src[i]!) <= base) {
      root.items.push({ text: m[3]!, children: [] });
      i++;
      continue;
    }
    // Deeper lines: a nested list, or a continuation of the current item's text.
    const item = root.items[root.items.length - 1];
    if (!item) {
      i++;
      continue;
    }
    if (m) {
      const nested: string[] = [];
      while (i < src.length && (indentOf(src[i]!) > base || !LIST_ITEM.test(src[i]!))) nested.push(src[i++]!);
      item.children.push(parseList(nested));
    } else {
      item.text += `\n${src[i]!.trim()}`;
      i++;
    }
  }
  return root;
}

function renderList(list: ListNode, key: string, nested = false): ReactNode {
  const items = list.items.map((it, i) => (
    <li key={i}>
      {lines(it.text, `${key}-${i}`)}
      {it.children.map((c, j) => renderList(c, `${key}-${i}-${j}`, true))}
    </li>
  ));
  const style = nested ? { ...s.list, margin: 0 } : s.list;
  return list.ordered ? (
    <ol key={key} start={list.start} style={style}>
      {items}
    </ol>
  ) : (
    <ul key={key} style={style}>
      {items}
    </ul>
  );
}

function blocks(src: string, keyPrefix = "b"): ReactNode[] {
  const ls = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < ls.length) {
    const ln = ls[i]!;
    const key = `${keyPrefix}${n++}`;
    if (!ln.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(ln);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < ls.length && !ls[i]!.trim().startsWith(fence[1]!)) body.push(ls[i++]!);
      i++; // closing fence (or EOF)
      out.push(
        <pre key={key} style={s.pre}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = HEADING.exec(ln);
    if (h) {
      const level = h[1]!.length;
      const Tag = `h${level}` as "h1";
      out.push(
        <Tag key={key} style={{ ...s.h, fontSize: HEADING_SIZE[level] }}>
          {inline(h[2]!, key)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (HR.test(ln)) {
      out.push(<hr key={key} style={s.hr} />);
      i++;
      continue;
    }
    if (ln.includes("|") && i + 1 < ls.length && TABLE_SEP.test(ls[i + 1]!)) {
      const head = splitRow(ln);
      const aligns = splitRow(ls[i + 1]!).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < ls.length && ls[i]!.trim() && ls[i]!.includes("|")) rows.push(splitRow(ls[i++]!));
      out.push(
        <div key={key} style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ ...s.cell, textAlign: aligns[j] ?? "left", background: t.surface }}>
                    {inline(c, `${key}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ ...s.cell, textAlign: aligns[j] }}>
                      {inline(r[j] ?? "", `${key}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (QUOTE.test(ln)) {
      const body: string[] = [];
      while (i < ls.length && QUOTE.test(ls[i]!)) body.push(QUOTE.exec(ls[i++]!)![1]!);
      out.push(
        <blockquote key={key} style={s.quote}>
          {blocks(body.join("\n"), `${key}q`)}
        </blockquote>,
      );
      continue;
    }
    if (LIST_ITEM.test(ln)) {
      const body: string[] = [];
      const ordered = /\d/.test(LIST_ITEM.exec(ln)![2]!);
      // Same-type sibling at the list's own level (a "- a" list ends at "1. b").
      const sibling = (x: string) => {
        const m = LIST_ITEM.exec(x);
        return !!m && /\d/.test(m[2]!) === ordered;
      };
      // A list runs until a blank line followed by non-list, non-indented text.
      while (i < ls.length) {
        const cur = ls[i]!;
        if (!cur.trim()) {
          const next = ls[i + 1];
          if (next !== undefined && (/^\s+\S/.test(next) || (!/^\s/.test(next) && sibling(next)))) {
            i++;
            continue;
          }
          break;
        }
        const topLevel = !/^\s/.test(cur);
        if (body.length > 0 && topLevel && LIST_ITEM.test(cur) && !sibling(cur)) break;
        if (body.length > 0 && topLevel && !LIST_ITEM.test(cur) && isBlockStart(cur, ls[i + 1])) break;
        body.push(cur);
        i++;
      }
      out.push(renderList(parseList(body), key));
      continue;
    }
    const para: string[] = [];
    while (i < ls.length && ls[i]!.trim() && (para.length === 0 || !isBlockStart(ls[i]!, ls[i + 1]))) {
      para.push(ls[i++]!.trim());
    }
    out.push(
      <p key={key} style={s.p}>
        {lines(para.join("\n"), key)}
      </p>,
    );
  }
  return out;
}

export function Markdown({ text, testId }: { text: string; testId?: string }) {
  return (
    <div data-testid={testId} style={s.root}>
      {blocks(text)}
    </div>
  );
}
