// Contract-conformance: reconcile each service's implemented Hono routes against the
// OpenAPI 3.1 specs (docs/openapi/*.yaml, PR #59). Prefers the repo's canonical specs
// when present; falls back to the vendored snapshot under fixtures/openapi so the check
// is meaningful before #59 merges.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { extractRoutesFromFile, key, type Route } from "./routes";
import { extractSpecRoutesFromFile } from "./openapi";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PKG = fileURLToPath(new URL("../", import.meta.url));

/** Every service that ships a Hono app + an OpenAPI spec. */
export const SERVICES = [
  "api-gateway",
  "audit-log",
  "auth-service",
  "chat-service",
  "deploy-service",
  "drive-proxy",
  "event-service",
  "file-meta",
  "gantt-service",
  "github-sync",
  "identity-roster",
  "mail-automation",
  "mail-gateway",
  "notification",
  "task-service",
  "webhook-ingest",
] as const;

export type ServiceName = (typeof SERVICES)[number];

/** Resolve the spec file: canonical docs/openapi/ if it exists, else the snapshot. */
export function specPathFor(service: ServiceName): { file: string; source: "docs" | "snapshot" } {
  const canonical = join(ROOT, "docs", "openapi", `${service}.yaml`);
  if (existsSync(canonical)) return { file: canonical, source: "docs" };
  return { file: join(PKG, "fixtures", "openapi", `${service}.yaml`), source: "snapshot" };
}

export function appPathFor(service: ServiceName): string {
  return join(ROOT, "services", service, "src", "app.ts");
}

export interface ServiceConformance {
  service: ServiceName;
  specSource: "docs" | "snapshot";
  code: string[]; // "METHOD /path" implemented
  spec: string[]; // "METHOD /path" documented
  /** implemented but absent from the spec (undocumented surface). */
  missingInSpec: string[];
  /** documented but not found in code (unimplemented / undetected). */
  missingInCode: string[];
}

function diff(a: Route[], b: Set<string>): string[] {
  return a
    .map(key)
    .filter((k) => !b.has(k))
    .sort();
}

export function conformanceFor(service: ServiceName): ServiceConformance {
  const { file: specFile, source } = specPathFor(service);
  const code = extractRoutesFromFile(appPathFor(service));
  const spec = extractSpecRoutesFromFile(specFile);
  const codeSet = new Set(code.map(key));
  const specSet = new Set(spec.map(key));
  return {
    service,
    specSource: source,
    code: [...codeSet].sort(),
    spec: [...specSet].sort(),
    missingInSpec: diff(code, specSet),
    missingInCode: diff(spec, codeSet),
  };
}

export function conformanceAll(): ServiceConformance[] {
  return SERVICES.map(conformanceFor);
}

/** Compact drift map (only services with a mismatch), suitable for a golden baseline. */
export function driftBaseline(): Record<string, { missingInSpec: string[]; missingInCode: string[] }> {
  const out: Record<string, { missingInSpec: string[]; missingInCode: string[] }> = {};
  for (const c of conformanceAll()) {
    if (c.missingInSpec.length === 0 && c.missingInCode.length === 0) continue;
    out[c.service] = { missingInSpec: c.missingInSpec, missingInCode: c.missingInCode };
  }
  return out;
}
