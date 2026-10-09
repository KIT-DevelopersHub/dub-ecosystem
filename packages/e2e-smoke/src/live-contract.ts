// Read-only contract smoke against a DEPLOYED gateway (staging / prod). GET only, no
// credentials, nothing written: each check is a status code plus the response body
// validated against the response schema the canonical gateway spec
// (docs/openapi/api-gateway.yaml) declares for that operation + status — the schemas are
// read from the spec, not re-written here. Driven by scripts/smoke-readonly.ts.
//
// The validator covers the JSON Schema subset the gateway spec uses and THROWS on any
// other keyword, so a spec change can never make a check pass by being ignored.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

type Schema = Record<string, unknown>;
type Spec = { paths: Record<string, Record<string, { responses: Record<string, Schema> }>>; components: Record<string, Record<string, Schema>> };

export const GATEWAY_SPEC = fileURLToPath(new URL("../../../docs/openapi/api-gateway.yaml", import.meta.url));

export const GATEWAY_ORIGINS = {
  staging: "https://dub-api-gateway-staging.developershub-site.workers.dev",
  prod: "https://dub-api-gateway.developershub-site.workers.dev",
} as const;
export type LiveEnv = keyof typeof GATEWAY_ORIGINS;

export interface LiveCheck {
  path: string;
  status: number;
  /** spec operation whose `responses[status]` schema the body must satisfy */
  op: { path: string; method: "get" };
  /** expected error.code for non-2xx */
  code?: string;
}

const PROXY = { path: "/api/v1/{segment}/{path}", method: "get" } as const;

/** The contract. Unauthenticated reads of the three services' routes must be refused at
 *  the gateway with the documented 401 envelope — proving the segment routes to a
 *  protected service and never serves data anonymously. */
export const LIVE_CHECKS: readonly LiveCheck[] = [
  { path: "/healthz", status: 200, op: { path: "/healthz", method: "get" } },
  { path: "/api/v1/me", status: 401, op: { path: "/api/v1/me", method: "get" }, code: "UNAUTHENTICATED" },
  { path: "/api/v1/identity/users", status: 401, op: PROXY, code: "UNAUTHENTICATED" },
  { path: "/api/v1/members/teams", status: 401, op: PROXY, code: "UNAUTHENTICATED" },
  { path: "/api/v1/driveshare/files", status: 401, op: PROXY, code: "UNAUTHENTICATED" },
];

export function loadSpec(file = GATEWAY_SPEC): Spec {
  return load(readFileSync(file, "utf8")) as Spec;
}

function deref(spec: Spec, node: Schema): Schema {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const m = /^#\/components\/(\w+)\/(\w+)$/.exec(ref);
  const target = m && spec.components[m[1]!]?.[m[2]!];
  if (!target) throw new Error(`unresolvable $ref ${ref}`);
  return deref(spec, target);
}

/** The JSON schema the spec declares for `op` answering `status`. */
export function responseSchema(spec: Spec, op: LiveCheck["op"], status: number): Schema {
  const res = spec.paths[op.path]?.[op.method]?.responses[String(status)];
  if (!res) throw new Error(`spec has no ${status} response for ${op.method.toUpperCase()} ${op.path}`);
  const content = deref(spec, res).content as Record<string, { schema?: Schema }> | undefined;
  const schema = content?.["application/json"]?.schema;
  if (!schema) throw new Error(`spec ${op.method.toUpperCase()} ${op.path} ${status} has no application/json schema`);
  return schema;
}

const ANNOTATIONS = new Set(["description", "example", "examples", "title", "format", "deprecated", "readOnly", "writeOnly"]);
const SUPPORTED = new Set(["$ref", "type", "required", "properties", "items", "enum", "nullable", "additionalProperties"]);

/** Validate `value` against `schema`; returns human-readable violations (empty = valid). */
export function validate(spec: Spec, schema: Schema, value: unknown, at = "$"): string[] {
  const s = deref(spec, schema);
  for (const k of Object.keys(s)) {
    if (!SUPPORTED.has(k) && !ANNOTATIONS.has(k)) throw new Error(`${at}: unsupported schema keyword "${k}"`);
  }
  if (value === null) return s.nullable === true || Object.keys(s).every((k) => ANNOTATIONS.has(k)) ? [] : [`${at}: null`];
  if (s.enum && !(s.enum as unknown[]).includes(value)) return [`${at}: ${JSON.stringify(value)} not in enum`];
  const t = s.type as string | undefined;
  const actual = Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (t && !(t === actual || (t === "number" && actual === "integer"))) return [`${at}: expected ${t}, got ${actual}`];

  const out: string[] = [];
  if (actual === "array" && s.items) {
    (value as unknown[]).forEach((v, i) => out.push(...validate(spec, s.items as Schema, v, `${at}[${i}]`)));
  }
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) if (!(r in obj)) out.push(`${at}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) out.push(...validate(spec, props[k]!, v, `${at}.${k}`));
      else if (s.additionalProperties === false) out.push(`${at}.${k}: not allowed`);
    }
  }
  return out;
}

export interface CheckResult {
  check: LiveCheck;
  ok: boolean;
  problems: string[];
}

const ATTEMPTS = 3;

/** GET with retry on transport errors / 5xx only (cold starts, edge blips); a 4xx or a
 *  wrong 2xx is an answer and is never retried. */
async function getWithRetry(fetchImpl: typeof fetch, url: URL, backoffMs: number): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status < 500 || i === ATTEMPTS) return res;
    } catch (e) {
      if (i === ATTEMPTS) throw e;
    }
    await new Promise((r) => setTimeout(r, backoffMs * i));
  }
}

/** Run every check against `baseUrl`. GET only — this function must never send a body. */
export async function runLiveChecks(
  baseUrl: string,
  spec = loadSpec(),
  fetchImpl: typeof fetch = fetch,
  backoffMs = 2_000,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of LIVE_CHECKS) {
    const problems: string[] = [];
    try {
      const res = await getWithRetry(fetchImpl, new URL(check.path, baseUrl), backoffMs);
      if (res.status !== check.status) problems.push(`status ${res.status}, want ${check.status}`);
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        problems.push(`body is not JSON: ${text.slice(0, 120)}`);
      }
      if (body !== undefined) {
        problems.push(...validate(spec, responseSchema(spec, check.op, check.status), body));
        const code = (body as { error?: { code?: unknown } }).error?.code;
        if (check.code && code !== check.code) problems.push(`error.code ${String(code)}, want ${check.code}`);
      }
    } catch (e) {
      problems.push(`request failed: ${(e as Error).message}`);
    }
    results.push({ check, ok: problems.length === 0, problems });
  }
  return results;
}
