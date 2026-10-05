// Minimal, quote-aware SQL text primitives shared by the DDL column parser
// (verify-schema.ts) and the read-only remote adapter guard (remote-d1.ts).
//
// Not a SQL parser: just enough lexical structure to (a) drop comments, (b) find
// statement / list boundaries without being fooled by string literals, quoted
// identifiers or nested parens, and (c) read one identifier. Regex alone cannot do
// this safely — `-- ... ADD COLUMN x` in prose and `CHECK (x IN ('a;b'))` in real DDL
// both appear in this repo's migrations.

const QUOTE_END: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/** Strip comments and split on top-level `;`. Fragments keep their original text
 *  (quotes included) so downstream matchers see real SQL; empty fragments are kept
 *  out by the caller. */
export function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i]!;

    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      cur += " ";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      cur += " ";
      continue;
    }
    const close = QUOTE_END[c];
    if (close !== undefined) {
      cur += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          // SQL escapes a quote by doubling it ('' / "").
          if (sql[i + 1] === close && close !== "]") {
            cur += close + close;
            i += 2;
            continue;
          }
          cur += close;
          i++;
          break;
        }
        cur += sql[i];
        i++;
      }
      continue;
    }
    if (c === ";") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }

  out.push(cur);
  return out;
}

/** Non-empty, comment-free statements. */
export function sqlStatementList(sql: string): string[] {
  return sqlStatements(sql)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Text inside the paren group that starts at `src[0]` (which must be `(`), or null
 *  when it is unbalanced. Quote- and nesting-aware. */
export function sliceParenBody(src: string): string | null {
  if (src[0] !== "(") return null;
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const close = QUOTE_END[c];
    if (close !== undefined) {
      i++;
      while (i < src.length && src[i] !== close) i++;
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(1, i);
    }
    i++;
  }
  return null;
}

/** Split a list on commas at paren depth 0 (quote-aware). */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    const close = QUOTE_END[c];
    if (close !== undefined) {
      cur += c;
      i++;
      while (i < body.length && body[i] !== close) {
        cur += body[i];
        i++;
      }
      cur += close;
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  parts.push(cur);
  return parts;
}

const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*/;

/** Read one identifier (bare or "quoted" / `quoted` / [quoted]) off the front. */
export function readIdent(src: string): { name: string; rest: string } | null {
  const s = src.trimStart();
  const q = s[0];
  if (q === '"' || q === "`" || q === "[") {
    const close = QUOTE_END[q]!;
    const end = s.indexOf(close, 1);
    if (end < 0) return null;
    const name = s.slice(1, end);
    return name.length > 0 ? { name, rest: s.slice(end + 1) } : null;
  }
  const m = BARE_IDENT.exec(s);
  if (!m) return null;
  return { name: m[0], rest: s.slice(m[0].length) };
}

/** Read `[schema.]name`, returning the object name (schema qualifier discarded —
 *  D1 has a single schema). */
export function readQualifiedIdent(src: string): { name: string; rest: string } | null {
  const first = readIdent(src);
  if (!first) return null;
  const rest = first.rest.trimStart();
  if (rest.startsWith(".")) {
    const second = readIdent(rest.slice(1));
    return second ? { name: second.name, rest: second.rest } : null;
  }
  return { name: first.name, rest };
}
