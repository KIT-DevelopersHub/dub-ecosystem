// THE authorization surface of commander-service — and the record of why it is deliberately
// NOT built on @dub/policy-gate.
//
// ── WHY NOT policy-gate ─────────────────────────────────────────────────────────────────
// policy-gate's `AUTHENTICATED` and `RequiredKeys` forms rest on ONE premise, stated in
// `packages/policy-gate/src/rule.ts` and `gate.ts`: api-gateway's proxy strips EVERY inbound
// `x-dub-*` header before forwarding, so a downstream Worker may treat `x-dub-user-id` as
// proven and ask identity which permission keys that user holds.
//
// commander-service sits outside that premise, and provably so:
//   - api-gateway has no `commander` segment and no `SVC_COMMANDER` binding
//     (`services/api-gateway/src/routes.ts` + its wrangler configs: zero "commander" hits).
//   - the Commander web app calls `VITE_COMMANDER_API` (default `http://127.0.0.1:8787`)
//     DIRECTLY (`commander/web/src/lib/commanderApi.ts`) — never through the gateway.
//   - nothing anywhere sends `x-dub-user-id` here (repo-wide, `x-dub` does not appear under
//     `commander/` or `services/commander-service/`). The only credential is a shared
//     operator token in `x-commander-token`.
//
// With no gateway in front, `x-dub-user-id` is attacker-controlled. Writing the inventory's
// proposed `appLevel("commander", "view")` here would therefore turn one header line into a
// complete authentication bypass — while READING, in the table, as though it were enforced.
// That is the single worst outcome `docs/policy-coverage-inventory.md` §3(e) names: writing
// a rule the gate cannot actually evaluate, so reviewers trust an artifact that decides
// nothing. §(e)'s exclusion criterion is exactly this ("門が policy-gate の判定材料で出来て
// いない"), and commander matches the e-4 precedent (mail-gateway standalone: off-gateway
// Worker, shared-secret door, no `x-dub-user-id` to resolve keys for) times 23 routes.
// So: commander-service is a SERVICE-LEVEL exclusion from @dub/policy-gate. Putting it back
// under policy-gate is a real option, but it means registering a gateway segment + binding
// and repointing the frontend — see the service's entry in the inventory.
//
// ── WHAT REPLACES IT ────────────────────────────────────────────────────────────────────
// §(e) is explicit that an exclusion has a cost: `assertRouteCoverage` stops watching the
// service, so a route can ship with no authorization and nothing notices. This file pays
// that cost back with the same mechanism in commander's own vocabulary:
//   1. a table naming EVERY route (below),
//   2. a gate that DENIES any route the table omits (`operatorGate`), and
//   3. a coverage test that turns the omission red in CI (`test/protection-table.test.ts`).
// The vocabulary is two words instead of policy-gate's five because this service has exactly
// one principal: the single operator (ADR 0003). There are no roles to express.
//
// THE RULE for this service: no other layer performs an authorization check. If you add a
// route, add its line here — the gate 403s it until you do.
import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "./env";

/**
 * The caller must present `x-commander-token` matching `COMMANDER_OPERATOR_TOKEN`.
 *
 * This is the default and should stay the answer for every route that touches D1: the
 * commander_ namespace holds run prompts, worktree paths, full execution logs and the AI
 * conversation bodies.
 *
 * Note what this form does NOT distinguish: read vs write. The operator token is all-or-
 * nothing by design, because there is exactly one principal. Do not read `OPERATOR` on a GET
 * as "slightly weaker" — it is the same door.
 */
export const OPERATOR = "operator" as const;

/**
 * Deliberately reachable with no credential at all.
 *
 * Exactly one route qualifies (`GET /health`) and the bar for adding a second is high:
 *   - the response must be a CONSTANT — no D1 access, no request echo, nothing derived from
 *     stored state (a liveness probe that leaks "17 runs" is not `OPEN`), and
 *   - an unauthenticated caller must genuinely need it. `/health` does: `commander/dev-up.sh`
 *     polls it with plain `curl` to decide the service came up, and the web app's connection
 *     indicator must be able to say "service is down" vs "your token is wrong" — collapsing
 *     those two into one 401 is how an operator ends up debugging the wrong thing.
 *
 * `OPEN` is not `policy-gate`'s `PUBLIC`: it claims nothing about the open internet, because
 * this Worker is loopback-only today (`workers_dev = false` in both wrangler configs, no
 * gateway route, not in any deploy script).
 */
export const OPEN = "open" as const;

export type Protection = typeof OPERATOR | typeof OPEN;

/** Methods this router may register. */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `"PATCH /chats/:id/messages/:mid"` — method plus the route PATTERN exactly as registered
 *  on the router, `:param` segments verbatim. */
export type RouteKey = `${HttpMethod} /${string}`;

export type ProtectionTable = Readonly<Partial<Record<RouteKey, Protection>>>;

/** Identity function pinning a table literal to `ProtectionTable`, so a malformed key
 *  ("GET/features", "get /features", "FETCH /x") is a compile error rather than a route that
 *  silently never matches and therefore silently 403s. */
function defineProtectionTable<const T extends ProtectionTable>(table: T): T {
  return table;
}

/**
 * Every endpoint `createApp()` serves, with the credential it demands. A route missing from
 * this table is denied at runtime and fails the coverage test.
 */
export const PROTECTION_TABLE = defineProtectionTable({
  // The one unauthenticated route. See `OPEN` for the two conditions it satisfies.
  "GET /health": OPEN,

  // ---- features / phase gate ----
  "GET /features": OPERATOR,
  "POST /features": OPERATOR,
  "GET /features/:id": OPERATOR,
  "POST /features/:id/transition": OPERATOR,
  "GET /features/:id/tasks": OPERATOR,
  "POST /features/:id/tasks": OPERATOR,

  // ---- task board ----
  "GET /tasks": OPERATOR,
  "POST /tasks": OPERATOR,
  "POST /tasks/backfill-urls": OPERATOR,
  "PATCH /tasks/:id": OPERATOR,

  // ---- runs: prompts, worktree paths and the full execution log ----
  "GET /runs": OPERATOR,
  "POST /runs": OPERATOR,
  "GET /runs/:id": OPERATOR,
  "GET /runs/:id/events": OPERATOR,
  "POST /runs/:id/events": OPERATOR,

  // ---- AI chat sessions: the conversation bodies of 「Dubに聞く」/「Dubを操作」 ----
  "GET /chats": OPERATOR,
  "POST /chats": OPERATOR,
  "GET /chats/:id": OPERATOR,
  "PATCH /chats/:id": OPERATOR,
  "DELETE /chats/:id": OPERATOR,
  "POST /chats/:id/messages": OPERATOR,
  "PATCH /chats/:id/messages/:mid": OPERATOR,
});

// ── route identity ──────────────────────────────────────────────────────────────────────
// The ONE string shape a table key, a registered Hono route and a matched request all reduce
// to, so "the route the gate looked up" and "the route the coverage test says must exist"
// cannot be computed two slightly different ways.
//
// This is a deliberate 25-line copy of `packages/policy-gate/src/routes.ts` rather than an
// import. Reason: `@dub/policy-gate` publishes only built output (`files: ["dist"]`, exports
// → `./dist/index.js`) and `dist/` is gitignored, while `commander/dev-up.sh` starts this
// Worker with `wrangler dev` directly and never runs `pnpm build`. Importing the package
// would make module resolution fail at dev startup — a worse trade than copying two pure
// functions. Nothing needs to stay in sync: commander is not gated by policy-gate, and the
// invariant that matters (gate and test share ONE implementation) holds inside this file.

interface RegisteredRoute {
  method: string;
  path: string;
}

/** Anything exposing Hono's `routes` array (a Hono app, or a test double). */
export interface RoutedApp {
  readonly routes: readonly RegisteredRoute[];
}

/** `"GET /features"` — method upper-cased, path verbatim (pattern, not URL). */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Hono records `app.use(path, mw)` as a route with method ALL, so `app.use("*", mw)` and
 * `app.use("/items/*", mw)` both land in `app.routes`. Those are middleware, not endpoints.
 *
 * CONSTRAINT this imposes: register every endpoint with a CONCRETE method. `app.get("/x/*")`
 * is fine (still an endpoint, still gated); `app.all("/x/*")` is forbidden, because Hono
 * records it identically to a `use` mount and the gate would skip it. Unenforceable after
 * registration, so it is a convention — and the reason it is written down here.
 */
function isMiddlewareMount(r: RegisteredRoute): boolean {
  if (r.method.toUpperCase() !== "ALL") return false;
  return r.path === "*" || r.path.endsWith("/*");
}

/** Every endpoint of `app` the gate is responsible for, de-duplicated, in registration
 *  order. Hono records one entry per handler, so a multi-handler route is collapsed here. */
export function protectableRouteKeys(app: RoutedApp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of app.routes) {
    if (isMiddlewareMount(r)) continue;
    const key = routeKey(r.method, r.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The route PATTERN the current request matched, as a table key. Null when no endpoint
 *  matched (only catch-all middleware ran) — nothing to authorize, and Hono will 404. */
function matchedRouteKey(c: Context): string | null {
  const matched = c.req.matchedRoutes;
  for (let i = matched.length - 1; i >= 0; i--) {
    const r = matched[i]!;
    if (!isMiddlewareMount(r)) return routeKey(r.method, r.path);
  }
  return null;
}

// ── coverage ────────────────────────────────────────────────────────────────────────────

export interface CoverageResult {
  ok: boolean;
  /** Registered endpoints with no table entry. The gate 403s these — a forgotten rule. */
  unlisted: string[];
  /**
   * Table entries matching no registered endpoint. Dead weight, and a live hazard: a typo'd
   * key ("GET /feature") means the REAL route is unlisted while the table looks complete.
   */
  orphaned: string[];
}

export function checkRouteCoverage(app: RoutedApp, table: ProtectionTable): CoverageResult {
  const registered = protectableRouteKeys(app);
  const listed = Object.keys(table);
  const registeredSet = new Set(registered);
  const listedSet = new Set(listed);
  return {
    ok: registered.every((k) => listedSet.has(k)) && listed.every((k) => registeredSet.has(k)),
    unlisted: registered.filter((k) => !listedSet.has(k)),
    orphaned: listed.filter((k) => !registeredSet.has(k)),
  };
}

/** Throws a message naming exactly what to add or delete. Called from the coverage test. */
export function assertRouteCoverage(app: RoutedApp, table: ProtectionTable): void {
  const result = checkRouteCoverage(app, table);
  if (result.ok) return;
  const lines = ["PROTECTION_TABLE does not match the registered routes."];
  if (result.unlisted.length > 0) {
    lines.push(
      `  ${result.unlisted.length} route(s) have NO rule (the gate denies them) — add to the table:`,
      ...result.unlisted.map((k) => `    "${k}": OPERATOR   // or OPEN, if it meets both conditions`),
    );
  }
  if (result.orphaned.length > 0) {
    lines.push(
      `  ${result.orphaned.length} table entr(ies) match no route (typo or deleted endpoint) — remove:`,
      ...result.orphaned.map((k) => `    "${k}"`),
    );
  }
  throw new Error(lines.join("\n"));
}

// ── the gate ────────────────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison, so a wrong token cannot be recovered byte by byte by
 * timing the 401s. `crypto.subtle.timingSafeEqual` is a Workers-only extension and does not
 * exist under vitest/node, so this is hand-rolled to behave identically in both.
 *
 * The early length check leaks the token's LENGTH and nothing else, which is acceptable:
 * `dev-up.sh` generates it as `openssl rand -hex 32`, so the length is a known constant and
 * reveals no secret material. The byte loop never early-exits.
 */
function timingSafeEqual(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * THE authorization layer. Mounted once, first, as `app.use("*", ...)`, so it runs before
 * every handler — including handlers added after it.
 *
 * Three fail-closed properties, each of which was a hole before:
 *   1. a route absent from the table is 403, never allowed (it used to be "whatever the
 *      method-based guard happened to do"),
 *   2. GET is gated exactly like POST (every GET used to be wide open), and
 *   3. an UNSET `COMMANDER_OPERATOR_TOKEN` is 503, not a bypass. The previous guard read
 *      `if (expected && ...)`, i.e. "no token configured" meant "no authorization" — the
 *      one shape that fails open, and the one a misconfigured deploy produces.
 */
export function operatorGate(table: ProtectionTable = PROTECTION_TABLE): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const key = matchedRouteKey(c);
    // No endpoint matched: there is nothing to authorize and Hono answers 404.
    if (key === null) return next();

    const rule = table[key as RouteKey];
    if (rule === undefined) {
      // The forgotten-entry case. 403 with the key, so the fix is obvious in the response.
      return c.json({ error: "forbidden", reason: "no_protection_rule", route: key }, 403);
    }
    if (rule === OPEN) return next();

    const expected = c.env.COMMANDER_OPERATOR_TOKEN;
    if (expected === undefined || expected === "") {
      // Misconfiguration, not a bad caller — 503 so it reads as "this service is not
      // correctly deployed" rather than "try another credential".
      return c.json({ error: "unavailable", reason: "operator_token_not_configured" }, 503);
    }

    const presented = c.req.header("x-commander-token");
    if (presented === undefined || !timingSafeEqual(presented, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
