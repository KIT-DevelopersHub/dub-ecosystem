// REPO-WIDE guard: every service that should be gated IS gated, and no service uses a
// registration form the gate cannot see.
//
// `assertRouteCoverage` (coverage.ts) protects one service at a time: it compares THAT
// router against THAT table. It is blind to the failure one level up — a service with no
// table and no coverage test at all. Nothing was watching for that, so a newly scaffolded
// service could ship with authorization checks scattered in handlers (or none) and every
// existing test would stay green.
//
// This file closes that gap by walking `services/*` from disk. The intended consequence:
// adding a service makes THIS test red until the author either wires policy-gate or records
// an explicit, reasoned exemption in NOT_GATED below. "Forgot the whole layer" is now as
// loud as "forgot one route".
//
// Deliberately a filesystem/string check rather than an import of every service: importing
// 22 Workers into one vitest process means 22 sets of module side effects and bindings, and
// the property under test ("the three artifacts exist and reference each other") is a fact
// about the repository, not about a running app. The per-service tests do the behavioural
// half.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved from this file's own location, so the test works from any cwd (package-local
 *  `vitest run` under `turbo run test`, and the root `pnpm test`). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVICES_DIR = join(REPO_ROOT, "services");

/**
 * Services deliberately NOT under @dub/policy-gate. An entry needs a reason that says why
 * the gate CANNOT decide for this service — not that wiring it would be inconvenient.
 *
 * The bar is `docs/policy-coverage-inventory.md` (e): policy-gate's rules rest on inputs the
 * gate can actually evaluate (the `x-dub-internal` marker, and a trusted `x-dub-user-id`
 * that api-gateway's proxy guarantees by stripping every inbound `x-dub-*`). Where the real
 * door is made of something else, a rule written in this vocabulary would decide nothing
 * while READING as though it were enforced — the worst outcome, because reviewers trust the
 * table. Such a service is excluded, and owes the same three mechanisms in its own
 * vocabulary (table + fail-closed gate + coverage test).
 */
const NOT_GATED: Record<string, string> = {
  // (e) e-1..e-3: the three `/internal/monitor/*` routes are shared-secret doors
  // (`x-monitor-token` exact match, 403 when unset). The Worker has `workers_dev=true` and no
  // host guard, so `x-dub-internal` is attacker-settable here and INTERNAL would be WEAKER
  // than what is deployed. No UI surface, no permission keys to resolve.
  "app-health-monitor":
    "shared-secret door (x-monitor-token); docs/policy-coverage-inventory.md (e) e-1..e-3",
  // Off-gateway by construction: no `commander` segment and no SVC_COMMANDER binding in
  // api-gateway, and the local SPA calls VITE_COMMANDER_API directly. `x-dub-user-id` is
  // therefore attacker-controlled, so AUTHENTICATED / RequiredKeys would be a bypass that
  // reads as a check. Replaced by the same three mechanisms over `x-commander-token`:
  // src/protection-table.ts + operatorGate + test/protection-table.test.ts.
  "commander-service":
    "off-gateway, x-commander-token only; uses src/protection-table.ts (see its header)",
};

/**
 * `app.all()` registrations that are MOUNTS, not endpoints. Hono records `app.all(p, h)`
 * identically to `app.use(p, mw)` (method ALL), so `isMiddlewareMount` cannot tell them
 * apart and the gate skips both — which is correct for a pass-through and a silent hole for
 * an endpoint. Hence the ban, and this one reasoned exception.
 */
const ALL_METHOD_MOUNTS: Record<string, string> = {
  "api-gateway/src/app.ts":
    "the /api/v1/* proxy pass-through + the 404 catch-all: no decision of their own, the downstream table decides; pinned by api-gateway's own 'deliberate ALL mounts' test (see its policy-table.ts header)",
};

/** Names of the pre-policy-gate per-route middleware. Point 3 of the per-service work set
 *  (`docs/policy-coverage-inventory.md` 4.3) is REMOVING them: a second authorization layer
 *  means the table is no longer the single answer to "who may call this?". */
const LEGACY_AUTHZ_MIDDLEWARE = ["requireAuth", "requirePermission", "requireAppAccess", "requireAny"];

function serviceNames(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((name) => statSync(join(SERVICES_DIR, name)).isDirectory())
    .sort();
}

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out.sort();
}

/**
 * Comments removed, so the syntax guards below read CODE only. Every service file documents
 * the very forms being banned (that is the point of the convention notes in the migrated
 * app.ts files), and matching those sentences would make the guard pure noise.
 *
 * The `[^:]` before `//` keeps `https://…` inside a string literal from eating the rest of
 * its line. Approximate by design — a lexer is not warranted for a grep guard, and the
 * expectations below are asserted to be EMPTY, so any inaccuracy shows up as a visible
 * failure to be fixed rather than as a silent pass.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function relative(path: string): string {
  return path.slice(REPO_ROOT.length + 1);
}

const SERVICES = serviceNames();
const GATED = SERVICES.filter((s) => !(s in NOT_GATED));

describe("every service is either gated or explicitly exempt", () => {
  it("the exemption list names real services, and none of them has quietly adopted the gate", () => {
    const stale: string[] = [];
    for (const [service, reason] of Object.entries(NOT_GATED)) {
      if (!SERVICES.includes(service)) {
        stale.push(`"${service}" is in NOT_GATED but services/${service}/ does not exist — delete the entry.`);
        continue;
      }
      if (existsSync(join(SERVICES_DIR, service, "src/policy-table.ts"))) {
        stale.push(
          `"${service}" is in NOT_GATED (reason: ${reason}) but now has src/policy-table.ts — ` +
            `remove it from NOT_GATED so the checks below apply to it.`,
        );
      }
    }
    expect(stale).toEqual([]);
  });

  // The guard the whole file exists for: a new service with no policy layer fails HERE,
  // naming the four artifacts to add — or the exemption to write.
  it.each(GATED)("%s has a table, a policyGate mount, the dependency and a coverage test", (service) => {
    const root = join(SERVICES_DIR, service);
    const missing: string[] = [];

    if (!existsSync(join(root, "src/policy-table.ts"))) {
      missing.push(
        `src/policy-table.ts is missing — declare every route with definePolicyTable({ "METHOD /path": rule }).`,
      );
    }

    const mounts = tsFilesUnder(join(root, "src")).some((f) => readFileSync(f, "utf8").includes("policyGate("));
    if (!mounts) {
      missing.push(
        `no src/ file calls policyGate( — mount it FIRST: app.use("*", policyGate({ service, table, granted })).`,
      );
    }

    const pkgPath = join(root, "package.json");
    const pkg = existsSync(pkgPath)
      ? (JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> })
      : {};
    if (pkg.dependencies?.["@dub/policy-gate"] === undefined) {
      missing.push(`package.json lacks "@dub/policy-gate": "workspace:*" in dependencies.`);
    }

    const testPath = join(root, "test/policy-table.test.ts");
    if (!existsSync(testPath)) {
      missing.push(`test/policy-table.test.ts is missing — it must call assertRouteCoverage(app, TABLE).`);
    } else if (!readFileSync(testPath, "utf8").includes("assertRouteCoverage")) {
      missing.push(
        `test/policy-table.test.ts exists but never calls assertRouteCoverage — without it the ` +
          `table can drift from the router silently.`,
      );
    }

    if (missing.length === 0) return;
    throw new Error(
      [
        `services/${service}/ is not on @dub/policy-gate (see CLAUDE.md "新しい API を追加する時" and`,
        `services/drive-share-service/ as the reference implementation):`,
        ...missing.map((m) => `  - ${m}`),
        `If this service genuinely cannot be gated (its door is not made of what the gate can`,
        `evaluate — see docs/policy-coverage-inventory.md (e)), add it to NOT_GATED in this file`,
        `WITH the reason, and give it a table + fail-closed gate + coverage test of its own.`,
      ].join("\n"),
    );
  });
});

// Two registration forms that make a route INVISIBLE to the gate. Both are convention-only
// in routes.ts ("there is no way to tell the two apart after registration") — this is the
// machine check that convention was missing.
describe("no service registers a route the gate cannot see", () => {
  const sources = GATED.flatMap((service) =>
    tsFilesUnder(join(SERVICES_DIR, service, "src")).map((file) => ({
      service,
      file,
      code: stripComments(readFileSync(file, "utf8")),
    })),
  );

  it("uses no app.all() for an endpoint", () => {
    // Hono records ALL-method routes exactly like a `use` mount, so an endpoint declared
    // with `.all()` skips the gate AND is invisible to assertRouteCoverage — the one way to
    // ship an ungated route with every test green. `Promise.all` is not this.
    const offenders = sources.flatMap(({ file, code }) => {
      const hits = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\.all\s*\(/g)].filter((m) => m[1] !== "Promise");
      const key = relative(file).replace(/^services\//, "");
      if (hits.length === 0 || key in ALL_METHOD_MOUNTS) return [];
      return hits.map((m) => `${relative(file)}: ${m[1]}.all( — use .get/.post/… instead`);
    });
    expect(offenders).toEqual([]);
  });

  it("mounts middleware only on wildcard paths, never on an exact path", () => {
    // `app.use("/x", mw)` registers `ALL /x`, which `isMiddlewareMount` (wildcards only) reads
    // as an ENDPOINT needing a rule — so coverage goes red for a route that does not exist.
    // The fix is per-route middleware, `app.get("/x", mw, handler)`. NOT a looser
    // `isMiddlewareMount`: widening it to bare paths is what would let `app.all("/x", h)`
    // through, i.e. trading a red build for a silent hole.
    const offenders = sources.flatMap(({ file, code }) =>
      [...code.matchAll(/\.use\(\s*(["'`])([^"'`]*)\1/g)]
        .map((m) => m[2]!)
        .filter((path) => path !== "*" && !path.endsWith("/*"))
        .map(
          (path) =>
            `${relative(file)}: .use("${path}", …) registers ALL ${path} — use per-route middleware instead`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps authorization out of every other layer (no legacy per-route middleware)", () => {
    // Two layers of authorization means the table is no longer the answer; worse, the second
    // layer is the one that is easy to forget on the next route. Resource/owner checks in a
    // handler are NOT this (they are instance-level, see gate.ts) — these four names are the
    // entry-layer middleware the table replaced.
    const offenders = sources.flatMap(({ file, code }) =>
      LEGACY_AUTHZ_MIDDLEWARE.filter((name) => new RegExp(`\\b${name}\\b`).test(code)).map(
        (name) => `${relative(file)}: ${name} — the policy table is the only authorization layer`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
