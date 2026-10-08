// createAuthzGranter / sharedAuthzGranter — the ADR 0004 TTL cache.
//
// Everything here is measured against a counting fake of the identity-roster Service
// Binding: the assertions are "how many /authz/check calls happened and with which keys",
// because that is the property the ADR is about (authz stays a live check, but
// identity-roster is not on the hot path of every single request).
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { identity } from "@dub/types";
import {
  createAuthzGranter,
  sharedAuthzGranter,
  createAuthzCache,
  isDangerousPermission,
  DANGEROUS_PERMISSION_KEYS,
} from "../src/index";

const TTL = 60; // identity-roster's AUTHZ_TTL_SECONDS

/** A key the catalog marks dangerous, and one it does not. */
const DANGEROUS: identity.PermissionKey = "infra:deploy";
const SAFE: identity.PermissionKey = "task:read";

interface FakeIdentity {
  binding: Fetcher;
  /** One entry per POST /authz/check, holding the keys that call asked about. */
  calls: identity.PermissionKey[][];
  /** Keys the subject holds; everything else is denied. */
  held: Set<string>;
  ttlSeconds: number;
  fail: boolean;
}

/** Fake identity-roster: answers /authz/check from `held`, counting every call. */
function fakeIdentity(held: identity.PermissionKey[], ttlSeconds = TTL): FakeIdentity {
  const state: FakeIdentity = {
    calls: [],
    held: new Set<string>(held),
    ttlSeconds,
    fail: false,
    binding: undefined as unknown as Fetcher,
  };
  state.binding = {
    async fetch(req: Request): Promise<Response> {
      const body = (await req.json()) as identity.AuthzCheckRequest;
      state.calls.push(body.checks.map((q) => q.permission));
      if (state.fail) return new Response("boom", { status: 503 });
      const decisions: identity.AuthzDecision[] = body.checks.map((q) => ({
        allowed: state.held.has(q.permission),
        evaluatedAt: new Date(0).toISOString(),
        ttlSeconds: state.ttlSeconds,
      }));
      const res: identity.AuthzCheckResponse = { decisions };
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
  return state;
}

/** Controllable clock so TTL expiry is exercised without sleeping. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advanceSeconds: (s: number) => void (t += s * 1000) };
}

const ORG = "org_dub";

describe("createAuthzGranter — TTL cache (ADR 0004)", () => {
  it("asks identity once, then serves repeats from cache", async () => {
    const id = fakeIdentity([SAFE]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);

    expect(id.calls.length).toBe(1);
  });

  it("caches denials too, so a 403 does not re-ask identity every request", async () => {
    const id = fakeIdentity([]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    expect(await granter("usr_1", ORG, [SAFE])).toEqual([]);
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([]);

    expect(id.calls.length).toBe(1);
  });

  it("re-asks identity once the server-specified TTL has elapsed", async () => {
    const c = clock();
    const id = fakeIdentity([SAFE], 60);
    const granter = createAuthzGranter(id.binding, {
      caller: "t",
      cacheOptions: { now: c.now },
    });

    await granter("usr_1", ORG, [SAFE]);
    c.advanceSeconds(59);
    await granter("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(1); // still inside the window

    c.advanceSeconds(2); // 61s > ttlSeconds
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
    expect(id.calls.length).toBe(2);
  });

  it("honours the TTL identity returns rather than a hardcoded one", async () => {
    const c = clock();
    const id = fakeIdentity([SAFE], 5); // identity says 5s, not 60
    const granter = createAuthzGranter(id.binding, {
      caller: "t",
      cacheOptions: { now: c.now },
    });

    await granter("usr_1", ORG, [SAFE]);
    c.advanceSeconds(6);
    await granter("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(2);
  });

  it("clamps an absurd upstream TTL so revocation lag stays bounded", async () => {
    const c = clock();
    const id = fakeIdentity([SAFE], 86_400); // a day — must not be honoured
    const granter = createAuthzGranter(id.binding, {
      caller: "t",
      cacheOptions: { now: c.now, maxTtlSeconds: 300 },
    });

    await granter("usr_1", ORG, [SAFE]);
    c.advanceSeconds(301);
    await granter("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(2);
  });

  it("does not cache a TTL of 0 (identity opting out)", async () => {
    const id = fakeIdentity([SAFE], 0);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    await granter("usr_1", ORG, [SAFE]);
    await granter("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(2);
  });
});

describe("dangerous keys always bypass the cache", () => {
  it("the catalog really marks the key under test dangerous", () => {
    expect(isDangerousPermission(DANGEROUS)).toBe(true);
    expect(isDangerousPermission(SAFE)).toBe(false);
    // The set is derived from the catalog, not a copy that can drift.
    expect(DANGEROUS_PERMISSION_KEYS.has("identity:admin")).toBe(true);
    expect(DANGEROUS_PERMISSION_KEYS.has("mail:send")).toBe(true);
  });

  it("re-asks identity on every request for a dangerous key", async () => {
    const id = fakeIdentity([DANGEROUS]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    for (let i = 0; i < 4; i++) {
      expect(await granter("usr_1", ORG, [DANGEROUS])).toEqual([DANGEROUS]);
    }
    expect(id.calls.length).toBe(4);
  });

  it("a revoked dangerous key is denied on the very next request", async () => {
    const id = fakeIdentity([DANGEROUS, SAFE]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    expect(await granter("usr_1", ORG, [DANGEROUS])).toEqual([DANGEROUS]);
    id.held.delete(DANGEROUS);
    expect(await granter("usr_1", ORG, [DANGEROUS])).toEqual([]);
  });

  it("mixing a dangerous key with cached safe ones still costs exactly one call", async () => {
    const id = fakeIdentity([SAFE, "task:write", DANGEROUS]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    await granter("usr_1", ORG, [SAFE, "task:write"]);
    expect(id.calls.length).toBe(1);

    const held = await granter("usr_1", ORG, [SAFE, DANGEROUS, "task:write"]);
    expect(held).toEqual([SAFE, DANGEROUS, "task:write"]); // request order preserved
    expect(id.calls.length).toBe(2);
    expect(id.calls[1]).toEqual([DANGEROUS]); // only the bypassed key went on the wire
  });
});

describe("batching is not multiplied by the cache", () => {
  it("a partially cached rule sends ONE call containing only the misses", async () => {
    const id = fakeIdentity([SAFE, "task:write", "file:read"]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    await granter("usr_1", ORG, [SAFE]);
    expect(id.calls).toEqual([[SAFE]]);

    const held = await granter("usr_1", ORG, [SAFE, "task:write", "file:read"]);
    expect(held).toEqual([SAFE, "task:write", "file:read"]);
    expect(id.calls.length).toBe(2);
    expect(id.calls[1]).toEqual(["task:write", "file:read"]);
  });

  it("a fully cached rule sends no call at all", async () => {
    const id = fakeIdentity([SAFE, "task:write"]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    await granter("usr_1", ORG, [SAFE, "task:write"]);
    expect(id.calls.length).toBe(1);
    await granter("usr_1", ORG, [SAFE, "task:write"]);
    expect(id.calls.length).toBe(1);
  });

  it("still splits at identity's 20-check cap, and only for uncached keys", async () => {
    const keys = DOMAIN_KEYS.slice(0, 25);
    const id = fakeIdentity(keys);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    await granter("usr_1", ORG, keys);
    expect(id.calls.map((c) => c.length)).toEqual([20, 5]);
    // Dangerous keys among them are never cached, so the second pass asks about exactly those.
    const dangerous = keys.filter((k) => isDangerousPermission(k));
    id.calls.length = 0;
    await granter("usr_1", ORG, keys);
    expect(id.calls).toEqual(dangerous.length > 0 ? [dangerous] : []);
  });

  it("returns [] without touching identity for an empty key list", async () => {
    const id = fakeIdentity([]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });
    expect(await granter("usr_1", ORG, [])).toEqual([]);
    expect(id.calls.length).toBe(0);
  });
});

describe("no cross-subject contamination", () => {
  it("never answers one user from another user's decision", async () => {
    const id = fakeIdentity([SAFE]);
    id.held = new Set([SAFE]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    // usr_1 holds task:read; usr_2 does not.
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
    id.held = new Set(); // identity now denies — the answer for usr_2 must come from it
    expect(await granter("usr_2", ORG, [SAFE])).toEqual([]);
    expect(id.calls.length).toBe(2);
    // usr_1 keeps its own cached allow; the two entries are independent.
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
    expect(await granter("usr_2", ORG, [SAFE])).toEqual([]);
    expect(id.calls.length).toBe(2);
  });

  it("never answers one org from another org's decision", async () => {
    const id = fakeIdentity([SAFE]);
    const granter = createAuthzGranter(id.binding, { caller: "t" });

    expect(await granter("usr_1", "org_a", [SAFE])).toEqual([SAFE]);
    id.held = new Set();
    expect(await granter("usr_1", "org_b", [SAFE])).toEqual([]);
    expect(id.calls.length).toBe(2);
  });

  it("ids containing the key separator cannot be made to collide", async () => {
    const cache = createAuthzCache();
    // ("a", "b|c") vs ("a|b", "c"): a naive `${u}|${o}|${p}` key would merge these.
    cache.set("a", "b|c", SAFE, true, TTL);
    expect(cache.get("a|b", "c", SAFE)).toBeUndefined();
    cache.set("a|b", "c", SAFE, false, TTL);
    expect(cache.get("a", "b|c", SAFE)).toBe(true);
    expect(cache.get("a|b", "c", SAFE)).toBe(false);
  });
});

describe("bounded memory", () => {
  it("evicts the least-recently-used entry past maxEntries", async () => {
    const id = fakeIdentity(DOMAIN_KEYS);
    const granter = createAuthzGranter(id.binding, {
      caller: "t",
      cacheOptions: { maxEntries: 2 },
    });

    await granter("usr_1", ORG, [SAFE]); // cache: [task:read]
    await granter("usr_2", ORG, [SAFE]); // cache: [task:read(u1), task:read(u2)]
    expect(id.calls.length).toBe(2);
    await granter("usr_1", ORG, [SAFE]); // hit -> usr_1 becomes most recent
    expect(id.calls.length).toBe(2);

    await granter("usr_3", ORG, [SAFE]); // evicts the LRU entry, usr_2
    expect(id.calls.length).toBe(3);
    await granter("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(3); // usr_1 survived
    await granter("usr_2", ORG, [SAFE]);
    expect(id.calls.length).toBe(4); // usr_2 was dropped
  });

  it("keeps the entry count at the cap under many distinct subjects", () => {
    const cache = createAuthzCache({ maxEntries: 50 });
    for (let i = 0; i < 500; i++) cache.set(`usr_${i}`, ORG, SAFE, true, TTL);
    expect(cache.size).toBe(50);
  });

  it("maxEntries 0 disables caching entirely", async () => {
    const id = fakeIdentity([SAFE]);
    const granter = createAuthzGranter(id.binding, {
      caller: "t",
      cacheOptions: { maxEntries: 0 },
    });
    await granter("usr_1", ORG, [SAFE]);
    await granter("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(2);
  });
});

describe("fail-closed is preserved", () => {
  it("throws when identity is unreachable instead of allowing", async () => {
    const id = fakeIdentity([SAFE]);
    id.fail = true;
    const granter = createAuthzGranter(id.binding, { caller: "t" });
    await expect(granter("usr_1", ORG, [SAFE])).rejects.toThrow();
  });

  it("caches nothing from a failed call — recovery is a real decision", async () => {
    const id = fakeIdentity([SAFE]);
    id.fail = true;
    const granter = createAuthzGranter(id.binding, { caller: "t" });
    await expect(granter("usr_1", ORG, [SAFE])).rejects.toThrow();
    id.fail = false;
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
  });

  it("an expired entry is never served, even while identity is down", async () => {
    const c = clock();
    const id = fakeIdentity([SAFE], 60);
    const granter = createAuthzGranter(id.binding, {
      caller: "t",
      cacheOptions: { now: c.now },
    });
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
    c.advanceSeconds(61);
    id.fail = true;
    await expect(granter("usr_1", ORG, [SAFE])).rejects.toThrow();
  });

  it("a short decisions array denies the unanswered keys", async () => {
    const binding = {
      async fetch(): Promise<Response> {
        const res: identity.AuthzCheckResponse = { decisions: [] };
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    } as unknown as Fetcher;
    const granter = createAuthzGranter(binding, { caller: "t" });
    expect(await granter("usr_1", ORG, [SAFE])).toEqual([]);
  });
});

describe("sharedAuthzGranter — cache survives across requests in one isolate", () => {
  it("reuses the cache for granters rebuilt per request with the same env", async () => {
    const env = { SVC_IDENTITY: {} };
    const id = fakeIdentity([SAFE]);

    // Three "requests", each building its own granter with its own requestId.
    for (const requestId of ["req_1", "req_2", "req_3"]) {
      const granter = sharedAuthzGranter(env, id.binding, { caller: "t", requestId });
      expect(await granter("usr_1", ORG, [SAFE])).toEqual([SAFE]);
    }
    expect(id.calls.length).toBe(1);
  });

  it("per-request createAuthzGranter would NOT (the regression this closes)", async () => {
    const id = fakeIdentity([SAFE]);
    for (const requestId of ["req_1", "req_2", "req_3"]) {
      const granter = createAuthzGranter(id.binding, { caller: "t", requestId });
      await granter("usr_1", ORG, [SAFE]);
    }
    expect(id.calls.length).toBe(3);
  });

  it("does not share a cache between different envs", async () => {
    const id = fakeIdentity([SAFE]);
    const a = sharedAuthzGranter({ name: "a" }, id.binding, { caller: "t" });
    const b = sharedAuthzGranter({ name: "b" }, id.binding, { caller: "t" });
    await a("usr_1", ORG, [SAFE]);
    await b("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(2);
  });

  it("an explicit cache wins over the per-env one", async () => {
    const env = {};
    const id = fakeIdentity([SAFE]);
    const cache = createAuthzCache();
    const g1 = sharedAuthzGranter(env, id.binding, { caller: "t", cache });
    const g2 = sharedAuthzGranter(env, id.binding, { caller: "t", cache });
    await g1("usr_1", ORG, [SAFE]);
    await g2("usr_1", ORG, [SAFE]);
    expect(id.calls.length).toBe(1);
  });
});

/** 25+ real catalog keys, for the batch-cap test. */
const DOMAIN_KEYS: identity.PermissionKey[] = [
  "identity:read",
  "identity:admin",
  "event:read",
  "event:write",
  "event:admin",
  "task:read",
  "task:write",
  "task:delete",
  "file:read",
  "file:write",
  "file:admin",
  "notif:send",
  "notif:admin",
  "notif:inbox:self",
  "notif:prefs:self",
  "mail:send",
  "mail:read",
  "mail:read_all",
  "mail:admin",
  "chat:create",
  "chat:moderate",
  "usage:view",
  "infra:read",
  "infra:deploy",
  "infra:dns",
  "infra:admin",
  "audit:read",
];
