import { describe, it, expect, vi } from "vitest";
import { isDubError } from "@dub/errors";
import {
  CfEmailRoutingClient,
  emailRoutingConfigFromEnv,
  emailRoutingConfigured,
  emailRoutingReadiness,
  requireEmailRoutingConfig,
  type EmailRoutingConfig,
} from "../src/email-routing";
import {
  parseCreateAddressRequest,
  parseCreateRuleRequest,
  parseUpdateRuleRequest,
} from "../src/email-routing-validation";
import type { Env } from "../src/env";

const asEnv = (o: Record<string, unknown>): Env => o as unknown as Env;

function okEnvelope(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function cfError(status: number, message: string) {
  return new Response(JSON.stringify({ success: false, errors: [{ code: 1003, message }], messages: [], result: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, over: Partial<EmailRoutingConfig> = {}): CfEmailRoutingClient {
  return new CfEmailRoutingClient({
    token: "cf-secret-token",
    accountId: "acc_1",
    zoneId: "zone_1",
    zoneName: "developershub.jp",
    workerName: "dub-mail-gateway",
    timeoutMs: 5000,
    fetchImpl,
    ...over,
  });
}

// ------------------------------------------------------------------ config
describe("emailRoutingConfigFromEnv", () => {
  it("returns null when the token secret is absent", () => {
    expect(emailRoutingConfigFromEnv(asEnv({}))).toBeNull();
    expect(emailRoutingConfigFromEnv(asEnv({ CF_EMAIL_ROUTING_TOKEN: "" }))).toBeNull();
    expect(emailRoutingConfigured(asEnv({}))).toBe(false);
  });
  it("builds config and defaults the zone name", () => {
    const cfg = emailRoutingConfigFromEnv(asEnv({ CF_EMAIL_ROUTING_TOKEN: "t", CF_EMAIL_ROUTING_ZONE_ID: "z", CF_EMAIL_ROUTING_ACCOUNT_ID: "a" }));
    expect(cfg).toMatchObject({ token: "t", zoneId: "z", accountId: "a", zoneName: "developershub.jp" });
  });
  it("readiness never echoes the token value", () => {
    const r = emailRoutingReadiness(asEnv({ CF_EMAIL_ROUTING_TOKEN: "SECRET-XYZ", CF_EMAIL_ROUTING_ZONE_ID: "z" }));
    expect(r).toEqual({ configured: true, zoneConfigured: true, accountConfigured: false, zoneName: "developershub.jp" });
    expect(JSON.stringify(r)).not.toContain("SECRET-XYZ");
  });
  it("requireEmailRoutingConfig throws 503 when unset", () => {
    try {
      requireEmailRoutingConfig(asEnv({}));
      expect.unreachable();
    } catch (e) {
      expect(isDubError(e) && e.code).toBe("MAIL_EMAIL_ROUTING_UNCONFIGURED");
      expect(isDubError(e) && e.status).toBe(503);
    }
  });
});

// ------------------------------------------------------------------ client happy path
describe("CfEmailRoutingClient", () => {
  it("lists destination addresses (account-scoped URL, Bearer token)", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/accounts/acc_1/email/routing/addresses");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer cf-secret-token");
      return okEnvelope([{ id: "d1", email: "a@x.com", verified: null, created: "", modified: "" }]);
    }) as unknown as typeof fetch;
    const out = await client(fetchMock).listAddresses();
    expect(out).toHaveLength(1);
    expect(out[0]!.email).toBe("a@x.com");
  });

  it("creates a destination address (POST body carries email)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ email: "new@x.com" });
      return okEnvelope({ id: "d2", email: "new@x.com", verified: null, created: "", modified: "" });
    }) as unknown as typeof fetch;
    const out = await client(fetchMock).createAddress("new@x.com");
    expect(out.id).toBe("d2");
  });

  it("creates a rule (zone-scoped URL)", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/zones/zone_1/email/routing/rules");
      expect(init.method).toBe("POST");
      return okEnvelope({ id: "r1", name: "n", enabled: true, priority: 0, matchers: [], actions: [] });
    }) as unknown as typeof fetch;
    const out = await client(fetchMock).createRule({ name: "n", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] });
    expect(out.id).toBe("r1");
  });

  it("deletes a rule (DELETE, id url-encoded)", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe("DELETE");
      expect(url).toContain("/rules/r%2F1");
      return okEnvelope({ id: "r/1", name: "n", enabled: false, priority: 0, matchers: [], actions: [] });
    }) as unknown as typeof fetch;
    await client(fetchMock).deleteRule("r/1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ------------------------------------------------------------------ client failures
describe("CfEmailRoutingClient failures", () => {
  it("maps a CF error envelope to 502 MAIL_EMAIL_ROUTING_UPSTREAM with CF message, no token", async () => {
    const fetchMock = vi.fn(async () => cfError(400, "invalid destination")) as unknown as typeof fetch;
    try {
      await client(fetchMock).createAddress("x@y.com");
      expect.unreachable();
    } catch (e) {
      expect(isDubError(e) && e.code).toBe("MAIL_EMAIL_ROUTING_UPSTREAM");
      expect(isDubError(e) && e.status).toBe(502);
      expect(isDubError(e) && e.message).toContain("invalid destination");
      expect(isDubError(e) && e.message).not.toContain("cf-secret-token");
    }
  });

  it("maps a network throw to a retryable 502", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    try {
      await client(fetchMock).listRules();
      expect.unreachable();
    } catch (e) {
      expect(isDubError(e) && e.code).toBe("MAIL_EMAIL_ROUTING_UPSTREAM");
      expect(isDubError(e) && e.retryable).toBe(true);
    }
  });

  it("503s when account id missing for address ops", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    try {
      await client(fetchMock, { accountId: undefined }).listAddresses();
      expect.unreachable();
    } catch (e) {
      expect(isDubError(e) && e.code).toBe("MAIL_EMAIL_ROUTING_UNCONFIGURED");
      expect(isDubError(e) && e.status).toBe(503);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503s when zone id missing for rule ops", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(client(fetchMock, { zoneId: undefined }).listRules()).rejects.toMatchObject({ code: "MAIL_EMAIL_ROUTING_UNCONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ validation
describe("parseCreateAddressRequest", () => {
  it("accepts a valid email", () => {
    expect(parseCreateAddressRequest({ email: "team@gmail.com" })).toEqual({ email: "team@gmail.com" });
  });
  it("rejects a malformed email / missing field", () => {
    expect(() => parseCreateAddressRequest({ email: "nope" })).toThrow();
    expect(() => parseCreateAddressRequest({})).toThrow();
    expect(() => parseCreateAddressRequest(null)).toThrow();
  });
});

describe("parseCreateRuleRequest (anti-spoof + naming)", () => {
  const zone = "developershub.jp";
  it("accepts a literal in-zone matcher forwarding to an external inbox", () => {
    const rule = parseCreateRuleRequest(
      { name: "sales", matchers: [{ type: "literal", field: "to", value: "sales@developershub.jp" }], actions: [{ type: "forward", value: ["me@gmail.com"] }] },
      zone,
    );
    expect(rule.enabled).toBe(true);
    expect(rule.matchers[0]).toEqual({ type: "literal", field: "to", value: "sales@developershub.jp" });
  });
  it("accepts a catch-all matcher", () => {
    const rule = parseCreateRuleRequest({ name: "all", matchers: [{ type: "all" }], actions: [{ type: "drop" }] }, zone);
    expect(rule.matchers[0]).toEqual({ type: "all" });
  });
  it("rejects a matcher outside the managed zone (anti-spoof)", () => {
    expect(() =>
      parseCreateRuleRequest({ name: "x", matchers: [{ type: "literal", field: "to", value: "ceo@othercorp.com" }], actions: [{ type: "drop" }] }, zone),
    ).toThrow(/managed zone/);
  });
  it("rejects an invalid local part", () => {
    expect(() =>
      parseCreateRuleRequest({ name: "x", matchers: [{ type: "literal", field: "to", value: "Bad Name@developershub.jp" }], actions: [{ type: "drop" }] }, zone),
    ).toThrow();
  });
  it("rejects a forward action with a bad target", () => {
    expect(() =>
      parseCreateRuleRequest({ name: "x", matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["not-an-email"] }] }, zone),
    ).toThrow();
  });
  it("requires name / matchers / actions", () => {
    expect(() => parseCreateRuleRequest({ matchers: [{ type: "all" }], actions: [{ type: "drop" }] }, zone)).toThrow();
    expect(() => parseCreateRuleRequest({ name: "x", matchers: [], actions: [{ type: "drop" }] }, zone)).toThrow();
    expect(() => parseCreateRuleRequest({ name: "x", matchers: [{ type: "all" }], actions: [] }, zone)).toThrow();
  });
});

describe("parseUpdateRuleRequest", () => {
  const zone = "developershub.jp";
  it("accepts a partial patch (enabled only)", () => {
    expect(parseUpdateRuleRequest({ enabled: false }, zone)).toEqual({ enabled: false });
  });
  it("rejects an empty patch", () => {
    expect(() => parseUpdateRuleRequest({}, zone)).toThrow(/at least one field/);
  });
  it("validates matchers when present", () => {
    expect(() => parseUpdateRuleRequest({ matchers: [{ type: "literal", field: "to", value: "x@other.com" }] }, zone)).toThrow();
  });
});
