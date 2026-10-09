// Read-only extraction of `"METHOD /path": rule` entries from a service's policy-table.ts
// source text. The catalog test uses this to prove every catalog entry still matches the
// route + permission the service itself enforces (so a renamed route or a changed key turns
// the test red instead of the operate console calling a route that no longer exists).

export interface PolicyRoute {
  method: string;
  /** Service-side path as written in the table (e.g. "/events/:id"). */
  path: string;
  /** Rule source with named constants resolved, whitespace collapsed. */
  rule: string;
  /** "keys" for permission-gated rules; otherwise the bare marker. */
  kind: "keys" | "PUBLIC" | "AUTHENTICATED" | "INTERNAL" | "internalWithKeys";
  /** Fine-grained permission keys (e.g. "event:write"). */
  keys: string[];
  /** ロール管理 3-tier requirement when the rule uses appLevel(). */
  appLevel?: { app: string; level: string };
}

const ENTRY_RE = /"(GET|POST|PUT|PATCH|DELETE)\s+([^"\s]+)"\s*:\s*/g;
const CONST_RE = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*/g;
const APP_LEVEL_RE = /appLevel\(\s*"([^"]+)"\s*,\s*"([^"]+)"/;
const KEY_RE = /"([a-z][a-z_]*(?::[a-z_*]+)+)"/g;

/** Read an expression up to the first `,` `;` or `}` at bracket depth 0. */
function readExpr(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return src.slice(from, i);
      depth--;
    } else if ((ch === "," || ch === ";") && depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").replace(/ as const$/, "").trim();

export function extractPolicyRoutes(source: string): PolicyRoute[] {
  const src = source.replace(/^\s*\/\/.*$/gm, "");
  const consts = new Map<string, string>();
  for (const m of src.matchAll(CONST_RE)) {
    consts.set(m[1]!, collapse(readExpr(src, m.index! + m[0].length)));
  }
  const routes: PolicyRoute[] = [];
  for (const m of src.matchAll(ENTRY_RE)) {
    const raw = collapse(readExpr(src, m.index! + m[0].length));
    const rule = consts.get(raw) ?? raw;
    const appMatch = rule.match(APP_LEVEL_RE);
    const marker = /^(PUBLIC|AUTHENTICATED|INTERNAL)$/.exec(rule)?.[1] as PolicyRoute["kind"] | undefined;
    const kind: PolicyRoute["kind"] = marker ?? (rule.startsWith("internalWithKeys") ? "internalWithKeys" : "keys");
    routes.push({
      method: m[1]!,
      path: m[2]!,
      rule,
      kind,
      keys: [...rule.matchAll(KEY_RE)].map((k) => k[1]!),
      ...(appMatch ? { appLevel: { app: appMatch[1]!, level: appMatch[2]! } } : {}),
    });
  }
  return routes;
}
