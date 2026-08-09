import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { createAuthClient } from "@dub/auth-client";
import { createApp } from "../src/app";
import { makeDeps, inbound, type DepsBundle } from "./fakes";

// Fake identity Service Binding: /authz/check -> allow (or deny) uniformly.
function fakeIdentity(allowed: boolean): Fetcher {
  const f = {
    async fetch(_req: Request): Promise<Response> {
      const body = {
        decisions: [{ allowed, evaluatedAt: "2026-08-09T10:00:00.000Z", ttlSeconds: 60 }],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return f as unknown as Fetcher;
}

function makeAppBundle(allowed = true): { b: DepsBundle; app: ReturnType<typeof createApp> } {
  const b = makeDeps();
  const authClient = createAuthClient({ identityBinding: fakeIdentity(allowed), serviceName: "mail-automation" });
  const app = createApp({ pipeline: b.deps, authClient });
  return { b, app };
}

const H = {
  "x-dub-request-id": "req_http_1",
  "x-dub-user-id": "user_admin",
  "x-dub-internal": "1",
  "content-type": "application/json",
};

describe("internal-only guard", () => {
  it("missing x-dub-internal => 404", async () => {
    const { app } = makeAppBundle();
    const res = await app.request("/settings", { headers: { "x-dub-request-id": "r", "x-dub-user-id": "u" } });
    expect(res.status).toBe(404);
  });

  it("missing x-dub-request-id => 400", async () => {
    const { app } = makeAppBundle();
    const res = await app.request("/settings", { headers: { "x-dub-user-id": "u", "x-dub-internal": "1" } });
    expect(res.status).toBe(400);
  });
});

describe("authz", () => {
  it("denied permission => 403", async () => {
    const { app } = makeAppBundle(false);
    const res = await app.request("/settings", { headers: H });
    expect(res.status).toBe(403);
  });
});

describe("rules + templates CRUD", () => {
  it("create template, create rule, list", async () => {
    const { app } = makeAppBundle();
    const tplRes = await app.request("/templates", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "ack", subject: "Re", body: "Hi {{sender_name}}" }),
    });
    expect(tplRes.status).toBe(201);
    const tpl = (await tplRes.json()) as { id: string };

    const ruleRes = await app.request("/rules", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "r1",
        enabled: true,
        conditions: [{ field: "from", op: "domain_is", value: "acme.io" }],
        action: { type: "reply", templateId: tpl.id },
      }),
    });
    expect(ruleRes.status).toBe(201);

    const listRes = await app.request("/rules", { headers: H });
    const list = (await listRes.json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
  });

  it("reply rule referencing missing template => 422", async () => {
    const { app } = makeAppBundle();
    const res = await app.request("/rules", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "bad",
        conditions: [{ field: "from", op: "domain_is", value: "acme.io" }],
        action: { type: "reply", templateId: "nope" },
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAILAUTO_RULE_REFERENCES_MISSING_TEMPLATE");
  });

  it("invalid regex condition => 400 MAILAUTO_INVALID_RULE", async () => {
    const { app } = makeAppBundle();
    const res = await app.request("/rules", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: "r", conditions: [{ field: "subject", op: "regex", value: "(" }], action: { type: "ignore" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("settings + dry-run + process", () => {
  it("kill switch flip then process replies", async () => {
    const { b, app } = makeAppBundle();
    // seed template + rule directly
    const tpl = await b.repo.createTemplate({ name: "ack", subject: "Re: {{subject}}", body: "Hi {{sender_name}}" });
    await b.repo.createRule(
      {
        name: "r",
        enabled: true,
        priority: 1,
        conditions: [{ field: "from", op: "domain_is", value: "acme.io" }],
        action: { type: "reply", templateId: tpl.id },
      },
      "u",
    );

    const mail = inbound({ id: "http1", from: { email: "a@acme.io" }, subject: "Q" });

    // dry-run works while disabled -> suppressed_disabled (kill switch)
    const dry = await app.request("/dry-run", { method: "POST", headers: H, body: JSON.stringify({ mail }) });
    expect(dry.status).toBe(200);

    // enable
    const patch = await app.request("/settings", { method: "PATCH", headers: H, body: JSON.stringify({ automationEnabled: true }) });
    expect(patch.status).toBe(200);

    const proc = await app.request("/process", { method: "POST", headers: H, body: JSON.stringify({ mail }) });
    expect(proc.status).toBe(200);
    const out = (await proc.json()) as { outcome: string };
    expect(out.outcome).toBe("replied");
    expect(b.gateway.sends).toHaveLength(1);

    const decisions = await app.request("/decisions?messageId=http1", { headers: H });
    const dj = (await decisions.json()) as { items: unknown[] };
    expect(dj.items).toHaveLength(1);
  });
});
