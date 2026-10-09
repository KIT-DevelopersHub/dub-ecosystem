// Operate plan: the planner's output, validated before anything touches the API.
//
// A plan is an ordered list of steps, each naming ONE catalog entry. Later steps reference
// earlier results with `{{stepId.path}}` templates (e.g. `{{ev.items[*].id}}`), and a step
// may fan out over a list with `forEach` (+ `where` filters), binding each element as
// `item`. A string that is exactly one template keeps the referenced value's type (so a
// numeric `version` stays a number). Anything still looking like a placeholder after
// resolution blocks execution — this is what stops a `<EVENT_ID>` from ever being sent.

import { findEntry } from "./catalog.ts";

export type WhereOp = "eq" | "ne" | "contains" | "endsWith" | "in" | "notIn" | "empty" | "notEmpty";
export interface Where {
  field: string;
  op: WhereOp;
  value?: unknown;
}

export interface PlanStep {
  id: string;
  op: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  forEach?: string;
  where?: Where[];
  /** Human label per target, e.g. "{{item.title}}". */
  label?: string;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

const WHERE_OPS: readonly WhereOp[] = ["eq", "ne", "contains", "endsWith", "in", "notIn", "empty", "notEmpty"];
const STEP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type ParseResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };

/** Structural validation against the catalog (no network). Errors are Japanese. */
export function parsePlan(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isObj(raw) || !Array.isArray(raw.steps)) return { ok: false, errors: ["計画に steps がありません"] };
  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  raw.steps.forEach((s, i) => {
    const at = `手順${i + 1}`;
    if (!isObj(s)) return void errors.push(`${at}: 形式が不正です`);
    const id = typeof s.id === "string" ? s.id : "";
    if (!STEP_ID_RE.test(id) || id === "item") errors.push(`${at}: id が不正です`);
    else if (seen.has(id)) errors.push(`${at}: id「${id}」が重複しています`);
    seen.add(id);
    const entry = typeof s.op === "string" ? findEntry(s.op) : undefined;
    if (!entry) return void errors.push(`${at}: 「${String(s.op)}」は許可された操作にありません`);
    for (const k of ["params", "query", "body"] as const) {
      if (s[k] !== undefined && !isObj(s[k])) errors.push(`${at}: ${k} はオブジェクトで指定してください`);
    }
    if (s.body !== undefined && !entry.body) errors.push(`${at}: この操作は本文を受け付けません`);
    for (const key of Object.keys(isObj(s.body) ? s.body : {})) {
      if (!entry.body?.allowed.includes(key)) errors.push(`${at}: 本文の「${key}」は変更できません`);
    }
    for (const key of Object.keys(isObj(s.query) ? s.query : {})) {
      if (!entry.query?.includes(key)) errors.push(`${at}: 条件「${key}」は使えません`);
    }
    if (s.forEach !== undefined && typeof s.forEach !== "string") errors.push(`${at}: forEach が不正です`);
    const where = Array.isArray(s.where) ? s.where : s.where === undefined ? [] : null;
    if (where === null || !where.every((w) => isObj(w) && typeof w.field === "string" && WHERE_OPS.includes(w.op as WhereOp))) {
      errors.push(`${at}: 絞り込み条件(where)が不正です`);
    }
    if (where?.length && s.forEach === undefined) errors.push(`${at}: where は forEach と一緒に使ってください`);
    steps.push({
      id,
      op: entry.id,
      ...(isObj(s.params) ? { params: s.params } : {}),
      ...(isObj(s.query) ? { query: s.query } : {}),
      ...(isObj(s.body) ? { body: s.body } : {}),
      ...(typeof s.forEach === "string" ? { forEach: s.forEach } : {}),
      ...(where?.length ? { where: where as Where[] } : {}),
      ...(typeof s.label === "string" ? { label: s.label } : {}),
    });
  });
  if (steps.length === 0 && errors.length === 0) errors.push("計画に手順がありません");
  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { summary: typeof raw.summary === "string" ? raw.summary : "", steps } };
}

// ---- template resolution ---------------------------------------------------------

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE_TEMPLATE_RE = /^\{\{\s*([^}]+?)\s*\}\}$/;

/** `a.b[0].c` / `items[*].id` lookup; `[*]` maps over an array. */
export function getPath(root: unknown, path: string): unknown {
  const tokens = path.match(/[^.[\]]+|\[\*\]|\[\d+\]/g) ?? [];
  let cur: unknown = root;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "[*]") {
      if (!Array.isArray(cur)) return undefined;
      const rest = tokens.slice(i + 1).join(".").replace(/\.\[/g, "[");
      return rest ? cur.map((el) => getPath(el, rest)) : cur;
    }
    const key = t.startsWith("[") ? Number(t.slice(1, -1)) : t;
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

const PIPES: Record<string, (v: unknown) => unknown> = {
  localPart: (v) => (typeof v === "string" ? v.split("@")[0] : v),
  lower: (v) => (typeof v === "string" ? v.toLowerCase() : v),
};

function evalExpr(expr: string, scope: Record<string, unknown>): unknown {
  const [path, ...pipes] = expr.split("|").map((p) => p.trim());
  let v = getPath(scope, path!);
  for (const p of pipes) v = PIPES[p] ? PIPES[p]!(v) : undefined;
  return v;
}

/** Resolve templates in any JSON value; unresolvable ones are left verbatim (and caught). */
export function resolveValue(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_TEMPLATE_RE);
    if (whole) {
      const v = evalExpr(whole[1]!, scope);
      return v === undefined ? value : v;
    }
    return value.replace(TEMPLATE_RE, (m, expr: string) => {
      const v = evalExpr(expr, scope);
      return v === undefined || (typeof v === "object" && v !== null) ? m : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, scope)]));
  return value;
}

const PLACEHOLDER_RE = /\{\{|\}\}|<[A-Z][A-Z0-9_]+>|\b(PLACEHOLDER|REPLACE_ME)\b/;

/** Paths (e.g. "body.version") whose values still look like placeholders. */
export function findPlaceholders(value: unknown, at = ""): string[] {
  if (typeof value === "string") return PLACEHOLDER_RE.test(value) ? [at || "(値)"] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholders(v, `${at}[${i}]`));
  if (isObj(value)) return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, at ? `${at}.${k}` : k));
  return [];
}

export function matchesWhere(item: unknown, where: Where[], scope: Record<string, unknown>): boolean {
  return where.every((w) => {
    const v = getPath(item, w.field);
    const target = resolveValue(w.value, scope);
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    const list = Array.isArray(target) ? target.map(norm) : [];
    switch (w.op) {
      case "eq": return norm(v) === norm(target);
      case "ne": return norm(v) !== norm(target);
      case "contains": return typeof v === "string" && typeof target === "string" && v.includes(target);
      case "endsWith": return typeof v === "string" && typeof target === "string" && v.toLowerCase().endsWith(target.toLowerCase());
      case "in": return list.includes(norm(v));
      case "notIn": return Array.isArray(target) && !list.includes(norm(v));
      case "empty": return v == null || v === "";
      case "notEmpty": return v != null && v !== "";
    }
  });
}
