// The tests that make commander-service's authorization self-enforcing.
//
// commander-service is excluded from @dub/policy-gate (see src/protection-table.ts for the
// trust-model reason), and the inventory is explicit that an exclusion costs you the
// `assertRouteCoverage` safety net. These tests ARE that net, rebuilt locally:
//
//  1. ROUTE COVERAGE — the router's endpoint set and PROTECTION_TABLE's key set must match
//     exactly, in both directions. This turns "I added an endpoint and forgot the table
//     line" from a silent hole into a red build; the second case proves it by actually
//     registering an ungated route and showing the test AND the runtime deny both fire.
//  2. FROZEN ROUTE x PROTECTION TABLE — the protection of every route, committed. Loosening
//     one shows up as a changed line in the diff of this file, so a reviewer sees "runs are
//     readable without a token now" without reading the middleware.
//  3. FAIL-CLOSED — exercised over EVERY protected route, not a sample: no token presented
//     => 401, no token configured => 503. These two loops are the regression test for the
//     holes this layer closed (all 11 GETs unauthenticated; `if (expected && ...)` treating
//     an unset env var as "no authorization").
import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import {
  OPEN,
  OPERATOR,
  PROTECTION_TABLE,
  assertRouteCoverage,
  checkRouteCoverage,
  protectableRouteKeys,
  type Protection,
} from "../src/protection-table";
import { makeD1 } from "./d1";

const TOKEN = "s3cret-token-of-known-length";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { DB: makeD1().d1, COMMANDER_OPERATOR_TOKEN: TOKEN, ...overrides };
}

/** A concrete URL for a route PATTERN: `:param` segments filled with a placeholder. The
 *  gate runs before any handler, so whether the id exists is irrelevant to what we assert. */
function urlFor(path: string): string {
  return `http://x${path.replace(/:[^/]+/g, "placeholder")}`;
}

function parseKey(key: string): { method: string; url: string } {
  const [method, path] = key.split(" ") as [string, string];
  return { method, url: urlFor(path) };
}

async function call(env: Env, key: string, headers: Record<string, string> = {}) {
  const { method, url } = parseKey(key);
  const res = await createApp().fetch(
    new Request(url, { method, headers: { "content-type": "application/json", ...headers } }),
    env as never,
  );
  return { status: res.status, body: await res.text() };
}

const ALL_KEYS = Object.keys(PROTECTION_TABLE);
const PROTECTED_KEYS = ALL_KEYS.filter((k) => PROTECTION_TABLE[k as keyof typeof PROTECTION_TABLE] === OPERATOR);

describe("route coverage (PROTECTION_TABLE <-> router)", () => {
  it("every registered endpoint has exactly one rule, and no rule is orphaned", () => {
    expect(checkRouteCoverage(createApp(), PROTECTION_TABLE)).toEqual({
      ok: true,
      unlisted: [],
      orphaned: [],
    });
    expect(() => assertRouteCoverage(createApp(), PROTECTION_TABLE)).not.toThrow();
  });

  it("catches a new endpoint added without a table entry, and denies it at runtime", async () => {
    const app = createApp();
    // Exactly the mistake this layer exists to catch: a route shipped with no rule.
    app.get("/runs/:id/transcript", (c) => c.json({ leaked: true }));

    const result = checkRouteCoverage(app, PROTECTION_TABLE);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual(["GET /runs/:id/transcript"]);
    expect(() => assertRouteCoverage(app, PROTECTION_TABLE)).toThrow(/GET \/runs\/:id\/transcript/);

    // Fail-closed, not fail-open: refused even when the caller presents the right token.
    const res = await app.fetch(
      new Request("http://x/runs/r1/transcript", { headers: { "x-commander-token": TOKEN } }),
      makeEnv() as never,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no_protection_rule/);
  });

  it("catches a table entry whose route does not exist (typo / deleted endpoint)", () => {
    const typoed = { ...PROTECTION_TABLE, "GET /feature": OPERATOR } as const;
    const result = checkRouteCoverage(createApp(), typoed);
    expect(result.ok).toBe(false);
    expect(result.orphaned).toEqual(["GET /feature"]);
  });
});

describe("route x protection (frozen)", () => {
  // Loosening a route to OPEN changes a line here — a visible diff in review.
  const EXPECTED: Record<string, Protection> = {
    "GET /health": OPEN,

    "GET /features": OPERATOR,
    "POST /features": OPERATOR,
    "GET /features/:id": OPERATOR,
    "POST /features/:id/transition": OPERATOR,
    "GET /features/:id/tasks": OPERATOR,
    "POST /features/:id/tasks": OPERATOR,

    "GET /tasks": OPERATOR,
    "POST /tasks": OPERATOR,
    "POST /tasks/backfill-urls": OPERATOR,
    "PATCH /tasks/:id": OPERATOR,

    "GET /runs": OPERATOR,
    "POST /runs": OPERATOR,
    "GET /runs/:id": OPERATOR,
    "GET /runs/:id/events": OPERATOR,
    "POST /runs/:id/events": OPERATOR,

    "GET /chats": OPERATOR,
    "POST /chats": OPERATOR,
    "GET /chats/:id": OPERATOR,
    "PATCH /chats/:id": OPERATOR,
    "DELETE /chats/:id": OPERATOR,
    "POST /chats/:id/messages": OPERATOR,
    "PATCH /chats/:id/messages/:mid": OPERATOR,
  };

  it("matches the committed protection of every route", () => {
    expect(PROTECTION_TABLE).toEqual(EXPECTED);
  });

  it("the frozen table covers the whole router (no route omitted from the snapshot)", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(protectableRouteKeys(createApp()).sort());
  });

  it("GET /health is the ONLY route reachable without a credential", () => {
    expect(ALL_KEYS.filter((k) => PROTECTION_TABLE[k as keyof typeof PROTECTION_TABLE] === OPEN)).toEqual([
      "GET /health",
    ]);
  });

  it("protects all 11 GETs — run prompts, cwd, execution logs and chat bodies included", () => {
    // The hole this layer closed (inventory a-1): these were ALL unauthenticated.
    expect(PROTECTED_KEYS.filter((k) => k.startsWith("GET "))).toEqual([
      "GET /features",
      "GET /features/:id",
      "GET /features/:id/tasks",
      "GET /tasks",
      "GET /runs",
      "GET /runs/:id",
      "GET /runs/:id/events",
      "GET /chats",
      "GET /chats/:id",
    ]);
    // 9 protected + GET /health = the 10 GET routes the router registers.
    expect(protectableRouteKeys(createApp()).filter((k) => k.startsWith("GET "))).toHaveLength(10);
  });
});

describe("fail-closed: no token presented", () => {
  it.each(PROTECTED_KEYS)("401s %s", async (key) => {
    expect((await call(makeEnv(), key)).status).toBe(401);
  });

  it("401s a wrong token of the same length (constant-time compare still rejects)", async () => {
    const wrong = "x".repeat(TOKEN.length);
    expect(wrong.length).toBe(TOKEN.length);
    expect((await call(makeEnv(), "GET /runs", { "x-commander-token": wrong })).status).toBe(401);
  });

  it("401s a token that is a prefix of the real one", async () => {
    const res = await call(makeEnv(), "GET /runs", { "x-commander-token": TOKEN.slice(0, -1) });
    expect(res.status).toBe(401);
  });
});

describe("fail-closed: COMMANDER_OPERATOR_TOKEN not configured", () => {
  // The old guard was `if (expected && ...)`: an unset var meant NO authorization, so a
  // misconfigured deploy served the whole API to anyone. Now it serves nothing.
  const unconfigured = (): Env => ({ DB: makeD1().d1 });

  it.each(PROTECTED_KEYS)("503s %s instead of allowing it through", async (key) => {
    const res = await call(unconfigured(), key);
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/operator_token_not_configured/);
  });

  it("503s even when the caller presents some token", async () => {
    const res = await call(unconfigured(), "GET /runs", { "x-commander-token": "anything" });
    expect(res.status).toBe(503);
  });

  it("treats an empty-string token as unset, not as a valid empty credential", async () => {
    const res = await call({ DB: makeD1().d1, COMMANDER_OPERATOR_TOKEN: "" }, "GET /runs", {
      "x-commander-token": "",
    });
    expect(res.status).toBe(503);
  });
});

describe("the correct token opens every protected route", () => {
  it.each(PROTECTED_KEYS)("does not deny %s", async (key) => {
    // Handlers may answer 400/404 for the placeholder ids and empty bodies used here; what
    // matters is that the AUTHORIZATION layer is no longer the thing refusing.
    const res = await call(makeEnv(), key, { "x-commander-token": TOKEN });
    expect([401, 403, 503]).not.toContain(res.status);
  });
});

describe("GET /health (OPEN)", () => {
  // `dev-up.sh` polls this with plain curl, and the web app's connection indicator must be
  // able to distinguish "service down" from "token wrong".
  it("answers with no credential at all", async () => {
    const res = await call(makeEnv(), "GET /health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, service: "commander-service", version: "0.1.0" });
  });

  it("returns a constant — it never touches D1, so it can leak no stored state", async () => {
    // Any D1 access at all throws, proving the response is not derived from the database.
    const exploding = new Proxy(
      {},
      {
        get() {
          throw new Error("GET /health must not touch D1");
        },
      },
    ) as unknown as D1Database;
    const res = await call({ DB: exploding, COMMANDER_OPERATOR_TOKEN: TOKEN }, "GET /health");
    expect(res.status).toBe(200);
  });
});

describe("CORS origin allowlist", () => {
  async function get(path: string, headers: Record<string, string>, env: Env = makeEnv()) {
    return createApp().fetch(new Request(`http://x${path}`, { headers }), env as never);
  }

  it("grants a loopback origin on the port dev-up.sh happened to choose", async () => {
    const res = await get("/health", { origin: "http://127.0.0.1:5173" });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
  });

  it("grants localhost and [::1] too", async () => {
    for (const origin of ["http://localhost:4319", "http://[::1]:8787"]) {
      const res = await get("/health", { origin });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("grants NOTHING to an arbitrary site the operator has open (was `origin: *`)", async () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example:8787", "null"]) {
      const res = await get("/runs", { origin, "x-commander-token": TOKEN });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("fails the preflight for a disallowed origin, so the real request is never sent", async () => {
    const res = await createApp().fetch(
      new Request("http://x/runs", {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-commander-token",
        },
      }),
      makeEnv() as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows the token header on a preflight from an allowed origin", async () => {
    const res = await createApp().fetch(
      new Request("http://x/runs", {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-commander-token",
        },
      }),
      makeEnv() as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(res.headers.get("access-control-allow-headers")).toMatch(/x-commander-token/);
  });

  it("COMMANDER_ALLOWED_ORIGINS replaces the loopback default rather than adding to it", async () => {
    const env = makeEnv({ COMMANDER_ALLOWED_ORIGINS: "https://commander.example" });
    const allowed = await get("/health", { origin: "https://commander.example" }, env);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://commander.example");
    const loopback = await get("/health", { origin: "http://127.0.0.1:5173" }, env);
    expect(loopback.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sends no CORS grant to a non-browser caller (daemon fetch / curl: no Origin)", async () => {
    const res = await get("/health", {});
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
