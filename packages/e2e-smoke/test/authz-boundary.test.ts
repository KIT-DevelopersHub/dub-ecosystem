// Authorization boundaries ACROSS services, decided by the real identity-roster.
//
// identity-roster / member-service both mount @dub/policy-gate
// (POLICY_TABLE) — this suite was written against that state, it does not add the layer.
// Unlike smoke.test.ts (allow-all granter), every request here goes:
//   service policyGate -> createAuthzGranter -> identity POST /authz/check -> RBAC over D1
// and every call is made DIRECTLY on the service app, with no api-gateway in front, so a
// pass proves the service itself enforces the boundary rather than relying on the edge.
//
// A deny is asserted on three axes: the status (403, never confused with 401), the error
// code, and that the body carries not one byte of org_other's data.
import { describe, it, expect, beforeEach } from "vitest";

import {
  call,
  createAuthzWorld,
  OTHER_ORG,
  OTHER_ORG_SECRETS,
  PRINCIPALS,
  type AuthzWorld,
  type CallResult,
} from "../src/world";

let w: AuthzWorld;
beforeEach(async () => {
  w = await createAuthzWorld();
});

/** No org_other value may appear in the body: the planted rows, the other org's user id
 *  and its role ids (role NAMES are identical across orgs, so ids are what tell them
 *  apart). `sent` lists ids the CALLER put in the request: a 404 that echoes back the id
 *  you asked for discloses nothing new. */
function expectNoLeak(r: CallResult, sent: string[] = []): void {
  const otherRoleIds = (w.raw.prepare("SELECT id FROM identity_roles WHERE org_id = ?").all(OTHER_ORG) as { id: string }[])
    .map((x) => x.id);
  for (const secret of [...Object.values(OTHER_ORG_SECRETS), PRINCIPALS.otherAdmin, ...otherRoleIds]) {
    if (sent.includes(secret)) continue;
    expect(r.text, `response leaked org_other value "${secret}"`).not.toContain(secret);
  }
}

function expectForbidden(r: CallResult, label = ""): void {
  expect(r.status, `${label} ${r.text}`).toBe(403);
  expect(r.json.error.code).toBe("FORBIDDEN");
  expectNoLeak(r);
}

describe("member-service: org boundary through the real identity decision", () => {
  it("own org: admin creates and lists teams (200), the list carries no org_other team", async () => {
    const made = await call(w.memberApp, "POST", "/members/teams", { userId: PRINCIPALS.admin, body: { name: "広報" } });
    expect(made.status, made.text).toBe(201);

    const list = await call(w.memberApp, "GET", "/members/teams", { userId: PRINCIPALS.admin });
    expect(list.status).toBe(200);
    expect(list.text).toContain("広報");
    expectNoLeak(list);

    const overview = await call(w.memberApp, "GET", "/members/overview", { userId: PRINCIPALS.admin });
    expect(overview.status).toBe(200);
    expectNoLeak(overview);
  });

  it("other org's ids: a team id is 404 and a linked identity resolves to nothing", async () => {
    const patch = await call(w.memberApp, "PATCH", `/members/teams/${OTHER_ORG_SECRETS.teamId}`, {
      userId: PRINCIPALS.admin,
      body: { name: "hijack" },
    });
    expect(patch.status, patch.text).toBe(404);
    expectNoLeak(patch, [OTHER_ORG_SECRETS.teamId]);
    // the row really is untouched
    const row = w.raw.prepare("SELECT name FROM member_teams WHERE id = ?").get(OTHER_ORG_SECRETS.teamId) as { name: string };
    expect(row.name).toBe(OTHER_ORG_SECRETS.teamName);

    const byIdentity = await call(w.memberApp, "GET", `/members/people/by-identity/${PRINCIPALS.otherAdmin}`, {
      userId: PRINCIPALS.admin,
    });
    expect(byIdentity.status).toBe(200);
    expect(byIdentity.json).toEqual({ member: null });
    expectNoLeak(byIdentity, [PRINCIPALS.otherAdmin]);
  });

  // The repo lookups by id are NOT org-scoped; isolation rests on member-service's own
  // orgId checks, so every write path on another org's id is pinned here.
  it("other org's ids: writes are 404 and leave the rows untouched", async () => {
    const { teamId, personId } = OTHER_ORG_SECRETS;
    const writes: Array<[string, string, unknown?]> = [
      ["PATCH", `/members/people/${personId}`, { version: 1, name: "hijack" }],
      ["DELETE", `/members/people/${personId}`],
      ["DELETE", `/members/teams/${teamId}`],
    ];
    for (const [method, path, body] of writes) {
      const r = await call(w.memberApp, method, path, { userId: PRINCIPALS.admin, body });
      expect(r.status, `${method} ${path}: ${r.text}`).toBe(404);
      expectNoLeak(r, [teamId, personId]);
    }
    const person = w.raw.prepare("SELECT name, archived_at FROM member_people WHERE id = ?").get(personId) as any;
    expect(person).toEqual({ name: OTHER_ORG_SECRETS.personName, archived_at: null });
    expect(w.raw.prepare("SELECT id FROM member_teams WHERE id = ?").get(teamId)).toBeTruthy();
  });

  it("other org's admin is 403 here — its admin role does not cross orgs", async () => {
    const r = await call(w.memberApp, "GET", "/members/teams", { userId: PRINCIPALS.otherAdmin });
    expectForbidden(r);
    expect(w.identityCalls).toContain("POST /authz/check"); // decided by identity, not locally
  });

  it("signed in but key-less is 403, not 401; no header at all is 401", async () => {
    expectForbidden(await call(w.memberApp, "GET", "/members/teams", { userId: PRINCIPALS.noKeys }));
    const anon = await call(w.memberApp, "GET", "/members/teams");
    expect(anon.status).toBe(401);
    expect(anon.json.error.code).toBe("UNAUTHENTICATED");
  });

  it("a role with view but not edit cannot write", async () => {
    expectForbidden(
      await call(w.memberApp, "POST", "/members/teams", { userId: PRINCIPALS.member, body: { name: "x" } }),
    );
  });

  it("a forged x-dub-internal marker buys no key on a key-gated route", async () => {
    expectForbidden(await call(w.memberApp, "GET", "/members/teams", { userId: PRINCIPALS.noKeys, internal: true }));
  });
});

describe("identity-roster: org boundary on its own routes", () => {
  it("own org id is 200; other org's user id is 404 with no data", async () => {
    const own = await call(w.identityApp, "GET", `/identity/users/${PRINCIPALS.member}`, { userId: PRINCIPALS.admin });
    expect(own.status, own.text).toBe(200);
    expect(own.json.id).toBe(PRINCIPALS.member);

    const other = await call(w.identityApp, "GET", `/identity/users/${PRINCIPALS.otherAdmin}`, {
      userId: PRINCIPALS.admin,
    });
    expect(other.status, other.text).toBe(404);
    expectNoLeak(other, [PRINCIPALS.otherAdmin]);

    const roles = await call(w.identityApp, "GET", `/identity/users/${PRINCIPALS.otherAdmin}/roles`, {
      userId: PRINCIPALS.admin,
    });
    expect(roles.status, roles.text).toBe(404);
    expectNoLeak(roles, [PRINCIPALS.otherAdmin]);
  });

  it("roster list is org-scoped", async () => {
    const r = await call(w.identityApp, "GET", "/identity/users", { userId: PRINCIPALS.admin, query: { limit: "100" } });
    expect(r.status).toBe(200);
    expect(r.text).toContain(PRINCIPALS.member);
    expectNoLeak(r);
  });

  it("key-less user and other org's admin are 403 on the roster", async () => {
    expectForbidden(await call(w.identityApp, "GET", "/identity/users", { userId: PRINCIPALS.noKeys }));
    expectForbidden(await call(w.identityApp, "GET", "/identity/users", { userId: PRINCIPALS.otherAdmin }));
    // self-exception route: someone else's detail still needs identity:read
    expectForbidden(
      await call(w.identityApp, "GET", `/identity/users/${PRINCIPALS.member}`, { userId: PRINCIPALS.noKeys }),
    );
  });
});
