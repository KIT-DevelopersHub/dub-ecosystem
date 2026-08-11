import { describe, it, expect, vi, afterEach } from "vitest";
import { rosterAddressesFromRules, type CfRoutingRule } from "../src/email-routing";
import { createApp } from "../src/app";
import { makeEnv, fakeIdentityFetcher } from "./helpers";
import type { Env } from "../src/env";

// A CF Email Routing rule that receives at `${localPart}@developershub.jp` and forwards
// to `dest` (the account-scoped verified destination). This is what the user issues
// when they "create an address" — one rule per receiving address.
function rule(localPart: string, dest: string | null, enabled = true, over: Partial<CfRoutingRule> = {}): CfRoutingRule {
  return {
    id: `rule_${localPart}`,
    name: `${localPart} → ${dest ?? "(none)"}`,
    enabled,
    priority: 0,
    matchers: [{ type: "literal", field: "to", value: `${localPart}@developershub.jp` }],
    actions: dest ? [{ type: "forward", value: [dest] }] : [{ type: "drop" }],
    ...over,
  };
}

describe("rosterAddressesFromRules", () => {
  it("extracts one roster address per receiving rule (the reported bug: 10+ rules, not 1)", () => {
    const rules = ["account", "info", "support", "noreply", "team", "dev", "ops", "hr", "sales", "billing", "press", "legal"].map(
      (lp) => rule(lp, "staff@gmail.com"),
    );
    const out = rosterAddressesFromRules(rules, "developershub.jp");
    expect(out).toHaveLength(12);
    expect(out.map((a) => a.address)).toContain("account@developershub.jp");
    expect(out.every((a) => a.destination === "staff@gmail.com" && a.enabled)).toBe(true);
  });

  it("carries the first forward target as the destination, null for worker/drop rules", () => {
    const out = rosterAddressesFromRules(
      [rule("info", "a@gmail.com"), rule("void", null)],
      "developershub.jp",
    );
    expect(out.find((a) => a.address === "info@developershub.jp")!.destination).toBe("a@gmail.com");
    expect(out.find((a) => a.address === "void@developershub.jp")!.destination).toBeNull();
  });

  it("carries the rule's enabled flag through (paused rule → disabled roster row)", () => {
    const out = rosterAddressesFromRules([rule("paused", "x@gmail.com", false)], "developershub.jp");
    expect(out).toEqual([{ address: "paused@developershub.jp", destination: "x@gmail.com", enabled: false }]);
  });

  it("ignores catch-all rules and matchers outside the zone", () => {
    const catchAll: CfRoutingRule = {
      id: "rule_all", name: "catch-all", enabled: true, priority: 0,
      matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["x@gmail.com"] }],
    };
    const foreign = rule("info", "x@gmail.com", true, {
      matchers: [{ type: "literal", field: "to", value: "info@other-domain.com" }],
    });
    expect(rosterAddressesFromRules([catchAll, foreign], "developershub.jp")).toEqual([]);
  });

  it("de-dupes by address; a later ENABLED rule upgrades an earlier disabled duplicate", () => {
    const out = rosterAddressesFromRules(
      [rule("dup", "a@gmail.com", false), rule("dup", "b@gmail.com", true)],
      "developershub.jp",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: "dup@developershub.jp", enabled: true });
  });

  it("normalizes case and whitespace; matches the zone case-insensitively", () => {
    const r = rule("Mixed", "x@gmail.com", true, {
      matchers: [{ type: "literal", field: "to", value: "  Mixed@DevelopersHub.JP  " }],
    });
    const out = rosterAddressesFromRules([r], "DevelopersHub.jp");
    expect(out).toEqual([{ address: "mixed@developershub.jp", destination: "x@gmail.com", enabled: true }]);
  });

  it("is idempotent on the same rule set (stable output)", () => {
    const rules = [rule("a", "x@gmail.com"), rule("b", "y@gmail.com")];
    expect(rosterAddressesFromRules(rules, "developershub.jp")).toEqual(
      rosterAddressesFromRules(rules, "developershub.jp"),
    );
  });

  it("handles an empty / rule-less domain without throwing", () => {
    expect(rosterAddressesFromRules([], "developershub.jp")).toEqual([]);
  });
});

// --------------------------------------------------------------- route wiring
function adminHeaders(over: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-dub-request-id": "req_er", "x-dub-user-id": "usr_admin", ...over };
}
function wiredEnv(over: Partial<Env> = {}) {
  return makeEnv({
    CF_EMAIL_ROUTING_TOKEN: "cf-secret",
    CF_EMAIL_ROUTING_ZONE_ID: "zone_1",
    CF_EMAIL_ROUTING_ACCOUNT_ID: "acc_1",
    ...over,
  } as Partial<Env>);
}
function stubCf(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => handler(url, init)));
}
function ok(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
}

const app = createApp();
afterEach(() => vi.unstubAllGlobals());

describe("GET /admin/email-routing/roster-addresses", () => {
  it("reads the ZONE rules endpoint (not the account addresses) and returns every receiving address", async () => {
    const calls: string[] = [];
    stubCf((url) => {
      calls.push(url);
      return ok([rule("account", "staff@gmail.com"), rule("info", "staff@gmail.com"), rule("noreply", "staff@gmail.com", false)]);
    });
    const { env } = wiredEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/roster-addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ address: string; enabled: boolean }> };
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i) => i.address)).toEqual([
      "account@developershub.jp",
      "info@developershub.jp",
      "noreply@developershub.jp",
    ]);
    // proves the fix: the source is the zone RULES list, not /accounts/.../addresses.
    expect(calls[0]).toContain("/zones/zone_1/email/routing/rules");
    expect(calls[0]).not.toContain("/routing/addresses");
  });

  it("403 when mail:admin is denied", async () => {
    const { env } = wiredEnv({ SVC_IDENTITY: fakeIdentityFetcher(false) });
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/roster-addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(403);
  });

  it("503 MAIL_EMAIL_ROUTING_UNCONFIGURED when the token secret is absent", async () => {
    const { env } = makeEnv(); // no CF_* set
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/roster-addresses", { headers: adminHeaders() }), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_EMAIL_ROUTING_UNCONFIGURED");
  });
});
