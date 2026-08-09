// S6 RBAC negative-path E2E + authn boundaries. All decisions are made by the
// REAL identity-roster evaluate() over seeded roles; the gateway enforces authn.
import { describe, it, expect } from "vitest";
import { createHarness } from "../lib/harness";
import type { ErrorResponse } from "@dub/errors";

function errOf(raw: unknown): ErrorResponse["error"] {
  return (raw as ErrorResponse).error;
}

describe("S6 org boundary: outsider (active but non-member of devhub) is denied", () => {
  it("outsider reading org resources gets 403 FORBIDDEN in ErrorResponse form", async () => {
    const h = await createHarness();
    const outsider = await h.login("outsider");
    const res = await h.gw("GET", "/api/v1/events", { token: outsider });
    expect(res.status).toBe(403);
    expect(errOf(res.raw).code).toBe("FORBIDDEN");
  });

  it("outsider cannot create events", async () => {
    const h = await createHarness();
    const outsider = await h.login("outsider");
    const res = await h.gw("POST", "/api/v1/events", { token: outsider, body: { title: "x" } });
    expect(res.status).toBe(403);
  });
});

describe("S6 role boundary: member lacks organizer/admin permissions", () => {
  it("member cannot create events (needs event:write)", async () => {
    const h = await createHarness();
    const member = await h.login("member");
    const res = await h.gw("POST", "/api/v1/events", { token: member, body: { title: "x" } });
    expect(res.status).toBe(403);
    expect(errOf(res.raw).code).toBe("FORBIDDEN");
  });

  it("member cannot read the audit log (needs audit:read)", async () => {
    const h = await createHarness();
    const member = await h.login("member");
    const res = await h.gw("GET", "/api/v1/audit/logs", { token: member });
    expect(res.status).toBe(403);
  });

  it("member CAN read events (event:read is granted)", async () => {
    const h = await createHarness();
    const member = await h.login("member");
    const res = await h.gw("GET", "/api/v1/events", { token: member });
    expect(res.status).toBe(200);
  });
});

describe("authn boundary at the gateway edge", () => {
  it("no token -> 401 UNAUTHENTICATED", async () => {
    const h = await createHarness();
    const res = await h.gw("GET", "/api/v1/events");
    expect(res.status).toBe(401);
    expect(errOf(res.raw).code).toBe("UNAUTHENTICATED");
  });

  it("garbage bearer -> 401 (auth verify rejects)", async () => {
    const h = await createHarness();
    const res = await h.gw("GET", "/api/v1/events", { token: "not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("internal-only identity paths are 404 at the public edge (double-defence)", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    // /identity/authz/check is internal-only; the gateway 404s it before proxying.
    const res = await h.gw("POST", "/api/v1/identity/authz/check", {
      token: admin,
      body: { subjectUserId: h.users.admin.userId, orgId: h.users.admin.orgId, checks: [{ permission: "event:read" }] },
    });
    expect(res.status).toBe(404);
  });
});
