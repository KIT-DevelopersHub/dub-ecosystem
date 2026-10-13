// Read results -> a compact text for the answerer: every list becomes "N件" + a table with
// ALL rows, cut down to the fields the entry's hint names (no character-count truncation,
// so row 37 of a 40-row list is never lost). The planner's scope keeps the raw data; this
// text is only what the answerer and the session history see.

/** Columns dropped even when named: they help writes, never an answer. */
const NOISE = new Set(["version", "createdAt", "updatedAt", "orgId"]);
/** Free text (descriptions, message bodies) longer than this is cut; lists and ids never are. */
const TEXT_CHARS = 200;
const MAX_DEPTH = 4;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Field names a hint mentions ("items[].id・title・status" -> id, title, status, items). */
export function hintFields(hint: string | undefined): Set<string> {
  return new Set((hint ?? "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

function cell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined || v === "") s = "-";
  else if (Array.isArray(v)) s = v.every(isScalar) ? v.map(String).join(", ") || "-" : `${v.length}件`;
  else if (isObj(v)) s = Object.entries(v).filter(([, x]) => isScalar(x)).map(([k, x]) => `${k}=${String(x)}`).join(" ") || "-";
  else s = String(v);
  s = s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "／");
  return typeof v === "string" && s.length > TEXT_CHARS ? `${s.slice(0, TEXT_CHARS)}…（全${s.length}字）` : s;
}

/** Hint-named keys when any match; otherwise every key whose values are not nested lists. */
function columns(rows: Obj[], fields: Set<string>): string[] {
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const named = keys.filter((k) => fields.has(k) && !NOISE.has(k));
  if (named.length) return named;
  return keys.filter((k) => !NOISE.has(k) && rows.every((r) => !Array.isArray(r[k]) || (r[k] as unknown[]).every(isScalar)));
}

function table(name: string, list: unknown[], fields: Set<string>): string[] {
  const head = `${name}（${list.length}件）`;
  if (list.length === 0) return [head];
  if (list.every(isScalar)) return [`${head}: ${list.map(cell).join(", ")}`];
  if (list.every(Array.isArray)) return [head, ...(list as unknown[][]).map((r) => `| ${r.map(cell).join(" | ")} |`)];
  const rows = list.map((x) => (isObj(x) ? x : { value: x }));
  const cols = columns(rows, fields);
  return [head, `| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`)];
}

function render(value: unknown, name: string, fields: Set<string>, depth: number): string[] {
  if (Array.isArray(value)) return table(name, value, fields);
  if (!isObj(value)) return [`${name}: ${cell(value)}`];
  if (depth >= MAX_DEPTH) return [`${name}: ${cell(value)}`];
  const keys = Object.keys(value);
  const named = keys.filter((k) => fields.has(k));
  const lines: string[] = [];
  for (const k of keys) {
    const v = value[k];
    if (NOISE.has(k) || k === "nextCursor") continue;
    const path = name ? `${name}.${k}` : k;
    if (Array.isArray(v) || isObj(v)) lines.push(...render(v, path, fields, depth + 1));
    else if (!named.length || named.includes(k)) lines.push(`${path}: ${cell(v)}`);
  }
  if (isObj(value) && typeof value.nextCursor === "string") lines.push(`${name ? `${name}.` : ""}nextCursor: 続きあり（この一覧は先頭ページだけ）`);
  return lines;
}

export interface CompactRead {
  text: string;
  /** Rows across every table (a single object counts as 1). */
  rows: number;
  /** UTF-8 size of `text`: what the budget is measured in. */
  bytes: number;
}

/**
 * `data` = one response, or (forEach reads) one response per call with `targets` naming
 * each call, rendered as one section per target.
 */
export function compactRead(data: unknown, hint: string | undefined, targets?: string[]): CompactRead {
  const fields = hintFields(hint);
  const parts = targets ? (data as unknown[]).map((d, i) => ({ title: targets[i] ?? `#${i + 1}`, d })) : [{ title: "", d: data }];
  const lines: string[] = [];
  let rows = 0;
  for (const { title, d } of parts) {
    if (title) lines.push(`■ ${title}`);
    const body = render(d, "", fields, 0);
    lines.push(...(body.length ? body : ["（データなし）"]));
    rows += countRows(d);
  }
  const text = lines.join("\n");
  return { text, rows, bytes: Buffer.byteLength(text, "utf8") };
}

function countRows(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (!isObj(v)) return v == null ? 0 : 1;
  const lists = Object.values(v).filter(Array.isArray) as unknown[][];
  return lists.length ? lists.reduce((n, l) => n + l.length, 0) : 1;
}
