// POST /identity/users/sync-email-routing — reconcile the roster with the Cloudflare
// Email Routing @developershub.jp addresses (relayed by the caller who holds mail:admin).
import { describe, it, expect } from "vitest";
import { makeHarness, asUser, jsonBody, ORG_ID } from "./harness";
import type { Harness } from "./harness";

const DOMAIN = "developershub.jp";
const addr = (localPart: string, enabled = true) => ({ address: `${localPart}@${DOMAIN}`, destination: "fwd@example.com", enabled });

async function sync(h: Harness, userId: string, addresses: unknown[]) {
  return h.app.request(
    "/identity/users/sync-email-routing",
    jsonBody(asUser(userId), "POST", { addresses }),
  );
}

describe("sync-email-routing", () => {
  it("requires identity:admin (member is forbidden)", async () => {
    const h = await makeHarness();
    const res = await sync(h, h.memberId, [addr("account")]);
    expect(res.status).toBe(403);
  });

  it("adds Email Routing addresses as active roster users (source=email-routing)", async () => {
    const h = await makeHarness();
    const res = await sync(h, h.adminId, [addr("account"), addr("takataro")]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: number; updated: number; deactivated: number; total: number };
    expect(body).toEqual({ added: 2, updated: 0, deactivated: 0, total: 2 });

    const account = await h.repo.getUserByEmail(ORG_ID, `account@${DOMAIN}`);
    expect(account).toMatchObject({ source: "email-routing", status: "active", displayName: "account" });
  });

  it("surfaces source on the roster list wire model", async () => {
    const h = await makeHarness();
    await sync(h, h.adminId, [addr("account")]);
    const list = await h.app.request("/identity/users?status=active", asUser(h.adminId));
    const body = (await list.json()) as { items: Array<{ email: string; source?: string }> };
    const row = body.items.find((u) => u.email === `account@${DOMAIN}`);
    expect(row?.source).toBe("email-routing");
  });

  it("marks a pre-existing manual user as source=email-routing without duplicating", async () => {
    const h = await makeHarness();
    // admin@devhub.jp already exists (manual). Re-key the sync onto that same email.
    const res = await sync(h, h.adminId, [{ address: "admin@devhub.jp", enabled: true }]);
    const body = (await res.json()) as { added: number; updated: number };
    expect(body).toMatchObject({ added: 0, updated: 1 });
    const admin = await h.repo.getUser(h.adminId);
    expect(admin?.source).toBe("email-routing");
    // no duplicate row created for the same email
    const dup = await h.app.request("/identity/users?q=admin@devhub.jp", asUser(h.adminId));
    const dupBody = (await dup.json()) as { items: unknown[] };
    expect(dupBody.items).toHaveLength(1);
  });

  it("logically DISABLES a synced address that disappeared, then reactivates on re-appearance (no hard delete, roles preserved)", async () => {
    const h = await makeHarness();
    await sync(h, h.adminId, [addr("account")]);
    const created = (await h.repo.getUserByEmail(ORG_ID, `account@${DOMAIN}`))!;
    // grant a role so we can prove it survives deactivation.
    await h.app.request(`/identity/users/${created.id}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: h.memberRoleId }));

    // next sync omits account@ -> deactivated
    const gone = await sync(h, h.adminId, [addr("takataro")]);
    expect((await gone.json())).toMatchObject({ added: 1, deactivated: 1 });
    const afterGone = (await h.repo.getUser(created.id))!;
    expect(afterGone.status).toBe("disabled");
    const roles = await h.repo.listAssignmentsByUser(created.id, ORG_ID);
    expect(roles).toHaveLength(1); // role survived (data保全)

    // account@ re-appears -> reactivated to active
    const back = await sync(h, h.adminId, [addr("account"), addr("takataro")]);
    expect((await back.json())).toMatchObject({ updated: expect.any(Number) });
    expect((await h.repo.getUser(created.id))!.status).toBe("active");
  });

  it("lands a disabled Email Routing rule as a disabled roster row", async () => {
    const h = await makeHarness();
    await sync(h, h.adminId, [addr("paused", false)]);
    const user = await h.repo.getUserByEmail(ORG_ID, `paused@${DOMAIN}`);
    expect(user?.status).toBe("disabled");
  });

  it("rejects an invalid address with 400 and writes nothing (atomic validation)", async () => {
    const h = await makeHarness();
    const before = await h.repo.listUsersBySource(ORG_ID, "email-routing");
    const res = await sync(h, h.adminId, [addr("account"), { address: "not-an-email", enabled: true }]);
    expect(res.status).toBe(400);
    const after = await h.repo.listUsersBySource(ORG_ID, "email-routing");
    expect(after.length).toBe(before.length); // no partial upsert
  });

  it("is idempotent across identical re-runs", async () => {
    const h = await makeHarness();
    await sync(h, h.adminId, [addr("account"), addr("takataro")]);
    const again = await sync(h, h.adminId, [addr("account"), addr("takataro")]);
    const body = (await again.json()) as { added: number; updated: number; deactivated: number };
    expect(body).toMatchObject({ added: 0, updated: 2, deactivated: 0 });
  });

  it("never auto-disables an org-wide identity:admin holder when their address disappears", async () => {
    const h = await makeHarness();
    // adopt the admin's address into Email Routing, then drop it on the next sync.
    await sync(h, h.adminId, [{ address: "admin@devhub.jp", enabled: true }]);
    expect((await h.repo.getUser(h.adminId))!.source).toBe("email-routing");
    const dropped = await sync(h, h.adminId, [addr("someone-else")]);
    expect((await dropped.json())).toMatchObject({ deactivated: 0 });
    expect((await h.repo.getUser(h.adminId))!.status).toBe("active"); // admin stays active
  });

  it("de-duplicates addresses within a single request", async () => {
    const h = await makeHarness();
    const res = await sync(h, h.adminId, [addr("account"), addr("ACCOUNT")]);
    const body = (await res.json()) as { added: number; total: number };
    expect(body).toMatchObject({ added: 1, total: 1 });
  });
});
